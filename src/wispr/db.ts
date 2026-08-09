// wa-sqlite ships untyped JS sources, but the package's declaration file
// (src/types/index.d.ts) provides ambient module typings for both of these
// deep imports, so no @ts-expect-error is needed (and would be flagged
// unused). It also declares the global ambient `SQLiteAPI` interface used
// below.
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import { NodeReadOnlyVFS, type Fs, type VfsOwner } from './vfs';
import { WASM_BASE64 } from './wasmBinary';
import { requireFs } from '../node-runtime';

export interface WisprDb {
  all(sql: string): Promise<unknown[][]>;
  close(): Promise<void>;
  /** Per-handle page-read accounting. NOTE: no production code consumes this —
   *  it exists so the test suite can prove the lazy-paging property this whole
   *  VFS approach rests on (reading ~52 KB of a 217 MB database). It is kept
   *  deliberately, not by accident. */
  stats: { reads: number; bytes: number };
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

let sqlite3Promise: Promise<SQLiteAPI> | null = null;

/** The WASM module is expensive to instantiate, so build it once per session.
 *  Passing wasmBinary keeps Emscripten from trying to fetch() the .wasm,
 *  which cannot work from inside Obsidian.
 *
 *  `locateFile` below is NOT for locating a file — wasmBinary already
 *  supplies the bytes directly, so the string this returns is never read by
 *  anything. It exists solely to steer wa-sqlite's generated glue code away
 *  from a fatal branch. When no `locateFile` is given, that glue computes
 *  `new URL("wa-sqlite.wasm", import.meta.url).href` UNCONDITIONALLY, before
 *  ever checking wasmBinary — that line lives in the `else` of the
 *  `locateFile` check, not gated on whether a binary was supplied. Our
 *  esbuild config bundles to CommonJS (`format: 'cjs'` — Obsidian requires
 *  it), so esbuild rewrites `import.meta` to a shim whose `.url` is
 *  `undefined`, and `new URL("wa-sqlite.wasm", undefined)` throws
 *  "Invalid URL" — synchronously, during module setup, before any query
 *  ever runs. Supplying `locateFile` takes the `if` branch instead, so that
 *  `new URL` call is never reached. Do not remove this as "redundant with
 *  wasmBinary": it looks redundant in isolation but is the only thing
 *  preventing the built bundle from throwing on every single load. See
 *  tests/bundle.test.ts, which loads the actual built main.js (not the
 *  TypeScript source) specifically to catch a regression here — vitest
 *  running the .ts source directly never exercises this code path, because
 *  `import.meta.url` is a real URL there. */
function getSqlite3(): Promise<SQLiteAPI> {
  sqlite3Promise ??= (async () => {
    const module = await SQLiteESMFactory({
      wasmBinary: base64ToBytes(WASM_BASE64),
      locateFile: () => 'wa-sqlite.wasm',
    });
    return SQLite.Factory(module);
  })();
  return sqlite3Promise;
}

const VFS_NAME = 'wispr-ro';
let vfs: NodeReadOnlyVFS | null = null;

/**
 * wa-sqlite exposes `vfs_register` but no `vfs_unregister`, and the dist
 * keeps every registered VFS forever in a module-level map. Registering a
 * fresh VFS per open (as an earlier version of this file did, to dodge the
 * "already registered" error with a per-call counter suffix) is therefore
 * an unbounded leak in a long-running Obsidian session — roughly 48
 * registrations/day at 30-minute syncs, none of them ever reclaimable.
 * Register exactly one VFS instance for the lifetime of the module and
 * reuse it for every open instead.
 */
function getVfs(sqlite3: SQLiteAPI, fs: Fs): NodeReadOnlyVFS {
  if (!vfs) {
    vfs = new NodeReadOnlyVFS(VFS_NAME, fs);
    sqlite3.vfs_register(vfs, false);
  }
  return vfs;
}

/**
 * THE REAL REASON THIS EXISTS — read before touching it:
 *
 * wa-sqlite compiles every SQLite API call (`open_v2`, `exec`, `close`,
 * everything) as an Asyncify-style async WASM call — `const async = true`
 * in `node_modules/wa-sqlite/src/sqlite-api.js`, unconditionally, not gated
 * by build variant — running against ONE shared WASM module instance for
 * this whole process (see `getSqlite3` above). Emscripten's Asyncify
 * supports only a single in-flight unwind/rewind for that instance at a
 * time. If two calls into it ever overlap — on the SAME db handle or on
 * TWO COMPLETELY DIFFERENT handles, it makes no difference — the shared
 * WASM state gets corrupted.
 *
 * This is not a theoretical concern; it was reproduced directly, twice:
 *  1. (Finding 7) Two parallel, unawaited `openWisprDatabase()` calls cross-
 *     attributed their read stats, because the VFS's single "current owner"
 *     slot (see vfs.ts) got overwritten mid-open.
 *  2. (Finding 8) Two already-open handles calling `all()` at the same time
 *     — no opening involved at all — threw a raw WASM trap ("table index is
 *     out of bounds"), and after that BOTH handles could no longer even be
 *     closed ("unable to close due to unfinalized statements"), permanently
 *     leaking them.
 *
 * So this lock is not "the open lock" protecting one narrow window — it is
 * THE lock for this module's entire interaction with the shared WASM
 * instance. Every entry point that calls into `sqlite3` — the open+setup
 * sequence, `all()`, and `close()` — goes through it, with no exceptions.
 * A future maintainer who sees this and thinks "queries should be
 * concurrent, that's the whole point of async" is wrong for this specific
 * library: there is exactly one WASM module instance backing every open
 * `WisprDb`, and it can only ever do one thing at a time regardless of how
 * many handles are open. Removing or narrowing this lock WILL reintroduce
 * silent data corruption and permanently unclosable (leaked) handles.
 * Performance is not a concern here — the real workload is a handful of
 * small queries — so correctness wins outright over notional parallelism.
 */
let sqliteLock: Promise<void> = Promise.resolve();

function withSqliteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = sqliteLock.then(fn);
  // Always settle (regardless of whether this call succeeded), so a
  // throwing open/query/close releases the lock instead of wedging every
  // later call queued behind it.
  sqliteLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function openWisprDatabase(dbPath: string): Promise<WisprDb> {
  const fs = requireFs();
  if (!fs.existsSync(dbPath)) throw new Error(`Wispr database not found: ${dbPath}`);

  const sqlite3 = await getSqlite3();
  const sharedVfs = getVfs(sqlite3, fs);

  // The VFS is a shared singleton, so its read/byte counters cannot be a
  // single flat total — a second handle opened while this one is still
  // open would otherwise have its reads misattributed to whichever handle
  // last captured a "baseline" (this was Finding 6: a real regression from
  // the naive baseline-delta approach). Instead, claim an owner token for
  // the narrow window around open_v2, during which xOpen will record which
  // fileId(s) belong to this handle; every later xRead for those fileIds
  // credits this token specifically, however many other handles are open
  // at the same time. That window is serialized by withSqliteLock above
  // (Findings 7 & 8) so it can never overlap any other handle's open, query,
  // or close.
  const { owner, db } = await withSqliteLock(async (): Promise<{ owner: VfsOwner; db: number }> => {
    const openedOwner = sharedVfs.beginOpen();
    let openedDb: number;
    try {
      // immutable=1 skips the WAL and -shm and takes no locks. Required: this
      // VFS implements no shared-memory methods and flow.sqlite is in WAL mode.
      openedDb = await sqlite3.open_v2(
        `file:${dbPath}?immutable=1`,
        SQLite.SQLITE_OPEN_READONLY | SQLite.SQLITE_OPEN_URI,
        VFS_NAME
      );
    } catch (err) {
      // A failed open_v2 throws before ever handing back a db pointer (see
      // sqlite-api.js: it adds the pointer to its internal set and only then
      // checks the result code), so there is no handle for us to close here.
      // But we did claim an owner token above — forget it now, or a stream of
      // failed opens would leak one Map entry per attempt forever.
      sharedVfs.forgetOwner(openedOwner);
      throw err;
    } finally {
      sharedVfs.endOpen();
    }

    try {
      // Read-only-safe: this sets an in-memory pragma on this connection and
      // writes nothing to disk. Without it, any ORDER BY / GROUP BY / DISTINCT
      // whose sorter spills tries to open a temp file through this VFS, which
      // refuses the null/empty filename a temp file is given and fails the
      // whole query with SQLITE_CANTOPEN. Forcing temp storage into memory
      // means a spill never touches the VFS at all. This has to run inside
      // the same lock as open_v2 above (see the lock's doc comment) — running
      // it concurrently with another handle's open/query/close corrupts
      // wa-sqlite's shared Asyncify state.
      // Documented exemption to "SQL lives only in repository.ts": this is
      // connection setup, not a data query, and it must run inside the open
      // lock before the handle is handed out. Without it, any query whose
      // sorter spills to disk fails, because this VFS refuses temp files.
      await sqlite3.exec(openedDb, 'PRAGMA temp_store=MEMORY;');
    } catch (err) {
      // Unlike a failed open_v2 itself, we do have a live handle at this
      // point — close it and drop its owner token rather than leaking both.
      await sqlite3.close(openedDb);
      sharedVfs.forgetOwner(openedOwner);
      throw err;
    }

    return { owner: openedOwner, db: openedDb };
  });

  let closed = false;

  return {
    get stats() {
      return sharedVfs.statsFor(owner);
    },
    async all(sql: string): Promise<unknown[][]> {
      // Routed through the shared lock (Finding 8): two handles' `all()`
      // calls racing directly against the WASM module — with no opening
      // involved at all — is exactly what corrupted it and left both
      // handles permanently unclosable. See the lock's doc comment.
      return withSqliteLock(async () => {
        const rows: unknown[][] = [];
        await sqlite3.exec(db, sql, (row: unknown[]) => { rows.push([...row]); });
        return rows;
      });
    },
    async close(): Promise<void> {
      // sqlite3.close() throws SQLITE_MISUSE on an already-freed handle, so
      // callers using a try/finally around open+close must be able to call
      // this more than once without it blowing up. Check-and-set happens
      // synchronously, before any await, so two overlapping close() calls
      // on the same handle can't both slip past this guard.
      if (closed) return;
      closed = true;
      // Also routed through the shared lock (Finding 8) — closing one
      // handle while another handle's open/query/close is in flight is the
      // same class of overlapping-WASM-call corruption.
      await withSqliteLock(async () => {
        await sqlite3.close(db);
        sharedVfs.forgetOwner(owner);
      });
    },
  };
}
