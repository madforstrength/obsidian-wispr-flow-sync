import type { Fs } from './vfs';

/**
 * WHY THIS FILE EXISTS — read before touching it:
 *
 * `openWisprDatabase` opens flow.sqlite with `immutable=1`, which is forced
 * on us: this plugin's VFS implements no shared-memory (`xShmMap`) methods,
 * and SQLite refuses to open a WAL-mode database read-write without them.
 * But `immutable=1` also tells SQLite the file can never change, so it
 * ignores the `-wal` and `-shm` files entirely and reads only the pages in
 * the main database file.
 *
 * That is not a stale-by-a-few-seconds problem. Wispr Flow holds its
 * connection open for as long as the app runs and only checkpoints when
 * SQLite's own auto-checkpoint threshold (1000 pages, ~4 MB) is crossed, so
 * on a real install the WAL routinely holds days of meetings — and, if a
 * schema migration rewrote the table, EVERY row of it. Measured on a real
 * install: the main file alone reported `SELECT count(*) FROM Meetings` = 0
 * while the same database read with its WAL reported 29. The plugin synced
 * nothing, reported no error, and looked like it had simply found no
 * meetings.
 *
 * So we do SQLite's WAL read ourselves. This module parses the `-wal` file
 * into a *snapshot*: page number -> byte offset of that page's newest
 * committed copy inside the WAL. `NodeReadOnlyVFS` then consults that map on
 * every `xRead` and serves the WAL's copy of a page in preference to the
 * main file's. `immutable=1`, read-only, and the lazy-paging property all
 * survive intact — we never copy the database, never take a lock, and never
 * write anything.
 *
 * Format reference: https://sqlite.org/fileformat2.html#walformat
 * All header fields are big-endian. The checksum, confusingly, is computed
 * over the data interpreted in the byte order named by the magic number,
 * which is a separate thing from the field encoding.
 */

const WAL_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 24;

/** Magic in the WAL header. Low bit selects the checksum's byte order. */
const MAGIC_LITTLE_ENDIAN_CKSUM = 0x377f0682;
const MAGIC_BIG_ENDIAN_CKSUM = 0x377f0683;

export interface WalSnapshot {
  /** Page number (1-based) -> byte offset of that page's DATA in the -wal
   *  file (i.e. already past the frame's 24-byte header). Contains only
   *  pages belonging to the last complete commit; see readWalSnapshot. */
  pages: Map<number, number>;
  /** Page size in bytes, as declared by the WAL header. */
  pageSize: number;
  /** Size of the database, in pages, as of the last commit frame. This is
   *  authoritative for the snapshot and can differ from the main file's
   *  size on disk in BOTH directions (the WAL can hold appended pages the
   *  main file has never seen, and a commit can shrink the database). */
  dbSizePages: number;
  /** Header salts. A checkpoint that restarts the WAL rewrites these, which
   *  is how `walStillCurrent` detects that this snapshot's offsets have gone
   *  stale underneath us. */
  salt1: number;
  salt2: number;
  /** Filesystem identity of the `-wal` this snapshot came from. Salts alone
   *  cannot detect unlink-and-recreate: an unlinked file stays readable
   *  through an open descriptor with its bytes — and therefore its salts —
   *  frozen forever, so a WAL that was deleted and replaced would keep
   *  passing a salts-only check while the database moved on without it.
   *  On Windows `ino` may be 0 for both sides, in which case this check
   *  degrades to the salts alone rather than misfiring. */
  dev: number;
  ino: number;
  /** Frames accepted into `pages`. Diagnostics only. */
  frames: number;
}

function isValidPageSize(size: number): boolean {
  return size >= 512 && size <= 65536 && (size & (size - 1)) === 0;
}

/**
 * SQLite's WAL checksum: an unrolled Fibonacci-weighted sum over the data
 * read as pairs of 32-bit words, carried forward from frame to frame.
 *
 * `length` must be a multiple of 8. Arithmetic is 32-bit unsigned: the
 * intermediate `a + x0 + b` can reach ~3 * 2^32, which is still exactly
 * representable as a JS number, so a single `>>> 0` afterwards performs the
 * mod-2^32 wrap correctly. Do not "optimise" this into `| 0` — that yields
 * a signed result and the comparisons against the stored checksum fail.
 */
function checksum(
  buf: Uint8Array,
  start: number,
  length: number,
  bigEndian: boolean,
  seed0: number,
  seed1: number
): [number, number] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const littleEndian = !bigEndian;
  let a = seed0 >>> 0;
  let b = seed1 >>> 0;
  for (let i = start; i < start + length; i += 8) {
    a = (a + view.getUint32(i, littleEndian) + b) >>> 0;
    b = (b + view.getUint32(i + 4, littleEndian) + a) >>> 0;
  }
  return [a, b];
}

/**
 * Page size recorded in the main database file's header (byte offset 16, a
 * 16-bit big-endian value where the literal 1 means 65536). Used only to
 * reject a WAL whose page size disagrees with the database it claims to
 * belong to — a mismatch means the two files are not a matching pair (a
 * leftover WAL from a different database, or one straddling a VACUUM that
 * changed the page size), and overlaying its pages would produce garbage.
 */
export function readMainDbPageSize(fs: Fs, dbPath: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(dbPath, 'r');
  } catch {
    return null;
  }
  try {
    const header = new Uint8Array(18);
    if (fs.readSync(fd, header, 0, 18, 0) !== 18) return null;
    const raw = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint16(16, false);
    const pageSize = raw === 1 ? 65536 : raw;
    return isValidPageSize(pageSize) ? pageSize : null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * Build a read snapshot of `walPath` from an ALREADY-OPEN descriptor.
 *
 * Taking the fd rather than the path is deliberate: the caller keeps that
 * same descriptor open for the lifetime of the database handle and hands it
 * to the VFS, so every later page read is served from the exact file this
 * snapshot was computed from. Re-opening by path between snapshot and read
 * would leave a window in which a checkpoint could swap the file underneath
 * the offsets we just recorded.
 *
 * Returns null — meaning "no overlay, read the main file as before" — for a
 * WAL that is absent, empty, truncated before its first complete commit,
 * corrupt, or written for a different page size. Null is always a safe
 * answer: it degrades to exactly the pre-overlay behaviour.
 *
 * Validation is deliberately strict, and mirrors SQLite's own recovery rule:
 * frames are accepted only while their salts match the header's AND their
 * running checksum matches, and the snapshot then stops at the LAST COMMIT
 * frame among those. Anything after that last commit is a transaction Wispr
 * Flow had not finished writing, and including it would expose a torn write.
 */
export function readWalSnapshot(
  fs: Fs,
  walFd: number,
  expectedPageSize: number | null
): WalSnapshot | null {
  const stat = fs.fstatSync(walFd);
  const size = stat.size;
  if (size < WAL_HEADER_SIZE + FRAME_HEADER_SIZE) return null;

  const header = new Uint8Array(WAL_HEADER_SIZE);
  if (fs.readSync(walFd, header, 0, WAL_HEADER_SIZE, 0) !== WAL_HEADER_SIZE) return null;
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);

  const magic = hv.getUint32(0, false);
  if (magic !== MAGIC_LITTLE_ENDIAN_CKSUM && magic !== MAGIC_BIG_ENDIAN_CKSUM) return null;
  const bigEndian = magic === MAGIC_BIG_ENDIAN_CKSUM;

  const pageSize = hv.getUint32(8, false);
  if (!isValidPageSize(pageSize)) return null;
  if (expectedPageSize !== null && pageSize !== expectedPageSize) return null;

  const salt1 = hv.getUint32(16, false);
  const salt2 = hv.getUint32(20, false);

  // The header's own checksum covers its first 24 bytes, seeded with zero.
  // A mismatch means this WAL was never validly initialised; SQLite would
  // ignore it, so we must too.
  const [hs0, hs1] = checksum(header, 0, 24, bigEndian, 0, 0);
  if (hs0 !== hv.getUint32(24, false) || hs1 !== hv.getUint32(28, false)) return null;

  const frameSize = FRAME_HEADER_SIZE + pageSize;
  const frame = new Uint8Array(frameSize);
  const fv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  interface Frame { pageNo: number; dbSizePages: number; dataOffset: number }
  const frames: Frame[] = [];

  let running0 = hs0;
  let running1 = hs1;
  let offset = WAL_HEADER_SIZE;

  while (offset + frameSize <= size) {
    if (fs.readSync(walFd, frame, 0, frameSize, offset) !== frameSize) break;

    const pageNo = fv.getUint32(0, false);
    const dbSizePages = fv.getUint32(4, false);

    // A frame left over from a previous WAL generation (the file is reused
    // in place after a checkpoint) carries the OLD salts. It is not
    // corruption, it is simply past the end of the current WAL.
    if (fv.getUint32(8, false) !== salt1 || fv.getUint32(12, false) !== salt2) break;
    if (pageNo === 0) break;

    // Checksum runs over the frame header's first 8 bytes and then the page
    // payload, continuing the chain from the previous frame. The salts and
    // the stored checksum itself (bytes 8..23) are excluded.
    const [afterHeader0, afterHeader1] = checksum(frame, 0, 8, bigEndian, running0, running1);
    const [c0, c1] = checksum(frame, FRAME_HEADER_SIZE, pageSize, bigEndian, afterHeader0, afterHeader1);
    if (c0 !== fv.getUint32(16, false) || c1 !== fv.getUint32(20, false)) break;

    running0 = c0;
    running1 = c1;
    frames.push({ pageNo, dbSizePages, dataOffset: offset + FRAME_HEADER_SIZE });
    offset += frameSize;
  }

  // Only committed data is visible. A commit frame is one carrying a
  // non-zero database size; everything after the last one belongs to a
  // transaction still in flight.
  let lastCommit = -1;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].dbSizePages !== 0) { lastCommit = i; break; }
  }
  if (lastCommit < 0) return null;

  // Later frames win: iterating forwards and overwriting yields each page's
  // newest committed copy, which is precisely what a reader should see.
  const pages = new Map<number, number>();
  for (let i = 0; i <= lastCommit; i++) pages.set(frames[i].pageNo, frames[i].dataOffset);

  return {
    pages,
    pageSize,
    dbSizePages: frames[lastCommit].dbSizePages,
    salt1,
    salt2,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    frames: lastCommit + 1,
  };
}

/**
 * Confirms a snapshot's page offsets still mean what they meant when it was
 * taken. Two distinct ways they can stop meaning it, and both are checked:
 *
 *  1. **Restart in place.** A checkpoint does not merely append: once the
 *     WAL has been copied back into the database, the next writer RESTARTS
 *     it, overwriting frames from the beginning of the same file under new
 *     salts. Our offsets would then address unrelated pages. Caught by
 *     re-reading the 32-byte header through the SAME descriptor and
 *     comparing salts.
 *
 *  2. **Unlink and recreate.** If Wispr Flow closes its last connection,
 *     SQLite checkpoints and DELETES the WAL; a later launch creates a new
 *     one at the same path. Our descriptor still refers to the old, now
 *     unlinked inode, whose bytes — and therefore whose salts — never
 *     change again, so check (1) passes forever while the database moves on
 *     without us. Caught by comparing the path's current identity against
 *     the identity the snapshot was built from.
 *
 * Both are reported the same way: the caller raises an error and the sync
 * engine's `withRetry` re-runs from a fresh snapshot. A missing WAL counts
 * as changed — that is the clean-shutdown case, and the retry will find the
 * data checkpointed into the main file where it belongs.
 */
export function walStillCurrent(
  fs: Fs,
  walFd: number,
  walPath: string,
  snapshot: WalSnapshot
): boolean {
  try {
    const current = fs.statSync(walPath);
    if (Number(current.dev) !== snapshot.dev || Number(current.ino) !== snapshot.ino) return false;

    const header = new Uint8Array(WAL_HEADER_SIZE);
    if (fs.readSync(walFd, header, 0, WAL_HEADER_SIZE, 0) !== WAL_HEADER_SIZE) return false;
    const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    return hv.getUint32(16, false) === snapshot.salt1 && hv.getUint32(20, false) === snapshot.salt2;
  } catch {
    // statSync throws when the WAL has been deleted outright — the same
    // staleness, reported the same way.
    return false;
  }
}
