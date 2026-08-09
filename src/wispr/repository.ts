import type { MeetingRow } from '../types';
import type { WisprDb } from './db';

/** Columns the renderer and sync engine depend on. Wispr's schema is
 *  undocumented and Notetaker shipped days before this plugin, so drift is
 *  expected — probeSchema turns drift into one actionable message. */
export const REQUIRED_COLUMNS = [
  'id', 'title', 'notes', 'summary', 'speakerMap',
  'createdAt', 'modifiedAt', 'endedAt', 'isDeleted', 'finalized',
] as const;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v == null ? null : String(v);
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function flag(v: unknown): number {
  return num(v) ? 1 : 0;
}

export async function probeSchema(db: WisprDb): Promise<{ ok: boolean; missing: string[] }> {
  const rows = await db.all(`PRAGMA table_info('Meetings')`);
  // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
  const present = new Set(rows.map((r) => String(r[1])));
  const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
  return { ok: missing.length === 0, missing };
}

export async function listMeetings(
  db: WisprDb,
  opts: { since?: string | null; includeUnfinalized?: boolean; createdAfter?: string | null }
): Promise<MeetingRow[]> {
  const where = ['isDeleted = 0'];
  if (!opts.includeUnfinalized) where.push('finalized = 1');
  if (opts.since) {
    // sqlite3.exec takes no bind parameters, so quote defensively.
    // sqlite3_prepare_v2(..., -1, ...) stops at the first NUL byte, so strip
    // them before quoting to prevent accidental statement truncation.
    const safe = opts.since.replace(/\0/g, '').replace(/'/g, "''");
    where.push(`(modifiedAt > '${safe}' OR modifiedAt IS NULL)`);
  }
  if (opts.createdAfter) {
    const safeFloor = opts.createdAfter.replace(/\0/g, '').replace(/'/g, "''");
    where.push(`createdAt >= '${safeFloor}'`);
  }

  // isDeleted and finalized are selected even though the WHERE clause already
  // filters them: they are carried on MeetingRow so callers can assert on the
  // real values in tests and so a future filtering change cannot silently
  // start returning rows nobody checked.
  const sql =
    `SELECT id, title, notes, summary, speakerMap, createdAt, modifiedAt, endedAt, isDeleted, finalized ` +
    `FROM Meetings WHERE ${where.join(' AND ')} ORDER BY createdAt ASC, id ASC`;

  const rows = await db.all(sql);
  return rows.map((r) => ({
    id: String(r[0]),
    title: str(r[1]),
    notes: str(r[2]),
    summary: str(r[3]),
    speakerMap: str(r[4]),
    createdAt: str(r[5]),
    modifiedAt: str(r[6]),
    endedAt: num(r[7]),
    isDeleted: flag(r[8]),
    finalized: flag(r[9]),
  }));
}
