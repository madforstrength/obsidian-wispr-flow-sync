// wa-sqlite ships untyped JS sources, but the package's declaration file
// (src/types/index.d.ts) provides ambient module typings for this deep
// import, so no @ts-expect-error is needed (and would be flagged unused).
import * as VFS from 'wa-sqlite/src/VFS.js';

export type Fs = typeof import('node:fs');

interface OpenFile { fd: number; size: number }

/** Opaque token identifying one `openWisprDatabase` handle's read
 *  accounting. See `beginOpen`/`endOpen`/`statsFor`/`forgetOwner`. */
export type VfsOwner = symbol;

interface OwnerStats { reads: number; bytes: number }

/**
 * Read-only VFS backed by Node's fs, serving pages on demand.
 *
 * Three non-obvious requirements, each verified by experiment:
 *  1. `mxPathName` must also be set as `Xc` — the minified dist reads
 *     `g.Xc ?? 64`, and 64 is shorter than a real macOS Application Support
 *     path, so SQLite fails before ever calling xOpen.
 *  2. Filenames arrive with URI query strings still attached, so strip `?...`.
 *  3. Callers must open with `immutable=1`, because this VFS implements no
 *     shared-memory methods and the database is in WAL mode.
 *
 * A fourth requirement, found by review against the real 217 MB database:
 * every method SQLite can call synchronously during a query (xRead,
 * xFileSize) must catch and translate exceptions into SQLite error codes.
 * SQLite's C engine only runs its own cleanup (closing files, etc.) when a
 * VFS call *returns* an error code; a thrown JS exception instead unwinds
 * straight through the WASM call stack, skipping that cleanup and leaking
 * whatever the engine was holding (observed as leaked file descriptors on a
 * failed open).
 *
 * A fifth: this VFS is registered exactly ONCE per process and shared by
 * every `openWisprDatabase` handle (wa-sqlite has no `vfs_unregister`, so
 * registering a fresh VFS per open would leak registrations forever). That
 * means read/byte counters cannot live on the VFS instance as a single
 * flat total — two handles open at the same time would stomp on each
 * other's numbers. Instead, each `fileId` SQLite opens is attributed to the
 * handle that requested it via a short-lived "current owner" token, set by
 * `beginOpen()` immediately before the `open_v2` call that will cause
 * SQLite to call `xOpen`, and cleared by `endOpen()` right after. Every
 * later `xRead` for that `fileId` credits the same owner's bucket, so
 * `statsFor(owner)` reports only that handle's reads, however many other
 * handles are open concurrently.
 */
// VFS.Base is untyped JS. Cast to a bare constructible so our own member
// declarations below are not fighting an inferred index signature.
const VFSBase = VFS.Base as unknown as { new (): object };

export class NodeReadOnlyVFS extends VFSBase implements SQLiteVFS {
  name: string;
  mxPathName = 1024;
  /** Minified alias of mxPathName in dist/wa-sqlite.mjs. Must stay in sync. */
  Xc = 1024;

  #fs: Fs;
  #files = new Map<number, OpenFile>();

  // Per-handle read accounting (Finding 6 fix). See the class doc comment.
  #currentOwner: VfsOwner | null = null;
  #ownerByFileId = new Map<number, VfsOwner>();
  #statsByOwner = new Map<VfsOwner, OwnerStats>();

  constructor(name: string, fs: Fs) {
    super();
    this.name = name;
    this.#fs = fs;
  }

  static #clean(name: unknown): string {
    return String(name ?? '').split('?')[0];
  }

  /** Call immediately before an `open_v2` that will make SQLite call
   *  `xOpen` for a new handle. Every `fileId` opened until the matching
   *  `endOpen()` is attributed to the returned token. */
  beginOpen(): VfsOwner {
    const owner: VfsOwner = Symbol('wispr-db-handle');
    this.#currentOwner = owner;
    this.#statsByOwner.set(owner, { reads: 0, bytes: 0 });
    return owner;
  }

  /** Ends the attribution window opened by `beginOpen()`. Call this after
   *  the `open_v2` call settles, whether it succeeded or threw, so that any
   *  xOpen calls happening outside of an open are never misattributed. */
  endOpen(): void {
    this.#currentOwner = null;
  }

  /** Reads and bytes attributed to `owner` so far. Returns zeros for an
   *  owner that issued no reads, or one already forgotten. */
  statsFor(owner: VfsOwner): { reads: number; bytes: number } {
    const s = this.#statsByOwner.get(owner);
    return s ? { reads: s.reads, bytes: s.bytes } : { reads: 0, bytes: 0 };
  }

  /** Releases an owner's accounting once its handle's close() has run, so
   *  a long-running session opening and closing many handles doesn't grow
   *  these maps without bound. Safe to call more than once. */
  forgetOwner(owner: VfsOwner): void {
    this.#statsByOwner.delete(owner);
    for (const [fileId, o] of this.#ownerByFileId) {
      if (o === owner) this.#ownerByFileId.delete(fileId);
    }
  }

  xOpen(name: unknown, fileId: number, _flags: number, pOutFlags: DataView): number {
    const path = NodeReadOnlyVFS.#clean(name);
    if (!path) return VFS.SQLITE_CANTOPEN;
    // A fileId can be reused across opens (e.g. journal/main-db slots being
    // recycled). Close whatever was previously there first so we never
    // orphan a file descriptor by silently overwriting the map entry.
    const existing = this.#files.get(fileId);
    if (existing) {
      try { this.#fs.closeSync(existing.fd); } catch { /* already gone */ }
      this.#files.delete(fileId);
    }
    try {
      const fd = this.#fs.openSync(path, 'r');
      this.#files.set(fileId, { fd, size: this.#fs.fstatSync(fd).size });
      if (this.#currentOwner !== null) {
        this.#ownerByFileId.set(fileId, this.#currentOwner);
      }
      pOutFlags.setInt32(0, VFS.SQLITE_OPEN_READONLY, true);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_CANTOPEN;
    }
  }

  xClose(fileId: number): number {
    const f = this.#files.get(fileId);
    if (f) {
      try { this.#fs.closeSync(f.fd); } catch { /* already gone */ }
      this.#files.delete(fileId);
    }
    return VFS.SQLITE_OK;
  }

  xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
    const f = this.#files.get(fileId);
    if (!f) return VFS.SQLITE_IOERR;
    // Must never throw across the WASM boundary: an uncaught exception here
    // (e.g. EISDIR, a negative/out-of-range offset) aborts the native call
    // stack mid-unwind, so SQLite never gets a chance to call xClose. That
    // is what turned a bad read into a leaked fd. Report it as a normal
    // SQLite IO error instead, so the engine's own cleanup path runs.
    try {
      const n = this.#fs.readSync(f.fd, pData, 0, pData.byteLength, iOffset);
      const owner = this.#ownerByFileId.get(fileId);
      if (owner !== undefined) {
        const s = this.#statsByOwner.get(owner);
        if (s) {
          s.reads++;
          s.bytes += n;
        }
      }
      if (n < pData.byteLength) {
        pData.fill(0, n);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR_READ;
    }
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const f = this.#files.get(fileId);
    if (!f) return VFS.SQLITE_IOERR;
    try {
      pSize64.setBigInt64(0, BigInt(f.size), true);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR_FSTAT;
    }
  }

  xAccess(name: unknown, _flags: number, pResOut: DataView): number {
    const path = NodeReadOnlyVFS.#clean(name);
    let exists = false;
    try { exists = this.#fs.existsSync(path); } catch { exists = false; }
    pResOut.setInt32(0, exists ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }

  // Read-only: mutations are refused, locking is a no-op (immutable=1 means
  // SQLite never asks for a real lock anyway).
  xWrite(): number { return VFS.SQLITE_READONLY; }
  xTruncate(): number { return VFS.SQLITE_READONLY; }
  xDelete(): number { return VFS.SQLITE_READONLY; }
  xSync(): number { return VFS.SQLITE_OK; }
  xLock(): number { return VFS.SQLITE_OK; }
  xUnlock(): number { return VFS.SQLITE_OK; }
  xCheckReservedLock(_fileId: number, pResOut: DataView): number {
    pResOut.setInt32(0, 0, true);
    return VFS.SQLITE_OK;
  }
  xDeviceCharacteristics(): number { return 0; }
  xSectorSize(): number { return 4096; }
  xFileControl(): number { return VFS.SQLITE_NOTFOUND; }
}
