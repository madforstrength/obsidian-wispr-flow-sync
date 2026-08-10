// wa-sqlite ships untyped JS sources, but the package's declaration file
// (src/types/index.d.ts) provides ambient module typings for this deep
// import, so no @ts-expect-error is needed (and would be flagged unused).
import * as VFS from 'wa-sqlite/src/VFS.js';
import type { WalSnapshot } from './wal';

export type Fs = typeof import('node:fs');

/**
 * A WAL read snapshot bound to the descriptor it was computed from, plus
 * the database path it belongs to. `openWisprDatabase` builds this and
 * hands it to `beginOpen` so that the file SQLite is about to open can be
 * matched to it by path.
 *
 * Descriptor ownership stays with the caller: `xClose` deliberately does
 * NOT close `walFd`, because the same overlay outlives any individual
 * SQLite file slot and the handle's own `close()` is what releases it.
 */
export interface WalOverlay {
  dbPath: string;
  walFd: number;
  snapshot: WalSnapshot;
}

interface OpenFile { fd: number; size: number; overlay?: WalOverlay }

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
 *     shared-memory methods and the database is in WAL mode. `immutable=1`
 *     also makes SQLite ignore the `-wal` file, which on a live Wispr Flow
 *     install is where most (sometimes all) of the data is — so this VFS
 *     performs the WAL read itself, via the `WalOverlay` passed to
 *     `beginOpen`. See `wal.ts` for why that is not optional.
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

  /** Set for the duration of one `beginOpen`/`endOpen` window, alongside
   *  `#currentOwner`, and attached to whichever file SQLite opens at the
   *  overlay's own `dbPath` during that window. */
  #currentOverlay: WalOverlay | null = null;

  /** Whether the overlay handed to the most recent `beginOpen` was actually
   *  attached to a file. Read by `openWisprDatabase` to turn a silent
   *  path-matching miss into a loud failure — an unattached overlay means
   *  the handle would read the main file alone, which is the exact
   *  data-loss behaviour this whole mechanism exists to end. */
  #overlayAttached = false;

  constructor(name: string, fs: Fs) {
    super();
    this.name = name;
    this.#fs = fs;
  }

  static #clean(name: unknown): string {
    return String(name ?? '').split('?')[0];
  }

  /** Path comparison for overlay matching only — never for opening.
   *  SQLite hands back the filename from the URI essentially verbatim, so an
   *  exact match is the normal case; normalising separators and case buys
   *  tolerance on Windows, where the same file can legitimately be spelled
   *  more than one way and a miss would silently cost the user their WAL. */
  static #samePath(a: string, b: string): boolean {
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
    return norm(a) === norm(b);
  }

  /** True when the overlay passed to the most recent `beginOpen` was
   *  attached to a file. Meaningless if no overlay was passed. */
  didAttachOverlay(): boolean {
    return this.#overlayAttached;
  }

  /** Call immediately before an `open_v2` that will make SQLite call
   *  `xOpen` for a new handle. Every `fileId` opened until the matching
   *  `endOpen()` is attributed to the returned token.
   *
   *  `overlay`, when given, is attached to the file opened at its own
   *  `dbPath` during this window, so that file's reads are served from the
   *  WAL snapshot. It is scoped to the window for the same reason the owner
   *  token is: this VFS is a shared singleton, and two handles opening
   *  different databases must not inherit each other's overlay. */
  beginOpen(overlay?: WalOverlay | null): VfsOwner {
    const owner: VfsOwner = Symbol('wispr-db-handle');
    this.#currentOwner = owner;
    this.#currentOverlay = overlay ?? null;
    this.#overlayAttached = false;
    this.#statsByOwner.set(owner, { reads: 0, bytes: 0 });
    return owner;
  }

  /** Ends the attribution window opened by `beginOpen()`. Call this after
   *  the `open_v2` call settles, whether it succeeded or threw, so that any
   *  xOpen calls happening outside of an open are never misattributed. */
  endOpen(): void {
    this.#currentOwner = null;
    this.#currentOverlay = null;
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
    // Held outside the try so the catch can close a descriptor that was
    // opened but never made it into #files — fstatSync below can throw
    // between those two points, and the map is the only thing xClose ever
    // consults, so such an fd would be unreachable and leak for the life of
    // the session.
    let fd: number | null = null;
    try {
      fd = this.#fs.openSync(path, 'r');
      // Matched by path, not "the first file opened": with immutable=1
      // SQLite opens only the main database, but that is its choice, not a
      // guarantee we should encode. Attaching by path means a temp or
      // journal file opened for any reason can never be served pages from
      // the database's WAL.
      const overlay =
        this.#currentOverlay && NodeReadOnlyVFS.#samePath(this.#currentOverlay.dbPath, path)
          ? this.#currentOverlay
          : undefined;
      const size = this.#fs.fstatSync(fd).size;
      this.#files.set(fileId, { fd, size, overlay });
      // Only after ownership has transferred into #files: an early return
      // below must not leave this set for a file that was never attached.
      if (overlay) this.#overlayAttached = true;
      if (this.#currentOwner !== null) {
        this.#ownerByFileId.set(fileId, this.#currentOwner);
      }
      pOutFlags.setInt32(0, VFS.SQLITE_OPEN_READONLY, true);
      return VFS.SQLITE_OK;
    } catch {
      if (fd !== null && !this.#files.has(fileId)) {
        try { this.#fs.closeSync(fd); } catch { /* already gone */ }
      }
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
      const n = f.overlay
        ? this.#readWithOverlay(f, f.overlay, pData, iOffset)
        : this.#fs.readSync(f.fd, pData, 0, pData.byteLength, iOffset);
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

  /**
   * Serves a read page by page, taking each page from the WAL snapshot when
   * it holds a newer committed copy and from the main file otherwise.
   *
   * Page-at-a-time rather than "is this whole request one WAL page?":
   * SQLite's very first read is the 100-byte database header at offset 0,
   * and page 1 is routinely a page the WAL has rewritten, so a whole-page
   * assumption is wrong on the first call. Splitting at page boundaries
   * handles the header read, ordinary page reads, and any hypothetical
   * multi-page read with one code path.
   *
   * Returns the number of bytes filled, matching `fs.readSync`'s contract,
   * so the caller's short-read handling is unchanged.
   */
  #readWithOverlay(f: OpenFile, overlay: WalOverlay, pData: Uint8Array, iOffset: number): number {
    const { pages, pageSize, dbSizePages } = overlay.snapshot;
    // The logical end of the database for this snapshot — the same number
    // xFileSize reports. Reads must respect it, or the two disagree: a
    // commit that SHRANK the database leaves frames for pages above the new
    // size still sitting in the map from earlier transactions in the same
    // WAL, and serving those would hand back bytes from beyond the file
    // SQLite believes it opened, instead of the short read it expects.
    const visibleSize = dbSizePages * pageSize;
    let filled = 0;

    while (filled < pData.byteLength) {
      const position = iOffset + filled;
      if (position >= visibleSize) break;
      const pageNo = Math.floor(position / pageSize) + 1;
      const withinPage = position % pageSize;
      const want = Math.min(
        pData.byteLength - filled,
        pageSize - withinPage,
        visibleSize - position
      );
      const target = pData.subarray(filled, filled + want);

      const frameDataOffset = pages.get(pageNo);
      const n =
        frameDataOffset === undefined
          ? this.#fs.readSync(f.fd, target, 0, want, position)
          : this.#fs.readSync(overlay.walFd, target, 0, want, frameDataOffset + withinPage);

      filled += n;
      // Short read: the page is past the end of whichever file backs it.
      // Stop here and let the caller zero-fill and report SHORT_READ, which
      // is what SQLite expects for a read past end-of-file.
      if (n < want) break;
    }

    return filled;
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const f = this.#files.get(fileId);
    if (!f) return VFS.SQLITE_IOERR;
    try {
      // With an overlay, the last commit frame's page count is the size of
      // the database SQLite should see — not the main file's size on disk.
      // The two differ in both directions: the WAL can hold pages appended
      // past the end of the main file (reporting the smaller size makes
      // SQLite treat live pages as beyond EOF), and a commit can shrink the
      // database below what the main file still occupies.
      const size = f.overlay
        ? f.overlay.snapshot.dbSizePages * f.overlay.snapshot.pageSize
        : f.size;
      pSize64.setBigInt64(0, BigInt(size), true);
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
