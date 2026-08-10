import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readMainDbPageSize, readWalSnapshot, saltsUnchanged } from '../src/wispr/wal';
import { openWisprDatabase } from '../src/wispr/db';

const DB = resolve('tests/fixtures/wispr-fixture.sqlite');
const WAL = `${DB}-wal`;
const REAL_DB = join(homedir(), 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite');

function withWalFd<T>(path: string, fn: (fd: number) => T): T {
  const fd = openSync(path, 'r');
  try {
    return fn(fd);
  } finally {
    closeSync(fd);
  }
}

describe('the fixture itself', () => {
  // Guards the fixture, not the code. If make-fixture.mjs ever regresses to
  // a checkpointed one-pass build, every WAL test below would keep passing
  // while testing nothing — which is precisely how the original data-loss
  // bug survived a green suite.
  it('keeps its meeting rows in an uncheckpointed -wal, invisible to a main-file-only read', () => {
    expect(existsSync(WAL)).toBe(true);
    const mainOnly = execFileSync('sqlite3', [`file:${DB}?immutable=1`, 'SELECT count(*) FROM Meetings;'])
      .toString()
      .trim();
    const withWal = execFileSync('sqlite3', [`file:${DB}?mode=ro`, 'SELECT count(*) FROM Meetings;'])
      .toString()
      .trim();
    expect(mainOnly).toBe('0');
    expect(withWal).toBe('4');
  });
});

describe('readWalSnapshot', () => {
  it('parses the fixture WAL into a committed page snapshot', () => {
    const snapshot = withWalFd(WAL, (fd) => readWalSnapshot(fs, fd, readMainDbPageSize(fs, DB)));
    expect(snapshot).not.toBeNull();
    expect(snapshot!.frames).toBeGreaterThan(0);
    expect(snapshot!.pages.size).toBeGreaterThan(0);
    expect(snapshot!.dbSizePages).toBeGreaterThan(0);
    // Every recorded offset must land past the WAL header and inside the file.
    const walSize = readFileSync(WAL).byteLength;
    for (const offset of snapshot!.pages.values()) {
      expect(offset).toBeGreaterThanOrEqual(32 + 24);
      expect(offset + snapshot!.pageSize).toBeLessThanOrEqual(walSize);
    }
  });

  it('agrees with the main database file on page size', () => {
    const snapshot = withWalFd(WAL, (fd) => readWalSnapshot(fs, fd, null));
    expect(snapshot!.pageSize).toBe(readMainDbPageSize(fs, DB));
  });

  it('refuses a WAL whose page size disagrees with the database', () => {
    const snapshot = withWalFd(WAL, (fd) => readWalSnapshot(fs, fd, 512));
    expect(snapshot).toBeNull();
  });

  it('refuses a WAL with a corrupt header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const bad = join(dir, 'bad.sqlite-wal');
      const bytes = readFileSync(WAL);
      bytes[0] = 0x00; // break the magic
      writeFileSync(bad, bytes);
      expect(withWalFd(bad, (fd) => readWalSnapshot(fs, fd, null))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at the last valid frame when the tail is torn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const torn = join(dir, 'torn.sqlite-wal');
      const bytes = readFileSync(WAL);
      const whole = withWalFd(WAL, (fd) => readWalSnapshot(fs, fd, null))!;
      // Corrupt the payload of the LAST frame: its checksum no longer
      // matches, so recovery must stop before it. A reader that trusted the
      // frame header alone would hand SQLite a torn page.
      bytes[bytes.byteLength - 1] ^= 0xff;
      writeFileSync(torn, bytes);
      const snapshot = withWalFd(torn, (fd) => readWalSnapshot(fs, fd, null));
      // Either the truncated prefix still ends at an earlier commit (fewer
      // frames), or there is no complete commit left at all.
      if (snapshot) expect(snapshot.frames).toBeLessThan(whole.frames);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a WAL that is absent or too short to hold a frame', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const stub = join(dir, 'stub.sqlite-wal');
      writeFileSync(stub, readFileSync(WAL).subarray(0, 32));
      expect(withWalFd(stub, (fd) => readWalSnapshot(fs, fd, null))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('saltsUnchanged', () => {
  it('accepts an unmodified WAL and rejects one that was restarted', () => {
    const snapshot = withWalFd(WAL, (fd) => readWalSnapshot(fs, fd, null))!;
    expect(withWalFd(WAL, (fd) => saltsUnchanged(fs, fd, snapshot))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const restarted = join(dir, 'restarted.sqlite-wal');
      const bytes = readFileSync(WAL);
      bytes[16] ^= 0xff; // a checkpoint restart rewrites salt-1
      writeFileSync(restarted, bytes);
      expect(withWalFd(restarted, (fd) => saltsUnchanged(fs, fd, snapshot))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openWisprDatabase with a WAL overlay', () => {
  it('reads rows that exist ONLY in the -wal', async () => {
    const db = await openWisprDatabase(DB);
    try {
      const rows = await db.all('SELECT id FROM Meetings ORDER BY id');
      expect(rows.map((r) => r[0])).toEqual(['m-0001', 'm-0002', 'm-0003', 'm-0004']);
      expect(db.walFrames).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('still opens a database whose -wal is missing entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      // Copy the main file only. Its Meetings table is empty (the rows live
      // in the WAL we are deliberately not copying), so this asserts the
      // degraded path opens and queries cleanly rather than what it returns.
      const lone = join(dir, 'lone.sqlite');
      copyFileSync(DB, lone);
      const db = await openWisprDatabase(lone);
      try {
        expect(await db.all('SELECT count(*) FROM Meetings')).toEqual([[0]]);
        expect(db.walFrames).toBeNull();
      } finally {
        await db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the lazy-paging property with an overlay attached', async () => {
    const db = await openWisprDatabase(DB);
    try {
      await db.all('SELECT id FROM Meetings WHERE isDeleted = 0');
      expect(db.stats.bytes).toBeLessThan(512 * 1024);
    } finally {
      await db.close();
    }
  });
});

describe('a real Wispr Flow install', () => {
  // The regression this whole overlay exists for, asserted against live
  // data: on a real install the main file alone answers 0 while the WAL
  // holds every row. Skipped where there is no install (CI, Linux, a fresh
  // machine) rather than asserted vacuously.
  it('returns the same meeting count as a WAL-aware sqlite3 read', async () => {
    if (!existsSync(REAL_DB)) {
      console.info('skipped: no Wispr Flow install at', REAL_DB);
      return;
    }
    const truth = Number(
      execFileSync('sqlite3', [`file:${REAL_DB}?mode=ro`, 'SELECT count(*) FROM Meetings;'])
        .toString()
        .trim()
    );

    const db = await openWisprDatabase(REAL_DB);
    try {
      const rows = await db.all('SELECT count(*) FROM Meetings');
      expect(Number(rows[0][0])).toBe(truth);
    } finally {
      await db.close();
    }
  });
});
