import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readMainDbPageSize, readWalSnapshot, walStillCurrent } from '../src/wispr/wal';
import { openWisprDatabase } from '../src/wispr/db';
import { NodeReadOnlyVFS } from '../src/wispr/vfs';

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

/**
 * Runs SQL against `dbPath` and SIGKILLs sqlite3 once it acknowledges, so
 * the committed frames stay in the -wal. Same technique, and the same
 * reasons, as scripts/make-fixture.mjs: `wal_autocheckpoint=0` stops a
 * commit from folding itself back into the main file, and a clean exit
 * would checkpoint on closing the last connection. stdin is left open so
 * the CLI never reaches end-of-input and exits on its own.
 */
function sqliteLeavingWal(dbPath: string, sql: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('sqlite3', [dbPath]);
    let stdout = '';
    let killed = false;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!killed && stdout.includes('READY')) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', reject);
    child.on('exit', () =>
      killed ? resolvePromise() : reject(new Error(`sqlite3 exited early: ${stdout}`))
    );
    child.stdin.write(`PRAGMA wal_autocheckpoint=0;\n${sql}\nSELECT 'READY';\n`);
  });
}

/** A database whose -wal holds TWO separate committed transactions, so the
 *  "stop at the last commit" rule has something to stop *at* — the shared
 *  fixture has a single commit, where any tear wipes out everything and the
 *  rule is untestable. */
async function twoCommitDatabase(dir: string): Promise<string> {
  const db = join(dir, 'two-commits.sqlite');
  execFileSync('sqlite3', [db], {
    input: 'PRAGMA journal_mode=WAL;\nCREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n',
  });
  await sqliteLeavingWal(
    db,
    "BEGIN;INSERT INTO t VALUES (1,'first');COMMIT;\nBEGIN;INSERT INTO t VALUES (2,'second');COMMIT;"
  );
  return db;
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

  it('drops a torn tail but keeps the commit before it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const db = await twoCommitDatabase(dir);
      const wal = `${db}-wal`;
      const whole = withWalFd(wal, (fd) => readWalSnapshot(fs, fd, null))!;
      expect(whole.frames).toBeGreaterThanOrEqual(2);

      // Corrupt the payload of the LAST frame: its checksum stops matching,
      // so recovery must stop before it and fall back to the previous
      // commit. A reader that trusted the frame header alone would hand
      // SQLite a torn page.
      const bytes = readFileSync(wal);
      bytes[bytes.byteLength - 1] ^= 0xff;
      writeFileSync(wal, bytes);

      const torn = withWalFd(wal, (fd) => readWalSnapshot(fs, fd, null));
      expect(torn).not.toBeNull();
      expect(torn!.frames).toBeLessThan(whole.frames);

      // The rule that matters, end to end: the first transaction survives,
      // the torn one is invisible. Committed data is never lost to a torn
      // tail, and uncommitted data is never exposed by one.
      const handle = await openWisprDatabase(db);
      try {
        expect(await handle.all('SELECT id FROM t ORDER BY id')).toEqual([[1]]);
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a transaction whose frames are present but uncommitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const db = await twoCommitDatabase(dir);
      const wal = `${db}-wal`;
      const whole = withWalFd(wal, (fd) => readWalSnapshot(fs, fd, null))!;

      // Truncate the final frame away entirely, mid-write, which is what a
      // crash during Wispr Flow's next transaction would leave behind. The
      // remaining bytes are all individually valid — only the commit marker
      // is gone — so this exercises the commit rule rather than the
      // checksum check that the torn-tail case above covers.
      const frameSize = 24 + whole.pageSize;
      truncateSync(wal, statSync(wal).size - Math.floor(frameSize / 2));

      const handle = await openWisprDatabase(db);
      try {
        expect(await handle.all('SELECT id FROM t ORDER BY id')).toEqual([[1]]);
        expect(handle.walFrames).toBeLessThan(whole.frames);
      } finally {
        await handle.close();
      }
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

describe('walStillCurrent', () => {
  it('accepts an unmodified WAL', () => {
    const snapshot = withWalFd(WAL, (fd) => readWalSnapshot(fs, fd, null))!;
    expect(withWalFd(WAL, (fd) => walStillCurrent(fs, fd, WAL, snapshot))).toBe(true);
  });

  it('rejects a WAL that was restarted in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const copy = join(dir, 'restarted.sqlite-wal');
      writeFileSync(copy, readFileSync(WAL));
      const snapshot = withWalFd(copy, (fd) => readWalSnapshot(fs, fd, null))!;
      const bytes = readFileSync(copy);
      bytes[16] ^= 0xff; // a checkpoint restart rewrites salt-1
      writeFileSync(copy, bytes);
      expect(withWalFd(copy, (fd) => walStillCurrent(fs, fd, copy, snapshot))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a WAL that was deleted, or replaced by a new file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const copy = join(dir, 'replaced.sqlite-wal');
      writeFileSync(copy, readFileSync(WAL));
      // Hold the descriptor open across the deletion, exactly as a live
      // handle would: the unlinked inode stays readable and its salts stay
      // frozen, so a salts-only check would keep saying "unchanged".
      const fd = openSync(copy, 'r');
      try {
        const snapshot = readWalSnapshot(fs, fd, null)!;
        expect(walStillCurrent(fs, fd, copy, snapshot)).toBe(true);

        rmSync(copy);
        expect(walStillCurrent(fs, fd, copy, snapshot)).toBe(false);

        // Recreated at the same path with identical bytes: same salts, new
        // inode. Only the identity check can tell these apart.
        writeFileSync(copy, readFileSync(WAL));
        expect(walStillCurrent(fs, fd, copy, snapshot)).toBe(false);
      } finally {
        closeSync(fd);
      }
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

  it('fails the query, rather than returning rows, when the WAL is restarted mid-read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const db = await twoCommitDatabase(dir);
      const wal = `${db}-wal`;
      const handle = await openWisprDatabase(db);
      try {
        expect(await handle.all('SELECT id FROM t ORDER BY id')).toEqual([[1], [2]]);

        // Simulate the one case that could otherwise return silently wrong
        // rows: a checkpoint restarts the WAL, rewriting it in place under
        // new salts, so the snapshot's byte offsets now address unrelated
        // frames. Rewriting the header salts is exactly what that does.
        const bytes = readFileSync(wal);
        bytes[16] ^= 0xff;
        writeFileSync(wal, bytes);

        await expect(handle.all('SELECT id FROM t ORDER BY id')).rejects.toThrow(
          /replaced its write-ahead log/i
        );
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the query when the WAL is deleted and recreated mid-read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wispr-wal-'));
    try {
      const db = await twoCommitDatabase(dir);
      const wal = `${db}-wal`;
      const original = readFileSync(wal);
      const handle = await openWisprDatabase(db);
      try {
        expect(await handle.all('SELECT id FROM t ORDER BY id')).toEqual([[1], [2]]);

        // Wispr Flow quitting checkpoints and deletes the WAL; relaunching
        // creates a new one at the same path. Our descriptor still reads the
        // unlinked inode, whose salts are frozen, so a salts-only check would
        // happily go on serving pages from a file the database has abandoned.
        rmSync(wal);
        writeFileSync(wal, original);

        await expect(handle.all('SELECT id FROM t ORDER BY id')).rejects.toThrow(
          /replaced its write-ahead log/i
        );
      } finally {
        await handle.close();
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

describe('xRead honours the logical EOF that xFileSize advertises', () => {
  // SQLite should never ask for a page past the size we report, so this
  // cannot be reached through a query — it is asserted against the VFS
  // directly. The case it guards: a commit that SHRINKS the database leaves
  // frames for pages above the new size still in the WAL from earlier
  // transactions, and serving those would contradict xFileSize.
  it('short-reads past dbSizePages instead of serving stale higher pages', () => {
    const vfs = new NodeReadOnlyVFS('test-eof', fs);
    const walFd = openSync(WAL, 'r');
    try {
      const real = readWalSnapshot(fs, walFd, null)!;
      // Pretend the last commit shrank the database to a single page, while
      // the page map still holds everything the WAL ever wrote.
      const shrunk = { ...real, dbSizePages: 1 };
      const visibleSize = shrunk.pageSize;

      const owner = vfs.beginOpen({ dbPath: WAL, walFd, snapshot: shrunk });
      const flags = new DataView(new ArrayBuffer(4));
      expect(vfs.xOpen(WAL, 1, 0, flags)).toBe(0);
      vfs.endOpen();
      try {
        const size = new DataView(new ArrayBuffer(8));
        expect(vfs.xFileSize(1, size)).toBe(0);
        expect(Number(size.getBigInt64(0, true))).toBe(visibleSize);

        // Entirely past the logical end: nothing may be returned, and the
        // buffer must come back zeroed rather than carrying WAL bytes.
        const past = new Uint8Array(64).fill(0xab);
        const rc = vfs.xRead(1, past, visibleSize);
        expect(rc).not.toBe(0); // SQLITE_IOERR_SHORT_READ, not OK
        expect([...past].every((b) => b === 0)).toBe(true);

        // Straddling the boundary: the part below the limit is served, the
        // remainder is zero-filled.
        const straddle = new Uint8Array(32).fill(0xab);
        expect(vfs.xRead(1, straddle, visibleSize - 16)).not.toBe(0);
        expect([...straddle.subarray(16)].every((b) => b === 0)).toBe(true);
      } finally {
        vfs.xClose(1);
        vfs.forgetOwner(owner);
      }
    } finally {
      closeSync(walFd);
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
