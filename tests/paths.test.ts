import { describe, it, expect } from 'vitest';
import { sanitizeFilename, expandTokens, subfolderFor, composePath, pathKey } from '../src/render/paths';
import type { MeetingRow } from '../src/types';

const M: MeetingRow = {
  id: 'abcdef12-3456-7890-abcd-ef1234567890',
  title: 'Weekly Sync',
  notes: 'x', summary: null, speakerMap: null,
  createdAt: '2026-08-06 14:05:09.000 +00:00',
  modifiedAt: '2026-08-06 14:30:00.000 +00:00',
  endedAt: null, isDeleted: 0, finalized: 1,
};

describe('sanitizeFilename', () => {
  it('replaces characters illegal in filenames', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });
  it('collapses whitespace and trims dots and dashes', () => {
    expect(sanitizeFilename('  spaced   out.  ')).toBe('spaced out');
  });
  it('strips control characters', () => {
    expect(sanitizeFilename(`tab\there`)).toBe('tab here');
    expect(sanitizeFilename('nul' + String.fromCharCode(0) + 'byte')).toBe('nulbyte');
  });
  it('converts newlines and carriage returns to spaces (matching yamlScalar)', () => {
    expect(sanitizeFilename('nl\nx')).toBe('nl x');
    expect(sanitizeFilename('cr\rx')).toBe('cr x');
    expect(sanitizeFilename('crlf\r\nx')).toBe('crlf x');
  });
  it('removes unprintable control characters entirely', () => {
    expect(sanitizeFilename('bel' + String.fromCharCode(7) + 'byte')).toBe('belbyte');
  });
  it('converts vertical tab and form feed to spaces (matching yamlScalar)', () => {
    expect(sanitizeFilename('A\x0BB\x0CC')).toBe('A B C');
  });
  it('falls back for an empty result', () => {
    expect(sanitizeFilename('///')).toBe('Untitled');
    expect(sanitizeFilename('')).toBe('Untitled');
  });
  it('truncates long names without splitting a surrogate pair', () => {
    const emoji = '😀'.repeat(80); // 160 UTF-16 code units
    const out = sanitizeFilename(emoji);
    expect(out.length).toBeLessThanOrEqual(120);
    // a split surrogate would make this fail: check for lone surrogates
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});

describe('expandTokens', () => {
  it('expands every documented token', () => {
    expect(expandTokens('{title}', M)).toBe('Weekly Sync');
    expect(expandTokens('{date}', M)).toBe('2026-08-06');
    expect(expandTokens('{time}', M)).toBe('14-05-09');
    expect(expandTokens('{year}', M)).toBe('2026');
    expect(expandTokens('{month}', M)).toBe('08');
    expect(expandTokens('{day}', M)).toBe('06');
    expect(expandTokens('{quarter}', M)).toBe('Q3');
  });
  it('expands several tokens in one pattern', () => {
    expect(expandTokens('{year}-{month} {title}', M)).toBe('2026-08 Weekly Sync');
  });
  it('leaves unknown tokens untouched', () => {
    expect(expandTokens('{nope}-{title}', M)).toBe('{nope}-Weekly Sync');
  });
  it('sanitises the title so a token cannot inject a path separator', () => {
    expect(expandTokens('{title}', { ...M, title: 'a/b' })).toBe('a-b');
  });
  it('falls back when createdAt is unparseable', () => {
    const bad = { ...M, createdAt: null };
    expect(expandTokens('{date}', bad)).toBe('unknown-date');
    expect(expandTokens('{quarter}', bad)).toBe('unknown-quarter');
  });
  it('falls back to Untitled meeting for an empty title', () => {
    expect(expandTokens('{title}', { ...M, title: '' })).toBe('Untitled meeting');
    expect(expandTokens('{title}', { ...M, title: null })).toBe('Untitled meeting');
  });
});

describe('subfolderFor', () => {
  it('returns empty for none', () => {
    expect(subfolderFor('none', '', M)).toBe('');
  });
  it('formats each built-in pattern', () => {
    expect(subfolderFor('day', '', M)).toBe('2026-08-06');
    expect(subfolderFor('month', '', M)).toBe('2026-08');
    expect(subfolderFor('year-month', '', M)).toBe('2026/08');
    expect(subfolderFor('year-quarter', '', M)).toBe('2026/Q3');
  });
  it('expands a custom pattern', () => {
    expect(subfolderFor('custom', '{year}/{quarter}/{month}', M)).toBe('2026/Q3/08');
  });
  it('returns empty for a custom pattern that is blank', () => {
    expect(subfolderFor('custom', '   ', M)).toBe('');
  });
  it('sanitises each custom path segment but keeps the separators', () => {
    expect(subfolderFor('custom', 'a:b/c*d', M)).toBe('a-b/c-d');
  });
  it('drops empty segments from custom patterns without creating Untitled dirs', () => {
    expect(subfolderFor('custom', '../../evil', M)).toBe('evil');
    expect(subfolderFor('custom', 'a//b', M)).toBe('a/b');
    expect(subfolderFor('custom', '...', M)).toBe('');
  });
});

describe('composePath', () => {
  const base = {
    baseFolder: 'Meetings/Wispr',
    subfolder: 'none' as const,
    customSubfolder: '',
    filenamePattern: '{title}-{date}_{time}',
    meeting: M,
  };

  it('composes folder, subfolder and filename', () => {
    const p = composePath({ ...base, used: new Set() });
    expect(p).toBe('Meetings/Wispr/Weekly Sync-2026-08-06_14-05-09.md');
  });

  it('inserts the subfolder when one is configured', () => {
    const p = composePath({ ...base, subfolder: 'year-month', used: new Set() });
    expect(p).toBe('Meetings/Wispr/2026/08/Weekly Sync-2026-08-06_14-05-09.md');
  });

  it('appends a discriminator when the same path is already used this run', () => {
    const used = new Set<string>();
    const first = composePath({ ...base, used });
    const second = composePath({ ...base, used });
    expect(second).not.toBe(first);
    expect(second).toContain('abcdef12');
    expect(second.endsWith('.md')).toBe(true);
  });

  it('records each produced path in the used set (as its normalised pathKey, since that is what the set now holds)', () => {
    const used = new Set<string>();
    const p = composePath({ ...base, used });
    expect(used.has(pathKey(p))).toBe(true);
  });

  it('tolerates a base folder with leading or trailing slashes', () => {
    const p = composePath({ ...base, baseFolder: '/Meetings/Wispr/', used: new Set() });
    expect(p).toBe('Meetings/Wispr/Weekly Sync-2026-08-06_14-05-09.md');
  });

  it('falls back to a safe filename when the pattern expands to nothing', () => {
    const p = composePath({ ...base, filenamePattern: '   ', used: new Set() });
    expect(p).toBe('Meetings/Wispr/Untitled.md');
  });

  it('never lets a title inject an extra directory level', () => {
    const p = composePath({ ...base, meeting: { ...M, title: 'a/b/c' }, used: new Set() });
    const segments = p.split('/');
    // Meetings, Wispr, filename. The title's slashes became dashes, so the
    // title contributes exactly ONE segment however many separators it held.
    expect(segments).toHaveLength(3);
    expect(segments[2]).toContain('a-b-c');
    expect(p).not.toContain('a/b/c');
  });

  it('drops empty segments from custom subfolder without creating Untitled dirs', () => {
    const p = composePath({ ...base, subfolder: 'custom', customSubfolder: '../../evil', used: new Set() });
    const segments = p.split('/');
    expect(segments).not.toContain('Untitled');
    expect(segments).toContain('evil');
    expect(p).not.toContain('..');
  });

  it('collapses doubled slashes in custom subfolder', () => {
    const p = composePath({ ...base, subfolder: 'custom', customSubfolder: 'a//b', used: new Set() });
    expect(p).toBe('Meetings/Wispr/a/b/Weekly Sync-2026-08-06_14-05-09.md');
  });

  it('drops empty baseFolder segments without creating Untitled dirs', () => {
    const p = composePath({ ...base, baseFolder: '/Meetings//Wispr/', used: new Set() });
    expect(p).toBe('Meetings/Wispr/Weekly Sync-2026-08-06_14-05-09.md');
  });

  it('handles multiple collisions by extending discriminator progressively', () => {
    const used = new Set<string>();
    // Three meetings with the same title, timestamp, and id prefix (simulated by
    // setting their IDs to start with the same 8 characters)
    const base1 = { ...base, meeting: { ...M, id: 'abcdef12-1111-1111-1111-111111111111' } };
    const base2 = { ...base, meeting: { ...M, id: 'abcdef12-2222-2222-2222-222222222222' } };
    const base3 = { ...base, meeting: { ...M, id: 'abcdef12-3333-3333-3333-333333333333' } };

    const p1 = composePath({ ...base1, used });
    const p2 = composePath({ ...base2, used });
    const p3 = composePath({ ...base3, used });

    // All three paths should be distinct
    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);
    expect(p1).not.toBe(p3);

    // All three should be recorded in used (as normalised keys)
    expect(used.size).toBe(3);
    expect(used.has(pathKey(p1))).toBe(true);
    expect(used.has(pathKey(p2))).toBe(true);
    expect(used.has(pathKey(p3))).toBe(true);

    // All should end with .md
    expect(p1.endsWith('.md')).toBe(true);
    expect(p2.endsWith('.md')).toBe(true);
    expect(p3.endsWith('.md')).toBe(true);
  });

  // --- Fix round 1 regression coverage: {title} gets a BUDGET, not the
  // assembled stem a post-hoc truncation. Stage 1 fixed exactly this bug
  // ("truncate the TITLE only, then append the full stamp") for the
  // engine's old hardcoded title-then-stamp shape; this restates it for
  // composePath's arbitrary token patterns. -------------------------------

  it('gives a long title a budget instead of truncating the finished stem, so the timestamp always survives', () => {
    const longTitle = 'L'.repeat(127);
    const p = composePath({ ...base, meeting: { ...M, title: longTitle }, used: new Set() });
    expect(p).toContain('2026-08-06');
    expect(p).toContain('14-05-09');
  });

  it('keeps every non-title token in full regardless of where it sits in the pattern (not position-dependent)', () => {
    const longTitle = 'L'.repeat(127);
    const p = composePath({
      ...base,
      filenamePattern: '{date}_{time}-{title}',
      meeting: { ...M, title: longTitle },
      used: new Set(),
    });
    expect(p).toContain('2026-08-06');
    expect(p).toContain('14-05-09');
  });

  it('still avoids collisions for two meetings sharing the same long title', () => {
    const longTitle = 'L'.repeat(127);
    const used = new Set<string>();
    const p1 = composePath({ ...base, meeting: { ...M, id: 'm-long-1', title: longTitle }, used });
    const p2 = composePath({ ...base, meeting: { ...M, id: 'm-long-2', title: longTitle }, used });
    expect(p1).not.toBe(p2);
    expect(used.has(pathKey(p1))).toBe(true);
    expect(used.has(pathKey(p2))).toBe(true);
  });

  it('never splits a surrogate pair when truncating a long, emoji-heavy title to its budget', () => {
    // NOTE (fix round 2, Finding 5): this test originally also asserted
    // that the date/time survived in full. A title made entirely of 4-byte
    // emoji that fills the ~100-unit budget for this pattern occupies
    // ~200 UTF-8 bytes on its own — which, combined with the pattern's
    // literal/date overhead, already exceeds the new 200-byte stem
    // backstop required by Finding 5. That backstop takes precedence over
    // "every non-title token survives" by design ("the length bound
    // wins"), so for a title this heavy the date/time is no longer
    // guaranteed to survive — seeing dedicated coverage of the byte
    // backstop itself (below). What THIS test still guarantees, and is
    // its actual purpose, is that no truncation step — unit-budget or
    // byte-backstop — ever splits a surrogate pair.
    const emoji = '😀'.repeat(60); // 120 UTF-16 code units, well past any budget here
    const p = composePath({ ...base, meeting: { ...M, title: emoji }, used: new Set() });
    expect(hasLoneSurrogate(p)).toBe(false);
  });

  it('agrees with sanitizeFilename/yamlScalar on control characters: NUL deletes, newline becomes a space', () => {
    const p = composePath({ ...base, meeting: { ...M, title: 'Quarterly\x00Planning\nReview' }, used: new Set() });
    expect(p).toContain('QuarterlyPlanning Review');
  });

  // --- Fix round 2 regression coverage --------------------------------
  // Finding 5: the round-1 budget fix removed the only length bound — a
  // pattern where the title cannot absorb the excess (no {title} at all,
  // or {title} repeated) was unbounded. Fixed by (a) dividing the title's
  // budget across every {title} occurrence and (b) a final backstop on the
  // ASSEMBLED stem: <= MAX_SEGMENT code units AND <= 200 UTF-8 bytes,
  // taking precedence over "every non-title token survives" when the two
  // conflict. Finding 6: the budget===1 fallback sliced a code UNIT
  // (`.slice(0, 1)`), emitting a lone high surrogate for an emoji-leading
  // title; fixed by taking the first code POINT instead.

  function utf8Bytes(s: string): number {
    return new TextEncoder().encode(s).length;
  }

  function stemOf(path: string): string {
    const file = path.split('/').pop()!;
    return file.endsWith('.md') ? file.slice(0, -3) : file;
  }

  function hasLoneSurrogate(s: string): boolean {
    return (
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s) ||
      /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)
    );
  }

  it('divides the title budget across repeated {title} occurrences in the normal (ASCII) case, keeping the whole stem within the segment cap', () => {
    const longTitle = 'A'.repeat(200);
    const p = composePath({
      ...base,
      filenamePattern: '{title}-{date}-{title}',
      meeting: { ...M, title: longTitle },
      used: new Set(),
    });
    const stem = stemOf(p);
    expect(stem.length).toBeLessThanOrEqual(120);
    // Non-title token still survives in full: the normal-case invariant
    // (overhead comfortably small) is unaffected by the division.
    expect(p).toContain('2026-08-06');
    // Both {title} occurrences contributed some characters (budget shared,
    // not zeroed out for either occurrence).
    expect((stem.match(/A+/g) ?? []).length).toBe(2);
  });

  it('applies the byte backstop (precedence: length bound wins) for a repeated emoji-heavy title that fits the unit cap but not the byte cap', () => {
    // Matches the coordinator's measured repro: {title}-{date}-{title} with
    // a long emoji title reaches ~228 UTF-16 units of *raw* content across
    // two occurrences before any backstop, and — even after per-occurrence
    // budgeting caps it near 120 units — its UTF-8 byte size (4 bytes per
    // emoji) still exceeds the 200-byte stem budget.
    const emoji = '😀'.repeat(200);
    const p = composePath({
      ...base,
      filenamePattern: '{title}-{date}-{title}',
      meeting: { ...M, title: emoji },
      used: new Set(),
    });
    const stem = stemOf(p);
    expect(stem.length).toBeLessThanOrEqual(120);
    expect(utf8Bytes(stem)).toBeLessThanOrEqual(200);
    expect(hasLoneSurrogate(p)).toBe(false);
  });

  it('applies the backstop even with no {title} token at all, when the literal pattern alone exceeds the segment cap (non-title tokens may be lost by necessity)', () => {
    const p = composePath({
      ...base,
      filenamePattern: 'X'.repeat(150) + '-{date}',
      used: new Set(),
    });
    const stem = stemOf(p);
    expect(stem.length).toBeLessThanOrEqual(120);
    expect(utf8Bytes(stem)).toBeLessThanOrEqual(200);
  });

  it('never emits a lone surrogate when the budget is forced down to 1 by a huge non-title overhead and the title starts with an emoji (Finding 6)', () => {
    // overhead = 119 literal X's -> rawBudget = 120 - 119 = 1 -> budget floored at MIN_TITLE_BUDGET (1).
    const p = composePath({
      ...base,
      filenamePattern: '{title}' + 'X'.repeat(119),
      meeting: { ...M, title: '😀' + 'B'.repeat(50) },
      used: new Set(),
    });
    expect(hasLoneSurrogate(p)).toBe(false);
    const stem = stemOf(p);
    expect(stem.length).toBeLessThanOrEqual(120);
  });

  it('sanitizeFilename and segment sanitization use identical character rules', () => {
    // Test that both functions handle the same transformations identically
    // for non-empty results. This ensures the shared clean() function works.
    // sanitizeFilename('a:b') should be 'a-b', same as what a folder segment would be
    expect(sanitizeFilename('a:b')).toBe('a-b');
    expect(sanitizeFilename('a/b')).toBe('a-b');
    expect(sanitizeFilename('a  b')).toBe('a b');
  });

  // --- Filesystem-collision coverage: macOS/Windows are case-insensitive,
  // and macOS also normalises Unicode in filenames, so two distinct JS
  // strings can be the SAME file on disk. The `used` set must be keyed by
  // `pathKey`, not the literal path, or the second write silently clobbers
  // the first while both are reported as written. -----------------------

  it('gives two meetings whose titles differ only in case distinct paths, keeping the first one\'s original casing', () => {
    const used = new Set<string>();
    const upper = composePath({
      ...base,
      filenamePattern: '{title}',
      meeting: { ...M, id: 'm-upper', title: 'Standup' },
      used,
    });
    const lower = composePath({
      ...base,
      filenamePattern: '{title}',
      meeting: { ...M, id: 'm-lower', title: 'standup' },
      used,
    });
    expect(upper).not.toBe(lower);
    // First one keeps its original casing untouched.
    expect(upper).toBe('Meetings/Wispr/Standup.md');
  });

  it('gives two meetings whose titles differ only in Unicode normalisation distinct paths', () => {
    const nfc = 'café'; // U+00E9 (composed)
    const nfd = 'café'; // e + combining acute accent (decomposed)
    expect(nfc).not.toBe(nfd); // sanity: distinct JS strings, same visible text
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC')); // but one file on macOS

    const used = new Set<string>();
    const p1 = composePath({
      ...base,
      filenamePattern: '{title}',
      meeting: { ...M, id: 'm-nfc', title: nfc },
      used,
    });
    const p2 = composePath({
      ...base,
      filenamePattern: '{title}',
      meeting: { ...M, id: 'm-nfd', title: nfd },
      used,
    });
    expect(p1).not.toBe(p2);
  });

  it('preserves uppercase letters in the returned path (guards against "fixing" this by lowercasing the actual filename)', () => {
    const p = composePath({
      ...base,
      filenamePattern: '{title}',
      meeting: { ...M, title: 'Standup' },
      used: new Set(),
    });
    expect(p).toBe('Meetings/Wispr/Standup.md');
    expect(p).toContain('Standup');
    expect(p).not.toContain('standup');
  });

  it('a pre-seeded used set containing a normalised key of a different case blocks a colliding candidate', () => {
    const used = new Set<string>();
    used.add(pathKey('Meetings/Wispr/Standup.md'));
    const p = composePath({
      ...base,
      filenamePattern: '{title}',
      meeting: { ...M, title: 'standup' },
      used,
    });
    expect(p).not.toBe('Meetings/Wispr/standup.md');
  });
});
