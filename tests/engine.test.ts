import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openWisprDatabase } from '../src/wispr/db';
import type { WisprDb } from '../src/wispr/db';
import { REQUIRED_COLUMNS } from '../src/wispr/repository';
import { syncMeetings, withRetry, type VaultAdapter } from '../src/sync/engine';
import { sanitizeFilename } from '../src/render/paths';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { MeetingRow } from '../src/types';

const DB = resolve('tests/fixtures/wispr-fixture.sqlite');

function fakeVault() {
  const files = new Map<string, string>();
  // Keyed on `${wispr_id}:${type}` — a note and its transcript share the
  // same wispr_id and differ only by the `type:` frontmatter field, so the
  // test double must key on both, exactly like the real adapter must.
  const byId = new Map<string, string>();
  const adapter: VaultAdapter = {
    findByWisprId: (id, type) => byId.get(`${id}:${type}`) ?? null,
    write: async (path, content) => {
      files.set(path, content);
      const idMatch = content.match(/^wispr_id: (.+)$/m);
      const typeMatch = content.match(/^type: (.+)$/m);
      if (idMatch && typeMatch) {
        byId.set(`${idMatch[1].trim()}:${typeMatch[1].trim()}`, path);
      }
    },
  };
  return { adapter, files, byId };
}

const deps = (vault: VaultAdapter, over: Partial<typeof DEFAULT_SETTINGS> = {}) => ({
  vault,
  settings: { ...DEFAULT_SETTINGS, ...over },
  databasePath: DB,
  meetingsDir: resolve('tests/fixtures'),
  openDatabase: openWisprDatabase,
});

// --- Synthetic-meeting test support -----------------------------------
// listMeetings/probeSchema's SQL semantics are already exhaustively covered
// by tests/repository.test.ts. For engine-level scenarios that need control
// over specific MeetingRow shapes (long titles, deliberate write failures,
// missing schema columns) that the real fixture database cannot produce
// without touching Task 5's fixture, fake the WisprDb directly instead.

function meeting(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: 'm-synthetic',
    title: 'Synthetic meeting',
    notes: 'Some notes',
    summary: null,
    speakerMap: null,
    createdAt: '2026-08-01 00:00:00.000 +00:00',
    modifiedAt: '2026-08-01 00:00:00.000 +00:00',
    endedAt: null,
    isDeleted: 0,
    finalized: 1,
    ...overrides,
  };
}

function fakeOpenDatabase(
  meetings: MeetingRow[],
  opts: { missingColumns?: string[] } = {}
): () => Promise<WisprDb> {
  return async () => ({
    async all(sql: string): Promise<unknown[][]> {
      if (sql.includes('PRAGMA')) {
        const present = REQUIRED_COLUMNS.filter((c) => !(opts.missingColumns ?? []).includes(c));
        return present.map((c, i) => [i, c]);
      }
      return meetings.map((m) => [
        m.id, m.title, m.notes, m.summary, m.speakerMap,
        m.createdAt, m.modifiedAt, m.endedAt, m.isDeleted, m.finalized,
      ]);
    },
    async close() {},
    stats: { reads: 0, bytes: 0 },
  });
}

describe('sanitizeFilename', () => {
  it('strips characters that are illegal in filenames', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });
  it('collapses whitespace and trims dots', () => {
    expect(sanitizeFilename('  spaced   out.  ')).toBe('spaced out');
  });
  it('falls back for an empty result', () => {
    expect(sanitizeFilename('///')).toBe('Untitled');
  });
  it('truncates very long names', () => {
    expect(sanitizeFilename('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe('withRetry', () => {
  it('returns the value on first success without retrying', async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; return 'ok'; });
    expect([r, calls]).toEqual(['ok', 1]);
  });

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('database disk image is malformed');
      return 'recovered';
    });
    expect([r, calls]).toEqual(['recovered', 3]);
  });

  it('rethrows the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('always broken'); }, 2)
    ).rejects.toThrow('always broken');
    expect(calls).toBe(2);
  });
});

describe('syncMeetings', () => {
  it('reports an error instead of throwing when the database cannot be read', async () => {
    const v = fakeVault();
    const report = await syncMeetings({
      ...deps(v.adapter, { syncTranscripts: false }),
      openDatabase: async () => { throw new Error('disk exploded'); },
    });
    expect(report.written).toBe(0);
    expect(report.errors.join(' ')).toMatch(/disk exploded/);
    expect(v.files.size).toBe(0);
  });

  it('writes one note per finalized, non-deleted meeting', async () => {
    const v = fakeVault();
    const report = await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    expect(report.written).toBe(2);
    expect([...v.files.keys()].every((p) => p.startsWith('Meetings/Wispr/'))).toBe(true);
  });

  it('embeds wispr_id in every note', async () => {
    const v = fakeVault();
    await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    for (const content of v.files.values()) expect(content).toMatch(/^wispr_id: m-000\d$/m);
  });

  it('is idempotent: a second run rewrites the same paths, not new ones', async () => {
    const v = fakeVault();
    await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    const first = [...v.files.keys()].sort();
    await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    expect([...v.files.keys()].sort()).toEqual(first);
  });

  it('reuses the existing path when a note has been moved or renamed', async () => {
    const v = fakeVault();
    v.byId.set('m-0001:note', 'Some/Other/Place/Renamed.md');
    await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    expect(v.files.has('Some/Other/Place/Renamed.md')).toBe(true);
  });

  it('never writes a note for a deleted meeting', async () => {
    const v = fakeVault();
    await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    for (const content of v.files.values()) expect(content).not.toContain('m-0003');
  });

  it('returns a watermark equal to the newest modifiedAt seen', async () => {
    const v = fakeVault();
    const report = await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    expect(report.watermark).toBe('2026-08-05 06:40:00.000 +00:00');
  });

  it('writes nothing when the watermark is already current', async () => {
    const v = fakeVault();
    const first = await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    const second = await syncMeetings(
      deps(v.adapter, { syncTranscripts: false, latestSyncWatermark: first.watermark })
    );
    expect(second.written).toBe(0);
  });

  it('tracks the watermark by instant, not by string ordering', async () => {
    // Two meetings whose string order disagrees with their true chronology.
    const early = meeting({ id: 'm-a', modifiedAt: '2026-08-06 12:00:00.000 +00:00' });
    const late = meeting({ id: 'm-b', modifiedAt: '2026-08-06 08:00:00.000 -05:00' });
    const v = fakeVault();
    const report = await syncMeetings({
      ...deps(v.adapter, { syncTranscripts: false }),
      openDatabase: fakeOpenDatabase([early, late]),
    });
    expect(report.written).toBe(2);
    // 08:00 -05:00 === 13:00Z is the true maximum
    expect(report.watermark).toBe('2026-08-06 08:00:00.000 -05:00');
  });

  it('includes unfinalized meetings when configured', async () => {
    const v = fakeVault();
    const report = await syncMeetings(
      deps(v.adapter, { syncTranscripts: false, includeUnfinalized: true })
    );
    expect(report.written).toBe(3);
  });

  it('converts toggles and resolves speakers in written output', async () => {
    const v = fakeVault();
    await syncMeetings(deps(v.adapter, { syncTranscripts: false }));
    const beta = [...v.files.values()].find((c) => c.includes('m-0002'))!;
    expect(beta).toContain('> [!summary]-');
    expect(beta).not.toContain(':::');
  });

  // --- Fix round 1 regression coverage ---------------------------------

  it('writes a transcript file when transcripts are enabled, and the note links to its actual path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-engine-transcript-'));
    try {
      const meetingId = 'm-t1';
      mkdirSync(join(dir, meetingId), { recursive: true });
      writeFileSync(
        join(dir, meetingId, 'refined.ndjson'),
        [
          JSON.stringify({ timestamp: '00:00', text: 'Hello there', speaker: { id: 0 } }),
          JSON.stringify({ timestamp: '00:05', text: 'General Kenobi', speaker: { id: 1 } }),
        ].join('\n')
      );

      const v = fakeVault();
      const report = await syncMeetings({
        vault: v.adapter,
        settings: { ...DEFAULT_SETTINGS, syncTranscripts: true },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([meeting({ id: meetingId, title: 'Transcript test' })]),
      });

      expect(report.written).toBe(1);
      expect(report.transcripts).toBe(1);
      expect(report.transcriptLinesSkipped).toBe(0);

      const noteEntry = [...v.files.entries()].find(
        ([, c]) => c.includes(`wispr_id: ${meetingId}`) && c.includes('type: note')
      );
      const transcriptEntry = [...v.files.entries()].find(
        ([, c]) => c.includes(`wispr_id: ${meetingId}`) && c.includes('type: transcript')
      );
      expect(noteEntry).toBeDefined();
      expect(transcriptEntry).toBeDefined();

      const [, noteContent] = noteEntry!;
      const [transcriptPath] = transcriptEntry!;
      const linkMatch = noteContent.match(/\[\[(.+)\]\]/);
      expect(linkMatch).not.toBeNull();
      expect(`${linkMatch![1]}.md`).toBe(transcriptPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not advance the watermark when a meeting fails to write (Finding 1 regression guard)', async () => {
    const v = fakeVault();
    const throwingVault: VaultAdapter = {
      findByWisprId: () => null,
      write: async () => { throw new Error('disk full'); },
    };
    const report = await syncMeetings({
      vault: throwingVault,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase([
        meeting({ id: 'm-fail', title: 'Failing meeting' }),
      ]),
    });
    expect(report.watermark).toBeNull();
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('one meeting failing does not prevent the others from being written', async () => {
    const v = fakeVault();
    const meetings = [
      meeting({ id: 'm-a', title: 'A', modifiedAt: '2026-08-01 00:00:00.000 +00:00' }),
      meeting({ id: 'm-b', title: 'B', modifiedAt: '2026-08-02 00:00:00.000 +00:00' }),
    ];
    const failingVault: VaultAdapter = {
      findByWisprId: v.adapter.findByWisprId,
      write: async (path, content) => {
        if (content.includes('wispr_id: m-a')) throw new Error('boom');
        return v.adapter.write(path, content);
      },
    };
    const report = await syncMeetings({
      vault: failingVault,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase(meetings),
    });
    expect(report.written).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.errors.length).toBeGreaterThan(0);
    expect([...v.files.values()].some((c) => c.includes('wispr_id: m-b'))).toBe(true);
  });

  it('reports an error and writes nothing when the schema probe fails', async () => {
    const v = fakeVault();
    const report = await syncMeetings({
      vault: v.adapter,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase([], { missingColumns: ['summary'] }),
    });
    expect(report.written).toBe(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(v.files.size).toBe(0);
  });

  it('a note lookup never resolves to a transcript path', async () => {
    const v = fakeVault();
    v.byId.set('m-0001:transcript', 'Meetings/Wispr/Transcripts/Existing-transcript.md');
    await syncMeetings(deps(v.adapter, { syncTranscripts: false }));

    expect([...v.files.keys()]).not.toContain('Meetings/Wispr/Transcripts/Existing-transcript.md');
    const noteEntry = [...v.files.entries()].find(([, c]) => c.includes('wispr_id: m-0001'));
    expect(noteEntry).toBeDefined();
    expect(noteEntry![1]).toContain('type: note');
  });

  it('a long title keeps its timestamp, and two meetings with the same long title do not collide', async () => {
    const longTitle = 'A'.repeat(130);
    const meetings = [
      meeting({ id: 'm-long-1', title: longTitle, modifiedAt: '2026-08-01 00:00:00.000 +00:00' }),
      meeting({ id: 'm-long-2', title: longTitle, modifiedAt: '2026-08-02 00:00:00.000 +00:00' }),
    ];
    const v = fakeVault();
    const report = await syncMeetings({
      vault: v.adapter,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase(meetings),
    });
    expect(report.written).toBe(2);
    expect(v.files.size).toBe(2);
    // Restored regression guard (fix round 1): composePath now gives the
    // elastic {title} token a length BUDGET instead of truncating the
    // fully-assembled stem, so a long title never crowds out the
    // timestamp — this is the same Stage 1 invariant ("truncate the TITLE
    // only, then append the full stamp") restated for arbitrary token
    // patterns. See src/render/paths.ts's composeStem for the mechanism,
    // and paths.test.ts for pattern-position-independence coverage.
    const paths = [...v.files.keys()];
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((p) => p.startsWith('Meetings/Wispr/'))).toBe(true);
    for (const path of paths) {
      expect(path).toMatch(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
    }
    // The two meetings still don't collide even though the timestamp now
    // always survives: an id-derived discriminator resolves the remaining
    // collision on the (identical) title+timestamp portion.
    expect(paths.some((p) => p.includes('m-long-2'))).toBe(true);
  });

  it('applies the title filter in include mode', async () => {
    const keep = meeting({ id: 'm-keep', title: 'Finance Review' });
    const drop = meeting({ id: 'm-drop', title: 'Legal Review' });
    const v = fakeVault();
    const report = await syncMeetings({
      ...deps(v.adapter, { syncTranscripts: false, titleFilterMode: 'include', titleFilterKeyword: 'finance' }),
      openDatabase: fakeOpenDatabase([keep, drop]),
    });
    expect(report.written).toBe(1);
  });

  it('applies the title filter in exclude mode', async () => {
    const keep = meeting({ id: 'm-keep', title: 'Finance Review' });
    const drop = meeting({ id: 'm-drop', title: 'Standup' });
    const v = fakeVault();
    const report = await syncMeetings({
      ...deps(v.adapter, { syncTranscripts: false, titleFilterMode: 'exclude', titleFilterKeyword: 'standup' }),
      openDatabase: fakeOpenDatabase([keep, drop]),
    });
    expect(report.written).toBe(1);
  });

  it('honours the filename pattern and subfolder settings', async () => {
    const m = meeting({ id: 'm-1', title: 'Weekly Sync', createdAt: '2026-08-06 14:05:09.000 +00:00' });
    const v = fakeVault();
    await syncMeetings({
      ...deps(v.adapter, {
        syncTranscripts: false,
        notesFolder: 'Notes',
        notesSubfolder: 'year-month',
        notesFilenamePattern: '{date} {title}',
      }),
      openDatabase: fakeOpenDatabase([m]),
    });
    expect([...v.files.keys()]).toContain('Notes/2026/08/2026-08-06 Weekly Sync.md');
  });

  // --- Fix round 2 (Finding 7): syncNotes/syncTranscripts counter matrix.
  // The pre-existing "writes no note when syncNotes is false but still
  // writes the transcript" test set BOTH syncNotes and syncTranscripts to
  // false and asserted only written === 0 — it could not observe (and
  // never exercised) the transcript-writing behaviour its own name
  // claimed. Replaced with a helper that gives a meeting real transcript
  // segments, and one test per combination in the 2x2 matrix, each pinning
  // written, transcripts, AND the actual file count/identity.

  function withTranscriptFixture(meetingId: string): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-engine-matrix-'));
    mkdirSync(join(dir, meetingId), { recursive: true });
    writeFileSync(
      join(dir, meetingId, 'refined.ndjson'),
      [
        JSON.stringify({ timestamp: '00:00', text: 'Hello there', speaker: { id: 0 } }),
        JSON.stringify({ timestamp: '00:05', text: 'General Kenobi', speaker: { id: 1 } }),
      ].join('\n')
    );
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('syncNotes: true, syncTranscripts: true -> writes both the note and the transcript', async () => {
    const meetingId = 'm-matrix-both';
    const { dir, cleanup } = withTranscriptFixture(meetingId);
    try {
      const v = fakeVault();
      const report = await syncMeetings({
        vault: v.adapter,
        settings: { ...DEFAULT_SETTINGS, syncNotes: true, syncTranscripts: true },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([meeting({ id: meetingId, title: 'Both on' })]),
      });
      expect(report.written).toBe(1);
      expect(report.transcripts).toBe(1);
      expect(v.files.size).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('syncNotes: false, syncTranscripts: false -> writes nothing', async () => {
    const meetingId = 'm-matrix-neither';
    const { dir, cleanup } = withTranscriptFixture(meetingId);
    try {
      const v = fakeVault();
      const report = await syncMeetings({
        vault: v.adapter,
        settings: { ...DEFAULT_SETTINGS, syncNotes: false, syncTranscripts: false },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([meeting({ id: meetingId, title: 'Both off' })]),
      });
      expect(report.written).toBe(0);
      expect(report.transcripts).toBe(0);
      expect(v.files.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('syncNotes: true, syncTranscripts: false -> writes only the note', async () => {
    const meetingId = 'm-matrix-notes-only';
    const { dir, cleanup } = withTranscriptFixture(meetingId);
    try {
      const v = fakeVault();
      const report = await syncMeetings({
        vault: v.adapter,
        settings: { ...DEFAULT_SETTINGS, syncNotes: true, syncTranscripts: false },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([meeting({ id: meetingId, title: 'Notes only' })]),
      });
      expect(report.written).toBe(1);
      expect(report.transcripts).toBe(0);
      expect(v.files.size).toBe(1);
      const [, content] = [...v.files.entries()][0];
      expect(content).toContain('type: note');
    } finally {
      cleanup();
    }
  });

  it('syncNotes: false, syncTranscripts: true -> writes only the transcript, and written stays 0', async () => {
    const meetingId = 'm-matrix-transcripts-only';
    const { dir, cleanup } = withTranscriptFixture(meetingId);
    try {
      const v = fakeVault();
      const report = await syncMeetings({
        vault: v.adapter,
        settings: { ...DEFAULT_SETTINGS, syncNotes: false, syncTranscripts: true },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([meeting({ id: meetingId, title: 'Transcripts only' })]),
      });
      expect(report.written).toBe(0);
      expect(report.transcripts).toBe(1);
      expect(v.files.size).toBe(1);
      const [, content] = [...v.files.entries()][0];
      expect(content).toContain('type: transcript');
    } finally {
      cleanup();
    }
  });

  it('does not advance the watermark when neither notes nor transcripts are enabled (Finding 3 regression guard)', async () => {
    const v = fakeVault();
    const report = await syncMeetings({
      ...deps(v.adapter, { syncNotes: false, syncTranscripts: false }),
      openDatabase: fakeOpenDatabase([
        meeting({ id: 'm-nowrite', modifiedAt: '2026-08-05 06:40:00.000 +00:00' }),
      ]),
    });
    expect(report.written).toBe(0);
    expect(report.transcripts).toBe(0);
    expect(v.files.size).toBe(0);
    expect(report.watermark).toBeNull();
  });

  it('advances the watermark only past meetings that actually wrote something, not past one that legitimately wrote nothing (Finding 3 regression guard, general rule)', async () => {
    // syncNotes: false, syncTranscripts: true. m-with-transcript has real
    // transcript segments and writes one; m-empty has no transcript
    // fixture directory at all, so readTranscript returns zero segments —
    // with syncNotes off, m-empty legitimately writes NOTHING this run
    // (not an error, not a skip: just an empty transcript). m-empty's
    // modifiedAt is the newest of the two, so if the watermark gate were
    // still "whole run" rather than "per meeting", it would wrongly
    // advance past m-empty even though nothing of m-empty's was synced.
    const dir = mkdtempSync(join(tmpdir(), 'wispr-engine-mixed-'));
    try {
      const withId = 'm-with-transcript';
      mkdirSync(join(dir, withId), { recursive: true });
      writeFileSync(
        join(dir, withId, 'refined.ndjson'),
        [JSON.stringify({ timestamp: '00:00', text: 'Hi', speaker: { id: 0 } })].join('\n')
      );

      const v = fakeVault();
      const report = await syncMeetings({
        vault: v.adapter,
        settings: { ...DEFAULT_SETTINGS, syncNotes: false, syncTranscripts: true },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([
          meeting({ id: withId, title: 'Has transcript', modifiedAt: '2026-08-01 00:00:00.000 +00:00' }),
          meeting({ id: 'm-empty', title: 'No transcript dir', modifiedAt: '2026-08-05 00:00:00.000 +00:00' }),
        ]),
      });

      expect(report.written).toBe(0);
      expect(report.transcripts).toBe(1);
      expect(report.skipped).toBe(0);
      expect(report.errors.length).toBe(0);
      // Watermark reflects ONLY the meeting that actually wrote something —
      // not m-empty's later modifiedAt.
      expect(report.watermark).toBe('2026-08-01 00:00:00.000 +00:00');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a resolved (moved/renamed) transcript path is added to usedPaths, so a fresh path can never collide with it (Finding 4 regression guard)', async () => {
    // Two meetings with the SAME title/createdAt (so a fresh composePath
    // call for the second would land on the exact same path the first
    // meeting's transcript was already resolved to). Ids are chosen so
    // listMeetings' tie-break order (createdAt ASC, id ASC) processes the
    // RESOLVED-path meeting ('m-a') first and the FRESH-compute meeting
    // ('m-b') second — the ordering that actually exercises the fix: if the
    // resolved path is never added to usedPaths, m-b's fresh computation
    // won't see it as taken and will silently overwrite it.
    const dir = mkdtempSync(join(tmpdir(), 'wispr-engine-collision-'));
    try {
      for (const id of ['m-a', 'm-b']) {
        mkdirSync(join(dir, id), { recursive: true });
        writeFileSync(
          join(dir, id, 'refined.ndjson'),
          [JSON.stringify({ timestamp: '00:00', text: 'Hi', speaker: { id: 0 } })].join('\n')
        );
      }

      const v = fakeVault();
      // Pre-seed the vault's index so m-a's transcript resolves to a path
      // that m-b's FRESH composePath call would also compute.
      const collidingPath = 'Meetings/Wispr/Transcripts/Weekly Sync-2026-08-01_00-00-00-transcript.md';
      v.byId.set('m-a:transcript', collidingPath);

      const shared = { title: 'Weekly Sync', createdAt: '2026-08-01 00:00:00.000 +00:00' };
      const report = await syncMeetings({
        vault: v.adapter,
        settings: { ...DEFAULT_SETTINGS, syncNotes: false, syncTranscripts: true },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([
          meeting({ id: 'm-a', ...shared }),
          meeting({ id: 'm-b', ...shared }),
        ]),
      });

      expect(report.transcripts).toBe(2);
      // The resolved path must still hold m-a's content — m-b's colliding
      // fresh computation must have been discriminated away from it, not
      // overwritten it.
      expect(v.files.get(collidingPath)).toContain('wispr_id: m-a');
      // m-b's transcript must exist somewhere else, distinct from m-a's path.
      const mbEntry = [...v.files.entries()].find(([, c]) => c.includes('wispr_id: m-b'));
      expect(mbEntry).toBeDefined();
      expect(mbEntry![0]).not.toBe(collidingPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pre-seeds usedPaths with every resolved path for every selected meeting BEFORE the write loop starts, so an earlier-processed meeting computing a FRESH path can never collide with a later meeting whose path is already resolved (Fix 5 regression guard)', async () => {
    // The shape of the bug: meetings are processed in the order the caller
    // supplies them (createdAt ASC from the real repository). Before this
    // fix, `usedPaths` only ever contained paths resolved SO FAR in the
    // loop. So if the FIRST-processed meeting has no existing note (fresh
    // composePath call) while the SECOND-processed meeting already has one
    // whose resolved path happens to be that exact same fresh path (same
    // title + createdAt, as can happen after a vault reorganization), the
    // first meeting's write lands there un-discriminated — and the second
    // meeting's resolved-path write then silently clobbers it. Content is
    // lost even though both meetings count as `written` in the report.
    //
    // Distinct from the "Finding 4" test above: that one puts the
    // RESOLVED-path meeting first and the FRESH one second — the order the
    // old within-loop `usedPaths.add` already handled correctly. This test
    // uses the OPPOSITE order, which only a pre-seed pass (populating
    // usedPaths for every selected meeting before any write happens) can
    // get right.
    const v = fakeVault();
    const shared = { title: 'Weekly Sync', createdAt: '2026-08-01 00:00:00.000 +00:00' };
    // The exact path a fresh composePath call produces for `shared` under
    // DEFAULT_SETTINGS (notesFolder 'Meetings/Wispr', notesFilenamePattern
    // '{title}-{date}_{time}') — and the path m-late's note is already
    // resolved to, via the vault index, from a previous run.
    const collidingPath = 'Meetings/Wispr/Weekly Sync-2026-08-01_00-00-00.md';
    v.byId.set('m-late:note', collidingPath);

    const report = await syncMeetings({
      vault: v.adapter,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase([
        meeting({ id: 'm-early', ...shared }), // processed FIRST: no resolved path, fresh compose
        meeting({ id: 'm-late', ...shared }), // processed SECOND: resolved via findByWisprId
      ]),
    });

    expect(report.written).toBe(2);
    expect(v.files.size).toBe(2);
    // m-late's resolved path must still hold m-late's content — never
    // overwritten by m-early's fresh write landing there first.
    expect(v.files.get(collidingPath)).toContain('wispr_id: m-late');
    // m-early's write must have been discriminated to a DIFFERENT path,
    // not silently destroyed by m-late's write.
    const earlyEntry = [...v.files.entries()].find(([, c]) => c.includes('wispr_id: m-early'));
    expect(earlyEntry).toBeDefined();
    expect(earlyEntry![0]).not.toBe(collidingPath);
  });

  describe('transcript handling modes', () => {
    function withTranscript(id: string) {
      const dir = mkdtempSync(join(tmpdir(), 'wf-tr-'));
      mkdirSync(join(dir, id));
      writeFileSync(
        join(dir, id, 'refined.ndjson'),
        '{"timestamp":"00:00","text":"First line.","speaker":{"id":1}}\n' +
        '{"timestamp":"00:05","text":"Second line.","speaker":{"id":2}}\n'
      );
      return dir;
    }

    it('custom-location writes a separate transcript in the transcripts folder', async () => {
      const m = meeting({ id: 'm-1', title: 'Sync' });
      const dir = withTranscript('m-1');
      const v = fakeVault();
      const report = await syncMeetings({
        ...deps(v.adapter, { transcriptHandling: 'custom-location', transcriptsFolder: 'T' }),
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([m]),
      });
      expect(report.transcripts).toBe(1);
      expect([...v.files.keys()].some((p) => p.startsWith('T/'))).toBe(true);
      expect([...v.files.keys()].some((p) => p.startsWith('Meetings/Wispr/'))).toBe(true);
    });

    it('same-location writes the transcript beside the note', async () => {
      const m = meeting({ id: 'm-1', title: 'Sync' });
      const dir = withTranscript('m-1');
      const v = fakeVault();
      const report = await syncMeetings({
        ...deps(v.adapter, { transcriptHandling: 'same-location', notesFolder: 'N', transcriptsFolder: 'T' }),
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([m]),
      });
      expect(report.transcripts).toBe(1);
      const paths = [...v.files.keys()];
      expect(paths.every((p) => p.startsWith('N/'))).toBe(true);
      expect(paths.some((p) => p.startsWith('T/'))).toBe(false);
    });

    it('combined appends the transcript into the note and writes no second file', async () => {
      const m = meeting({ id: 'm-1', title: 'Sync' });
      const dir = withTranscript('m-1');
      const v = fakeVault();
      const report = await syncMeetings({
        ...deps(v.adapter, { transcriptHandling: 'combined' }),
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([m]),
      });
      expect(v.files.size).toBe(1);
      expect(report.transcripts).toBe(1);
      const [content] = [...v.files.values()];
      expect(content).toContain('## Transcript');
      expect(content).toContain('**00:00**');
      // exactly one frontmatter block, and it is a note
      expect(content.match(/^---$/gm)?.length).toBe(2);
      expect(content).toContain('type: note');
      expect(content).not.toContain('type: transcript');
    });

    it('combined with syncNotes disabled writes nothing and does not count a transcript (report-integrity fix)', async () => {
      // combined has no standalone transcript file: the note IS the
      // transcript's carrier. With syncNotes off, no note is written, so
      // nothing is persisted at all — report.transcripts must reflect that,
      // not claim a transcript was synced when zero files landed in the
      // vault. (Previously this incremented report.transcripts as soon as
      // the body was rendered, regardless of whether anything was written,
      // which misreported "N note(s), M transcript(s)" to the user.)
      const m = meeting({ id: 'm-1', title: 'Sync' });
      const dir = withTranscript('m-1');
      const v = fakeVault();
      const report = await syncMeetings({
        ...deps(v.adapter, { transcriptHandling: 'combined', syncNotes: false }),
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([m]),
      });
      expect(report.written).toBe(0);
      expect(report.transcripts).toBe(0);
      expect(v.files.size).toBe(0);
    });

    it('combined mode does not emit a transcript wikilink', async () => {
      const m = meeting({ id: 'm-1', title: 'Sync' });
      const dir = withTranscript('m-1');
      const v = fakeVault();
      await syncMeetings({
        ...deps(v.adapter, { transcriptHandling: 'combined' }),
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([m]),
      });
      const [content] = [...v.files.values()];
      expect(content).not.toContain('[[');
    });
  });

  it('logs the filter inputs and the outcome without logging note content', async () => {
    const lines: string[] = [];
    const m = meeting({ id: 'm-1', title: 'Secret Project Kickoff', notes: 'confidential body text' });
    const v = fakeVault();
    await syncMeetings({
      ...deps(v.adapter, { syncTranscripts: false, syncHistoryDays: 7 }),
      openDatabase: fakeOpenDatabase([m]),
      log: (msg) => lines.push(msg),
      nowMs: Date.parse('2026-08-08T00:00:00.000Z'),
    });
    const all = lines.join('\n');
    expect(all).toContain('createdAfter');
    expect(all).toMatch(/written/i);
    expect(all).not.toContain('confidential body text');
    expect(all).not.toContain('Secret Project Kickoff');
  });

  it('does not advance the watermark when transcript lines were skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-bad-'));
    mkdirSync(join(dir, 'm-1'));
    // valid line, then a truncated one
    writeFileSync(
      join(dir, 'm-1', 'refined.ndjson'),
      '{"timestamp":"00:00","text":"Good.","speaker":{"id":1}}\n{"timestamp":"00:05","text":"Trunca'
    );
    const v = fakeVault();
    const report = await syncMeetings({
      ...deps(v.adapter, {}),
      meetingsDir: dir,
      openDatabase: fakeOpenDatabase([meeting({ id: 'm-1' })]),
    });
    expect(report.transcriptLinesSkipped).toBeGreaterThan(0);
    expect(report.watermark).toBeNull();
  });

  // --- Fix round 1 (Finding 2): separate the user-facing (Notice) and
  // log-facing (file-in-vault) error audiences.

  it('keeps the title in the user-facing error but keeps it out of the logged line (Finding 2 fix)', async () => {
    const lines: string[] = [];
    const throwingVault: VaultAdapter = {
      findByWisprId: () => null,
      write: async () => { throw new Error('disk full'); },
    };
    const report = await syncMeetings({
      vault: throwingVault,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase([meeting({ id: 'm-err', title: 'Confidential Budget Review' })]),
      log: (msg) => lines.push(msg),
    });
    // The Notice-facing report keeps the human-readable title.
    expect(report.errors.join(' ')).toContain('Confidential Budget Review');
    // The log-facing lines never do, but still identify the meeting by id.
    const all = lines.join('\n');
    expect(all).not.toContain('Confidential Budget Review');
    expect(all).toContain('m-err');
  });

  it('never logs a lower-layer error message, even one that embeds the failed path/title (Finding 2 + 4 fix)', async () => {
    // A real vault adapter's error can legitimately embed the path it
    // failed to write, and that path can carry the title via the filename
    // pattern (or, per Finding 3, via a custom subfolder pattern). Rather
    // than try to scrub that text (Finding 4: unreliable, since real
    // filenames come from composeStem's budget-based truncation and won't
    // necessarily match any string we could search for), the log must
    // simply never receive the message at all — only the error's kind.
    const lines: string[] = [];
    const throwingVault: VaultAdapter = {
      findByWisprId: () => null,
      write: async (path) => { throw new Error(`Failed to write ${path}`); },
    };
    const report = await syncMeetings({
      vault: throwingVault,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase([meeting({ id: 'm-err2', title: 'Executive Compensation Plan' })]),
      log: (msg) => lines.push(msg),
    });
    expect(report.errors.join(' ')).toContain('Executive Compensation Plan');
    const all = lines.join('\n');
    expect(all).not.toContain('Executive Compensation Plan');
    // Not just the title — the log never contains the message text at all,
    // only the meeting id and the error's constructor name.
    expect(all).not.toContain('Failed to write');
    expect(all).toContain('m-err2');
    expect(all).toContain('Error');
  });

  // --- Fix round 2 -------------------------------------------------------
  // Finding 3: the previous folder-derivation fix was itself unsafe — a
  // user's OWN customSubfolder pattern can reference {title}, so the title
  // can land upstream of the filename, in a segment folderOf() called
  // "safe". Finding 4: title-substring scrubbing can't be made reliable
  // against composeStem's budget-truncated output. Both are fixed the same
  // way: stop deriving anything loggable from a composed (content-derived)
  // path at all. Per-meeting write/error lines now carry only the meeting
  // id (see the tests above and below); settings are logged once, in their
  // authored (pre-expansion) form, at the top of the run.

  it('logs no fragment of the title even when the CUSTOM SUBFOLDER pattern is {title} (Finding 3 regression guard)', async () => {
    const lines: string[] = [];
    const m = meeting({ id: 'm-custom-sub', title: 'Secret Project Kickoff' });
    const v = fakeVault();
    await syncMeetings({
      ...deps(v.adapter, {
        syncTranscripts: false,
        notesSubfolder: 'custom',
        notesCustomSubfolder: '{title}',
      }),
      openDatabase: fakeOpenDatabase([m]),
      log: (msg) => lines.push(msg),
    });
    // Sanity: the vault really did get a title-derived subfolder, proving
    // this test exercises the exact path the finding describes.
    const [writtenPath] = [...v.files.keys()];
    expect(writtenPath).toContain('Secret Project Kickoff');

    const all = lines.join('\n');
    expect(all).not.toContain('Secret Project Kickoff');
    expect(all).not.toContain('Secret');
    expect(all).not.toContain('Kickoff');
    expect(all).toContain('m-custom-sub');
  });

  it('a throwing log sink does not break the sync (engine wraps its own sink)', async () => {
    const m = meeting({ id: 'm-throwing-log', title: 'Anything' });
    const v = fakeVault();
    const report = await syncMeetings({
      ...deps(v.adapter, { syncTranscripts: false }),
      openDatabase: fakeOpenDatabase([m]),
      log: () => { throw new Error('log sink exploded'); },
    });
    expect(report.written).toBe(1);
    expect(report.errors).toEqual([]);
    expect(v.files.size).toBe(1);
  });

  it('one meeting with skipped transcript lines does not block the watermark for the others, and does not itself contribute (Finding 5 fix)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-per-meeting-skip-'));
    try {
      // m-clean: fully valid transcript, older modifiedAt.
      mkdirSync(join(dir, 'm-clean'));
      writeFileSync(
        join(dir, 'm-clean', 'refined.ndjson'),
        '{"timestamp":"00:00","text":"Fine.","speaker":{"id":1}}\n'
      );
      // m-bad: valid line then a truncated one, newer modifiedAt — if the
      // gate were still global, this meeting's later timestamp would have
      // to be excluded via a null watermark; if it were ignored entirely,
      // the watermark would wrongly advance past m-bad.
      mkdirSync(join(dir, 'm-bad'));
      writeFileSync(
        join(dir, 'm-bad', 'refined.ndjson'),
        '{"timestamp":"00:00","text":"Good.","speaker":{"id":1}}\n{"timestamp":"00:05","text":"Trunca'
      );

      const v = fakeVault();
      const report = await syncMeetings({
        ...deps(v.adapter, {}),
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([
          meeting({ id: 'm-clean', modifiedAt: '2026-08-01 00:00:00.000 +00:00' }),
          meeting({ id: 'm-bad', modifiedAt: '2026-08-05 00:00:00.000 +00:00' }),
        ]),
      });

      expect(report.skipped).toBe(0);
      expect(report.errors.length).toBe(0);
      expect(report.transcriptLinesSkipped).toBeGreaterThan(0);
      // The run is otherwise clean, so the watermark is NOT null overall —
      // but it must reflect only m-clean's modifiedAt, never m-bad's later
      // one, proving m-bad did not contribute despite writing successfully.
      expect(report.watermark).toBe('2026-08-01 00:00:00.000 +00:00');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Fix round 3 (Fix 3): errorDetails/failedMeetingTitles give callers
  // a content-free surface (errorDetails, for console.error) alongside the
  // existing human-facing one (errors), plus titles for a completion Notice
  // to name failures by (failedMeetingTitles) without parsing `errors`.

  it('populates errorDetails with only id/kind/errorKind — never a title or message — for a note write failure', async () => {
    const throwingVault: VaultAdapter = {
      findByWisprId: () => null,
      write: async () => { throw new TypeError('some very specific disk message'); },
    };
    const report = await syncMeetings({
      vault: throwingVault,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase([meeting({ id: 'm-detail-note', title: 'Confidential Plan' })]),
    });
    expect(report.errorDetails).toEqual([{ id: 'm-detail-note', kind: 'note', errorKind: 'TypeError' }]);
    expect(report.failedMeetingTitles).toEqual(['Confidential Plan']);
    // Sanity: the human-facing array DOES still carry the title/message —
    // errorDetails is a content-free ADDITION, not a replacement.
    expect(report.errors.join(' ')).toContain('Confidential Plan');
    expect(report.errors.join(' ')).toContain('some very specific disk message');
  });

  it('populates errorDetails with kind "transcript" for a transcript write failure, distinct from a note failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-errdetail-transcript-'));
    try {
      mkdirSync(join(dir, 'm-detail-tr'));
      writeFileSync(
        join(dir, 'm-detail-tr', 'refined.ndjson'),
        '{"timestamp":"00:00","text":"Hi","speaker":{"id":1}}\n'
      );
      const throwingTranscriptVault: VaultAdapter = {
        findByWisprId: () => null,
        write: async (_path, content) => {
          if (content.includes('type: transcript')) throw new RangeError('boom');
        },
      };
      const report = await syncMeetings({
        vault: throwingTranscriptVault,
        settings: { ...DEFAULT_SETTINGS, syncNotes: false, syncTranscripts: true },
        databasePath: DB,
        meetingsDir: dir,
        openDatabase: fakeOpenDatabase([meeting({ id: 'm-detail-tr', title: 'Secret Standup' })]),
      });
      expect(report.errorDetails).toEqual([
        { id: 'm-detail-tr', kind: 'transcript', errorKind: 'RangeError' },
      ]);
      expect(report.failedMeetingTitles).toEqual(['Secret Standup']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accumulates one failedMeetingTitles/errorDetails entry per failing meeting, in order, across multiple failures', async () => {
    const meetings = [
      meeting({ id: 'm-x', title: 'X', modifiedAt: '2026-08-01 00:00:00.000 +00:00' }),
      meeting({ id: 'm-y', title: 'Y', modifiedAt: '2026-08-02 00:00:00.000 +00:00' }),
    ];
    const throwingVault: VaultAdapter = {
      findByWisprId: () => null,
      write: async () => { throw new Error('boom'); },
    };
    const report = await syncMeetings({
      vault: throwingVault,
      settings: { ...DEFAULT_SETTINGS, syncTranscripts: false },
      databasePath: DB,
      meetingsDir: resolve('tests/fixtures'),
      openDatabase: fakeOpenDatabase(meetings),
    });
    expect(report.failedMeetingTitles).toEqual(['X', 'Y']);
    expect(report.errorDetails.map((d) => d.id)).toEqual(['m-x', 'm-y']);
  });

  it('gives two meetings whose titles differ only in case each their own file, losing neither (case-insensitive filesystem collision)', async () => {
    const v = fakeVault();
    const meetings = [
      meeting({ id: 'm-case-a', title: 'Standup', modifiedAt: '2026-08-01 00:00:00.000 +00:00' }),
      meeting({ id: 'm-case-b', title: 'standup', modifiedAt: '2026-08-02 00:00:00.000 +00:00' }),
    ];
    const report = await syncMeetings({
      ...deps(v.adapter, { syncTranscripts: false }),
      openDatabase: fakeOpenDatabase(meetings),
    });
    expect(report.written).toBe(2);
    expect(report.errors).toEqual([]);

    // Two distinct paths were actually written this run.
    expect(v.files.size).toBe(2);
    const paths = [...v.files.keys()];
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(2);

    const entryA = [...v.files.entries()].find(([, c]) => c.includes('wispr_id: m-case-a'));
    const entryB = [...v.files.entries()].find(([, c]) => c.includes('wispr_id: m-case-b'));
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    // Neither meeting's content was clobbered by the other's write: each
    // file still carries its OWN wispr_id, and the two ids differ.
    expect(entryA![1]).not.toBe(entryB![1]);
    expect(entryA![1]).toMatch(/^wispr_id: m-case-a$/m);
    expect(entryB![1]).toMatch(/^wispr_id: m-case-b$/m);
  });
});
