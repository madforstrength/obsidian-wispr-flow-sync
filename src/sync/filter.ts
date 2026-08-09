import type { MeetingRow } from '../types';

export type TitleFilterMode = 'disabled' | 'include' | 'exclude';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Wispr-format timestamp for midnight UTC `daysBack` days before `nowMs`,
 *  or null meaning "no limit". Returns Wispr's exact string shape because the
 *  value is compared against the `createdAt` column in SQL.
 *
 *  INVARIANT: the return value is EITHER null OR a string matching
 *  /^\d{4}-\d{2}-\d{2} 00:00:00\.000 \+00:00$/ — a fixed-width format.
 *  The SQL comparison is lexicographic, so any width error compares wrong
 *  rather than erroring loudly; returning null (meaning "no limit") is the
 *  safe degradation for invalid, out-of-range, or malformed results. */
export function createdAfterFloor(daysBack: number, nowMs: number): string | null {
  if (!Number.isFinite(daysBack) || daysBack <= 0) return null;
  const whole = Math.floor(daysBack);
  const d = new Date(nowMs - whole * 86_400_000);
  // Ensure the date is valid and the year is in the representable range for the format
  if (!Number.isFinite(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1000 || year > 9999) return null;
  return (
    `${String(year).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `00:00:00.000 +00:00`
  );
}

export function matchesTitleFilter(
  meeting: MeetingRow,
  mode: TitleFilterMode,
  keyword: string
): boolean {
  if (mode === 'disabled') return true;
  const needle = keyword.trim().toLowerCase();
  // An empty keyword must never silently filter everything out — treat it as
  // "filter off" rather than "matches nothing".
  if (!needle) return true;
  const hay = (meeting.title ?? '').toLowerCase();
  const contains = hay.includes(needle);
  return mode === 'include' ? contains : !contains;
}
