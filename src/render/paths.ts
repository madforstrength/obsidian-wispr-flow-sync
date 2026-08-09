import type { MeetingRow } from '../types';
import { parseWisprDate } from './markdown';

const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;
/* eslint-disable-next-line no-control-regex -- deliberately stripping controls */
const CONTROL = /[\x00-\x08\x0E-\x1F\x7F-\x9F]/g;
/** Characters that must be converted to spaces (whitespace-like). \x0B
 *  (vertical tab) and \x0C (form feed) are C0 whitespace and behave as word
 *  separators — same reasoning that makes tab/newline/CR become a space
 *  rather than vanish. markdown.ts's yamlScalar treats them identically, so
 *  a title survives with the same visible words in both the frontmatter
 *  and the filename. */
const WHITESPACE_CONTROLS = /[\x09\x0A\x0D\x0B\x0C]/g;
const MAX_SEGMENT = 120;

export type SubfolderPattern =
  | 'none' | 'day' | 'month' | 'year-month' | 'year-quarter' | 'custom';

/** The key under which a vault path is tracked for collision purposes.
 *
 *  The `used` set holds these KEYS, not literal paths. macOS (APFS) and
 *  Windows are case-insensitive, and macOS additionally normalises Unicode
 *  in filenames — so `Standup.md` and `standup.md`, or a composed and a
 *  decomposed `café.md`, are ONE file on disk even though they are distinct
 *  JavaScript strings. Comparing raw strings let two meetings resolve to the
 *  same file, and the second write silently destroyed the first while the
 *  sync reported both as written. */
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** Truncate by code POINT, not code unit, so a surrogate pair is never split
 *  into a lone half (which would make the filename invalid UTF-16). `max` is
 *  measured in UTF-16 code units (i.e. JS string `.length`), matching every
 *  other length check in this file — only the CUT POINT is code-point-safe. */
function truncateCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  const points = Array.from(value);
  let result = '';
  for (const point of points) {
    const nextResult = result + point;
    if (nextResult.length <= max) {
      result = nextResult;
    } else {
      break;
    }
  }
  return result;
}

/** Maximum bytes the STEM (filename minus the `.md` suffix and containing
 *  folders) may occupy once UTF-8 encoded. Most filesystems cap a single
 *  path component at 255 bytes (`NAME_MAX`); 200 leaves headroom for the
 *  `.md` suffix, a collision discriminator composePath may append, and
 *  general safety margin. This is a BYTE cap, independent of the 120
 *  code-unit cap above: a title made of 3-or-4-byte characters (many emoji,
 *  many CJK characters) can stay under 120 units while its UTF-8 encoding
 *  already exceeds 255 bytes. */
const MAX_STEM_BYTES = 200;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Truncate by code POINT so a UTF-8 multi-byte sequence (and any surrogate
 *  pair behind it) is never split, stopping once the UTF-8 encoding would
 *  exceed `maxBytes`. */
function truncateToByteBudget(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const points = Array.from(value);
  let result = '';
  for (const point of points) {
    const next = result + point;
    if (utf8ByteLength(next) <= maxBytes) {
      result = next;
    } else {
      break;
    }
  }
  return result;
}

/** Perform all character-handling and normalization steps on a name.
 *  Returns the possibly-empty cleaned string (no fallback). */
function clean(value: string): string {
  return value
    .replace(WHITESPACE_CONTROLS, ' ')
    .replace(CONTROL, '')
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .trim();
}

/** Sanitize a path segment (folder) — removes unprintable controls but drops
 *  empty results rather than inserting 'Untitled'. Used for folder components. */
function sanitizeSegment(name: string): string {
  const cleaned = clean(name);
  return truncateCodePoints(cleaned, MAX_SEGMENT).trim();
}

export function sanitizeFilename(name: string): string {
  const cleaned = clean(name);
  if (!cleaned) return 'Untitled';
  return truncateCodePoints(cleaned, MAX_SEGMENT).trim();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

interface DateParts {
  date: string; time: string; year: string;
  month: string; day: string; quarter: string;
}

function dateParts(meeting: MeetingRow): DateParts | null {
  const d = parseWisprDate(meeting.createdAt);
  if (!d) return null;
  const month = d.getUTCMonth() + 1;
  return {
    date: `${d.getUTCFullYear()}-${pad(month)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`,
    year: String(d.getUTCFullYear()),
    month: pad(month),
    day: pad(d.getUTCDate()),
    quarter: `Q${Math.floor((month - 1) / 3) + 1}`,
  };
}

export function expandTokens(pattern: string, meeting: MeetingRow): string {
  const parts = dateParts(meeting);
  const title = sanitizeFilename((meeting.title ?? '').trim() || 'Untitled meeting');
  return pattern.replace(/\{(title|date|time|year|month|day|quarter)\}/g, (match, token: string) => {
    if (token === 'title') return title;
    if (!parts) return `unknown-${token}`;
    return parts[token as keyof DateParts];
  });
}

/** Smallest number of code UNITS a truncated title is ever allowed to shrink
 *  to. A pathological pattern (huge literal text plus every date token) could
 *  otherwise drive the computed budget to zero or negative, silently dropping
 *  the title entirely; this floor guarantees at least one character survives
 *  instead, even if that means the final stem exceeds MAX_SEGMENT by a little
 *  in that extreme, unrealistic case. */
const MIN_TITLE_BUDGET = 1;

/** Expand a filename pattern into its final stem, giving the elastic
 *  `{title}` token a length BUDGET instead of truncating the fully-assembled
 *  stem afterwards.
 *
 *  NORMAL CASE (overhead comfortably under the segment maximum): every
 *  NON-title token in the pattern (date, time, year, month, day, quarter,
 *  and any literal text) appears in the resulting stem IN FULL. Only
 *  `{title}` is elastic — it absorbs whatever length the rest of the
 *  pattern leaves it, split evenly if `{title}` appears more than once.
 *  This restates Stage 1's "truncate the TITLE only, then append the full
 *  stamp, so the stamp always survives" fix for arbitrary token patterns
 *  and positions, rather than a single hardcoded "title-then-stamp" shape.
 *
 *  Achieved by expanding every non-title token FIRST (so the overhead length
 *  is known), THEN truncating the title to whatever budget remains — the
 *  inverse of expanding everything and truncating the finished string, which
 *  is what silently cut off a trailing timestamp before this fix.
 *
 *  PRECEDENCE WHEN THE TWO GOALS CONFLICT: a final backstop (see
 *  `enforceStemBackstop`) caps the ASSEMBLED stem at MAX_SEGMENT code units
 *  and MAX_STEM_BYTES UTF-8 bytes, unconditionally. When the non-title
 *  overhead alone already exceeds one of those bounds — a pattern with no
 *  `{title}` and a huge literal, or repeated tokens plus a wide multi-byte
 *  title — giving `{title}` a budget cannot be enough to stay within the
 *  bound, and THE LENGTH BOUND WINS: the backstop truncates the assembled
 *  stem regardless of which tokens' characters that cuts into. An
 *  unwritable filename (ENAMETOOLONG) is strictly worse than one where a
 *  non-title token was truncated out of necessity. This only happens in
 *  pathological configurations; the normal case above is unaffected. */
function composeStem(pattern: string, meeting: MeetingRow): string {
  const parts = dateParts(meeting);
  const expandNonTitle = (token: string): string =>
    parts ? parts[token as keyof DateParts] : `unknown-${token}`;
  const tokenRe = /\{(title|date|time|year|month|day|quarter)\}/g;

  // The title, cleaned of illegal/control characters but NOT yet length-
  // truncated — truncation happens below, against the title's own budget,
  // not against the assembled stem.
  const rawTitle = (meeting.title ?? '').trim() || 'Untitled meeting';
  const cleanTitle = clean(rawTitle) || 'Untitled';

  // Overhead = the pattern with every {title} occurrence collapsed to zero
  // width but every other token expanded to its real value. This measures
  // exactly how many characters the rest of the pattern will occupy, before
  // any truncation decision is made.
  const overhead = pattern.replace(tokenRe, (_match, token: string) =>
    token === 'title' ? '' : expandNonTitle(token)
  );

  // A pattern can use {title} more than once (e.g. `{title}-{date}-{title}`
  // for a title that also appears as a folder-like prefix). Divide the
  // remaining allowance evenly across every occurrence so repeated tokens
  // share the budget instead of each independently claiming up to the full
  // remainder (which would multiply, not bound, the final length).
  const titleOccurrences = (pattern.match(/\{title\}/g) ?? []).length;
  const rawBudget = MAX_SEGMENT - overhead.length;
  const perOccurrenceBudget = titleOccurrences > 0 ? Math.floor(rawBudget / titleOccurrences) : rawBudget;
  const budget = Math.max(MIN_TITLE_BUDGET, perOccurrenceBudget);

  // truncateCodePoints is pair-safe: a surrogate pair (e.g. an emoji) is
  // never split into a lone half, matching sanitizeFilename's guarantee.
  // The fallback for a budget too small to fit even one code point takes
  // the first code POINT (Array.from splits on code points), not the first
  // code UNIT (`.slice(0, 1)`) — slicing by unit would emit a lone high
  // surrogate for an emoji-leading title, an invalid UTF-16 string.
  const truncatedTitle =
    truncateCodePoints(cleanTitle, budget).trim() || Array.from(cleanTitle)[0] || 'U';

  const assembled = pattern.replace(tokenRe, (_match, token: string) =>
    token === 'title' ? truncatedTitle : expandNonTitle(token)
  );

  // Re-run the character rules (illegal-char replacement, whitespace
  // collapse, dash/dot trimming) over the assembled result in case literal
  // text in the pattern itself needs cleaning.
  const cleaned = clean(assembled) || 'Untitled';

  // Final backstop over the WHOLE assembled stem: see the precedence note
  // above. In the normal case this is a no-op (the budgeting above already
  // keeps the result within bounds); it only bites for pathological
  // patterns/titles where budgeting alone cannot guarantee a writable name.
  return enforceStemBackstop(cleaned);
}

function enforceStemBackstop(stem: string): string {
  const byUnits = truncateCodePoints(stem, MAX_SEGMENT).trim();
  const byBytes = truncateToByteBudget(byUnits, MAX_STEM_BYTES).trim();
  return byBytes || 'Untitled';
}

export function subfolderFor(
  pattern: SubfolderPattern,
  customPattern: string,
  meeting: MeetingRow
): string {
  const parts = dateParts(meeting);
  if (pattern === 'none') return '';
  if (pattern === 'custom') {
    const expanded = expandTokens(customPattern, meeting).trim();
    if (!expanded) return '';
    // Sanitise each segment individually so '/' keeps its meaning as a
    // separator while illegal characters inside a segment are replaced.
    // Use sanitizeSegment (not sanitizeFilename) so empty segments are dropped,
    // not replaced with 'Untitled'.
    return expanded.split('/').map((s) => sanitizeSegment(s)).filter(Boolean).join('/');
  }
  if (!parts) return '';
  if (pattern === 'day') return parts.date;
  if (pattern === 'month') return `${parts.year}-${parts.month}`;
  if (pattern === 'year-month') return `${parts.year}/${parts.month}`;
  return `${parts.year}/${parts.quarter}`;
}

export function composePath(opts: {
  baseFolder: string;
  subfolder: SubfolderPattern;
  customSubfolder: string;
  filenamePattern: string;
  meeting: MeetingRow;
  /** Tracks collisions across every composePath call this run. Holds
   *  NORMALISED KEYS produced by `pathKey`, never literal paths — the
   *  filesystems this plugin runs on (macOS/Windows) are case-insensitive,
   *  and macOS also normalises Unicode in filenames, so two distinct JS
   *  strings can be the same file on disk. Adding a raw path here instead
   *  of `pathKey(path)` silently reopens that bug: the guard would compare
   *  strings the filesystem doesn't, and a second meeting could resolve to
   *  the same file as the first, overwriting it. */
  used: Set<string>;
}): string {
  const folderParts = opts.baseFolder
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => sanitizeSegment(s))
    .filter(Boolean);

  const sub = subfolderFor(opts.subfolder, opts.customSubfolder, opts.meeting);
  if (sub) folderParts.push(...sub.split('/').filter(Boolean));

  const stem = composeStem(opts.filenamePattern, opts.meeting);
  const folder = folderParts.join('/');

  let candidate = folder ? `${folder}/${stem}.md` : `${stem}.md`;

  if (opts.used.has(pathKey(candidate))) {
    // Two different meetings produced the same path this run (identical title
    // AND identical second, or a pattern that drops the timestamp). Without a
    // discriminator the second write silently overwrites the first.
    // Extend the discriminator progressively: first 8 chars of ID, then more,
    // then a counter suffix, until we find an unused path.
    let suffix = '';
    for (let i = 8; i <= opts.meeting.id.length; i++) {
      suffix = opts.meeting.id.slice(0, i);
      const discriminated = `${stem}-${suffix}`;
      candidate = folder ? `${folder}/${discriminated}.md` : `${discriminated}.md`;
      if (!opts.used.has(pathKey(candidate))) break;
    }
    // If even the full ID wasn't enough (highly unlikely), fall back to counter
    if (opts.used.has(pathKey(candidate))) {
      let counter = 1;
      while (true) {
        const discriminated = `${stem}-${opts.meeting.id}-${counter}`;
        candidate = folder ? `${folder}/${discriminated}.md` : `${discriminated}.md`;
        if (!opts.used.has(pathKey(candidate))) break;
        counter++;
      }
    }
  }
  opts.used.add(pathKey(candidate));
  return candidate;
}
