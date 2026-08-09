import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openWisprDatabase } from '../src/wispr/db';

const DB = resolve('tests/fixtures/wispr-fixture.sqlite');

/** Counts this process's open file descriptors via /proc or /dev, when
 *  available, so the fd-leak regression test can compare before/after. */
function countOpenFds(): number | null {
  for (const dir of ['/proc/self/fd', '/dev/fd']) {
    try {
      return readdirSync(dir).length;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

describe('openWisprDatabase', () => {
  it('reads rows from a WAL-mode database opened read-only', async () => {
    const db = await openWisprDatabase(DB);
    const rows = await db.all('SELECT id, title FROM Meetings ORDER BY id');
    await db.close();
    expect(rows.map((r) => r[0])).toEqual(['m-0001', 'm-0002', 'm-0003', 'm-0004']);
  });

  it('reads only a small fraction of the file (lazy paging)', async () => {
    const db = await openWisprDatabase(DB);
    await db.all('SELECT id FROM Meetings WHERE isDeleted = 0');
    const { bytes, reads } = db.stats;
    await db.close();
    const size = statSync(DB).size;
    expect(reads).toBeGreaterThan(0);
    // Must never slurp the whole file the way sql.js does. The fixture
    // includes a multi-MB padding table (History) specifically so this
    // ceiling is load-bearing rather than trivially satisfied by file size.
    expect(bytes).toBeLessThan(512 * 1024);
    expect(bytes).toBeLessThan(size / 4);
    expect(bytes).toBeLessThan(size + 1);
  });

  it('rejects a path that does not exist', async () => {
    await expect(openWisprDatabase('/definitely/not/here.sqlite')).rejects.toThrow();
  });

  it('works when the path is longer than 64 characters', async () => {
    // Regression guard for the mxPathName / Xc gotcha.
    expect(DB.length).toBeGreaterThan(64);
    const db = await openWisprDatabase(DB);
    const rows = await db.all('SELECT count(*) FROM Meetings');
    await db.close();
    expect(Number(rows[0][0])).toBe(4);
  });

  it('does not leak file descriptors across repeated failed opens', async () => {
    const before = countOpenFds();
    if (before === null) return; // no fd introspection available on this platform

    const ATTEMPTS = 5;
    for (let i = 0; i < ATTEMPTS; i++) {
      // tmpdir() exists (so the existsSync guard doesn't short-circuit) but
      // is a directory, not a database: xOpen succeeds (opening a directory
      // works fine on POSIX), then the first xRead fails with EISDIR. Before
      // the fix, that exception escaped xRead uncaught, so SQLite's own
      // engine never got to call xClose and the fd was never released.
      await expect(openWisprDatabase(tmpdir())).rejects.toThrow();
    }

    const after = countOpenFds();
    // Must not grow roughly 1-for-1 with the number of failed attempts.
    expect(after! - before).toBeLessThan(ATTEMPTS);
  });

  it('close() is idempotent', async () => {
    const db = await openWisprDatabase(DB);
    await db.close();
    await db.close(); // must be a harmless no-op, not throw SQLITE_MISUSE
  });

  it('succeeds on a query whose sort spills to disk (temp_store regression)', async () => {
    const db = await openWisprDatabase(DB);
    // History has 8000 rows of 1000-byte blobs (~8 MB); sorting all of it by
    // the blob column with no LIMIT forces a real external sort. Without
    // PRAGMA temp_store=MEMORY, the sorter tries to open a temp file through
    // this read-only VFS, which refuses the temp file's null/empty name and
    // fails the whole query with SQLITE_CANTOPEN (verified by reproducing
    // that exact failure with the pragma temporarily removed).
    const rows = await db.all('SELECT id FROM History ORDER BY payload');
    await db.close();
    expect(rows.length).toBe(8000);
  });

  it('does not misattribute reads across concurrently-open handles (Finding 6 regression)', async () => {
    const a = await openWisprDatabase(DB);
    await a.all('SELECT id FROM Meetings WHERE isDeleted = 0');

    const b = await openWisprDatabase(DB);
    // Opening a handle always costs at least one xRead (the file header),
    // so B's stats are not literally zero the instant it opens — capture
    // that as B's own baseline rather than asserting an unreachable exact
    // zero. What must hold is that B's baseline is unaffected by anything A
    // does, before or after.
    const bBaseline = b.stats;

    // More reads on A while B is still open. Under the pre-fix design
    // (a single global counter on the shared VFS, with each handle's stats
    // computed as a delta against a baseline snapshot taken at *its own*
    // open time), these reads leaked into whichever handle asks for
    // `.stats` next — here, B — even though B issued no queries of its own.
    await a.all('SELECT id FROM History ORDER BY payload');

    // B must be completely unaffected by A's additional reads.
    expect(b.stats).toEqual(bBaseline);

    // Now B does its own work, and only its own reads should show up.
    const bRows = await b.all('SELECT count(*) FROM Meetings');
    expect(Number(bRows[0][0])).toBe(4);
    expect(b.stats.reads).toBeGreaterThan(bBaseline.reads);
    expect(b.stats.bytes).toBeGreaterThan(bBaseline.bytes);
    // And still nowhere near what A's huge sort over History read.
    expect(b.stats.bytes).toBeLessThan(a.stats.bytes);

    await a.close();
    await b.close();
  });

  it('reports independent counts for two sequential handles (not cumulative)', async () => {
    const a = await openWisprDatabase(DB);
    await a.all('SELECT id FROM Meetings WHERE isDeleted = 0');
    const aStats = a.stats;
    await a.close();

    const b = await openWisprDatabase(DB);
    await b.all('SELECT id FROM Meetings WHERE isDeleted = 0');
    const bStats = b.stats;
    await b.close();

    // Same query against the same file from a fresh handle should read
    // about the same amount of data, not an ever-growing cumulative total.
    expect(bStats.reads).toBe(aStats.reads);
    expect(bStats.bytes).toBe(aStats.bytes);
  });

  it('does not cross-attribute reads across truly parallel, unawaited opens (Finding 7 regression)', async () => {
    // Unlike the earlier "concurrently-open" test (which awaits each open in
    // turn, then keeps both alive), this fires both opens without awaiting
    // either first, so their beginOpen()/open_v2()/endOpen() windows would
    // race if the open critical section were not serialized.
    const [a, b] = await Promise.all([openWisprDatabase(DB), openWisprDatabase(DB)]);

    // A freshly opened handle legitimately shows a small nonzero read count
    // already (its own header read during open_v2) — that is correct and
    // is the baseline each handle must not move past from the other's work.
    const aOpenStats = a.stats;
    const bOpenStats = b.stats;
    expect(aOpenStats.reads).toBeGreaterThan(0);
    expect(bOpenStats.reads).toBeGreaterThan(0);

    // Query only A, with a scan large enough that its read count can't be
    // confused with open-time noise.
    await a.all('SELECT id FROM History ORDER BY payload');

    expect(a.stats.reads).toBeGreaterThan(aOpenStats.reads);
    expect(a.stats.bytes).toBeGreaterThan(aOpenStats.bytes);
    // B issued no queries: it must still report only its own open-time read,
    // not any of A's. Under the pre-fix race, B's beginOpen() could overwrite
    // the VFS's "current owner" token while A's open_v2() was still in
    // flight, binding A's fileId to B's owner and inverting these numbers.
    expect(b.stats).toEqual(bOpenStats);
    expect(b.stats.reads).toBeLessThan(a.stats.reads);
    expect(b.stats.bytes).toBeLessThan(a.stats.bytes);

    await a.close();
    await b.close();
  });

  it('does not cross-attribute reads across three parallel opens (Finding 7 regression)', async () => {
    const [a, b, c] = await Promise.all([
      openWisprDatabase(DB),
      openWisprDatabase(DB),
      openWisprDatabase(DB),
    ]);

    const bOpenStats = b.stats;
    const cOpenStats = c.stats;

    await a.all('SELECT id FROM History ORDER BY payload');

    // Neither uninvolved handle should have absorbed any of A's reads.
    expect(b.stats).toEqual(bOpenStats);
    expect(c.stats).toEqual(cOpenStats);
    expect(a.stats.reads).toBeGreaterThan(b.stats.reads);
    expect(a.stats.reads).toBeGreaterThan(c.stats.reads);

    await a.close();
    await b.close();
    await c.close();
  });

  it('two already-open handles can query concurrently without corrupting the shared WASM module (Finding 8 regression)', async () => {
    // This is the exact repro that surfaced Finding 8: no parallel opening
    // involved at all (both handles are already fully open and awaited),
    // just two `all()` calls racing directly against the shared WASM
    // module. Before the fix this threw a raw WASM trap ("table index is
    // out of bounds") from one or both queries, and — worse — left both
    // handles unclosable afterward ("unable to close due to unfinalized
    // statements or unfinished backups"), permanently leaking them.
    const a = await openWisprDatabase(DB);
    const b = await openWisprDatabase(DB);

    const [historyCount, meetingsCount] = await Promise.all([
      a.all('SELECT count(*) FROM History'),
      b.all('SELECT count(*) FROM Meetings'),
    ]);

    expect(Number(historyCount[0][0])).toBe(8000);
    expect(Number(meetingsCount[0][0])).toBe(4);

    // Both handles must still be cleanly closable, not wedged.
    await a.close();
    await b.close();
  });

  it('three already-open handles can query concurrently without corrupting the shared WASM module (Finding 8 regression)', async () => {
    const a = await openWisprDatabase(DB);
    const b = await openWisprDatabase(DB);
    const c = await openWisprDatabase(DB);

    const [historyCount, meetingsCount, deletedCount] = await Promise.all([
      a.all('SELECT count(*) FROM History'),
      b.all('SELECT count(*) FROM Meetings'),
      c.all('SELECT count(*) FROM Meetings WHERE isDeleted = 1'),
    ]);

    expect(Number(historyCount[0][0])).toBe(8000);
    expect(Number(meetingsCount[0][0])).toBe(4);
    expect(Number(deletedCount[0][0])).toBe(1);

    await a.close();
    await b.close();
    await c.close();
  });

  it('a throwing query does not wedge the shared lock for later callers (Finding 8 regression)', async () => {
    const a = await openWisprDatabase(DB);
    const b = await openWisprDatabase(DB);

    // A query against a nonexistent table must reject...
    await expect(a.all('SELECT * FROM no_such_table')).rejects.toThrow();

    // ...but must not wedge the shared lock: a normal query, on a different
    // handle, issued afterward must still succeed. If the lock's release
    // were not failure-agnostic, this would hang or reject too.
    const rows = await b.all('SELECT count(*) FROM Meetings');
    expect(Number(rows[0][0])).toBe(4);

    // The handle that threw must also still be usable afterward.
    const aRows = await a.all('SELECT count(*) FROM Meetings');
    expect(Number(aRows[0][0])).toBe(4);

    await a.close();
    await b.close();
  });
});
