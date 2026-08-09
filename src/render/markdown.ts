import type { MeetingRow, TranscriptSegment } from '../types';
import { speakerName } from '../wispr/speakers';

export interface RenderOptions {
  resolveSpeakerNames: boolean;
  summaryMode: 'callout' | 'heading' | 'omit';
  transcriptLink?: string;
}

/** Wispr stores "2026-08-06 06:51:41.341 +00:00". V8 happens to parse that,
 *  but the behaviour is implementation-defined, so normalise to ISO first. */
export function parseWisprDate(value: string | null): Date | null {
  if (!value) return null;
  const iso = value.trim().replace(' ', 'T').replace(/\s+/g, '').replace(/\+00:00$/, 'Z');
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return d;
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Epoch milliseconds for a Wispr timestamp, or null if unparseable.
 *  Used for watermark comparison: Wispr's format is fixed-width, so string
 *  comparison happens to work while every row shares one UTC offset, but it
 *  silently inverts across offsets (08:00 -05:00 is later than 12:00 +00:00,
 *  yet sorts earlier as a string). */
export function wisprDateToEpoch(value: string | null): number | null {
  const d = parseWisprDate(value);
  return d ? d.getTime() : null;
}

export function formatDuration(startMs: number, endMs: number): string {
  // Floor, not round: a 5m50s call reads as "5m". Clamped to a 1m minimum so
  // very short recordings never render as "0m".
  const totalMinutes = Math.max(1, Math.floor((endMs - startMs) / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function yamlScalar(value: string): string {
  // Sanitise control characters BEFORE choosing a branch, in two ordered
  // passes, mirroring the CONTROL / WHITESPACE_CONTROLS split in
  // src/render/paths.ts exactly (that module's `clean()` is the other half
  // of this same contract):
  //
  //   1. Whitespace-like controls (TAB, LF, VT, FF, CR) collapse to a single
  //      space. A raw newline (or \r, \t, \v, \f) fails the safe-scalar
  //      regex below and falls into the quoted branch, which escapes
  //      backslashes and double quotes but does nothing about the newline
  //      itself — so it would survive, literally, inside the quotes.
  //   2. All other C0/C1 controls (NUL, BEL, etc.) are deleted entirely —
  //      they have no sensible visual representation and paths.ts already
  //      deletes them from filenames, so a title's filename and its
  //      frontmatter `title:` value must agree here too.
  //
  // Order matters: collapsing first and deleting second means "A<TAB>B"
  // becomes "A B" (a word boundary is preserved) rather than "AB" (words
  // fused together) — reversing the order would silently reintroduce a
  // filename/frontmatter mismatch from the opposite direction.
  //
  // Either failure mode is invalid YAML: Obsidian can't parse the
  // frontmatter block at all, wispr_id becomes unreadable, and every
  // subsequent sync duplicates the note because the vault index in main.ts
  // silently misses that file. A raw NUL or other unprintable byte reaching
  // the frontmatter is the same corruption path Stage 1 fixed for the
  // watermark — this sanitising is not cosmetic.
  /* eslint-disable-next-line no-control-regex -- deliberately stripping controls */
  const sanitized = value
    .replace(/\r\n|\r|\n|\t|\x0B|\x0C/g, ' ')
    .replace(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, '');
  // Quote when the value could change YAML meaning.
  if (/^[\w][\w .,'()&/-]*$/.test(sanitized) && !/: |#/.test(sanitized)) return sanitized;
  return `"${sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function title(meeting: MeetingRow): string {
  const t = (meeting.title ?? '').trim();
  return t || 'Untitled meeting';
}

function frontmatter(
  meeting: MeetingRow,
  speakers: Map<number, string>,
  type: 'note' | 'transcript'
): string {
  const created = parseWisprDate(meeting.createdAt);
  const updated = parseWisprDate(meeting.modifiedAt);

  const lines = [
    '---',
    `wispr_id: ${meeting.id}`,
    `title: ${yamlScalar(title(meeting))}`,
    `type: ${type}`,
  ];
  if (created) lines.push(`created: ${created.toISOString()}`);
  if (updated) lines.push(`updated: ${updated.toISOString()}`);
  if (created && meeting.endedAt) {
    lines.push(`duration: ${formatDuration(created.getTime(), meeting.endedAt)}`);
  }
  const names = [...speakers.values()].sort((a, b) => a.localeCompare(b));
  if (names.length) {
    lines.push('speakers:');
    for (const n of names) lines.push(`  - ${yamlScalar(n)}`);
  }
  lines.push('source: wispr-flow', '---', '');
  return lines.join('\n');
}

function substituteSpeakers(
  text: string,
  speakers: Map<number, string>,
  enabled: boolean
): string {
  if (!enabled) return text;
  return text.replace(/<@speaker:(\d+)>/g, (_m, id) => speakerName(speakers, Number(id)));
}

/** Strip a leading thematic break (first non-blank line if it's 3+ dashes/stars/underscores). */
function stripLeadingThematicBreak(body: string): string {
  const lines = body.split(/\r?\n/);
  const firstNonBlank = lines.findIndex((l) => l.trim() !== '');
  if (firstNonBlank !== -1 && /^(?:\-{3,}|\*{3,}|_{3,})[ \t]*$/.test(lines[firstNonBlank])) {
    return [...lines.slice(0, firstNonBlank), ...lines.slice(firstNonBlank + 1)].join('\n');
  }
  return body;
}

/** Split text at the first h3+ heading (SECTIONS boundary).
 *  Used only by the fallback summary path (see renderNote below); it does
 *  not back parseToggleBlock, which keeps its own copy of the boundary
 *  logic alongside its title/first-line handling. Editing this helper does
 *  not change parseToggleBlock's behaviour. */
function splitAtSections(text: string): { lead: string; sections: string } {
  const lines = text.trim().split(/\r?\n/);
  const sectionsIdx = lines.findIndex((l) => /^#{3,6}\s+/.test(l));

  if (sectionsIdx === -1) {
    // No sections found; entire text is lead.
    return { lead: lines.join('\n').replace(/^\s+|\s+$/g, ''), sections: '' };
  }

  const lead = lines.slice(0, sectionsIdx).join('\n').replace(/^\s+|\s+$/g, '');
  const sections = lines.slice(sectionsIdx).join('\n').replace(/^\s+|\s+$/g, '');
  return { lead, sections };
}

/** Parse a :::toggle block into { title, summary, sections } for rendering. */
function parseToggleBlock(inner: string): { title: string; summary: string; sections: string } {
  const lines = inner.trim().split(/\r?\n/);
  const firstNonBlank = lines.findIndex((l) => l.trim() !== '');

  // Find SECTIONS boundary (first line matching ^#{3,6}\s).
  const sectionsIdx = lines.findIndex((l) => /^#{3,6}\s+/.test(l));

  // If SECTIONS is the first non-blank line, entire block is SECTIONS.
  if (sectionsIdx === firstNonBlank && sectionsIdx !== -1) {
    return { title: 'Details', summary: '', sections: lines.slice(sectionsIdx).join('\n').replace(/^\s+|\s+$/g, '') };
  }

  // Extract TITLE, SUMMARY, SECTIONS.
  let title = 'Details';
  let titleIdx = firstNonBlank !== -1 ? firstNonBlank : 0;

  // TITLE = first non-blank line if it is an ATX heading (any h1-h6).
  if (firstNonBlank !== -1 && /^#{1,6}\s+/.test(lines[firstNonBlank])) {
    title = lines[firstNonBlank].replace(/^#{1,6}\s+/, '').trim();
    titleIdx = firstNonBlank + 1;
  }

  let summary = '';
  let sections = '';

  if (sectionsIdx !== -1) {
    // SUMMARY = content between TITLE and SECTIONS boundary.
    const summaryLines = lines.slice(titleIdx, sectionsIdx);
    summary = summaryLines.join('\n').replace(/^\s+|\s+$/g, '');
    // SECTIONS = boundary through end.
    const sectionsLines = lines.slice(sectionsIdx);
    sections = sectionsLines.join('\n').replace(/^\s+|\s+$/g, '');
  } else {
    // No SECTIONS boundary found; everything after TITLE is SUMMARY.
    const summaryLines = lines.slice(titleIdx);
    summary = summaryLines.join('\n').replace(/^\s+|\s+$/g, '');
  }

  return { title, summary, sections };
}

/** Wispr wraps the summary in a `:::toggle` directive block. Obsidian has no
 *  such syntax, so map it onto a collapsible callout (or flatten/drop it). */
function convertToggles(body: string, mode: RenderOptions['summaryMode']): string {
  return body.replace(
    /^:::toggle[ \t]*\r?\n([\s\S]*?)^:::[ \t]*$/gm,
    (_match, inner: string) => {
      const { title, summary, sections } = parseToggleBlock(inner);

      if (mode === 'omit') {
        // Only sections; drop title and summary (data-loss guard).
        return sections;
      }

      if (mode === 'heading') {
        // Plain heading, summary, sections at top level.
        const parts: string[] = [];
        parts.push(`## ${title}`);
        if (summary) parts.push('', summary);
        if (sections) parts.push('', sections);
        return parts.join('\n');
      }

      // mode === 'callout'
      // Quote only the summary; promote sections to top level.
      const parts: string[] = [];
      const quoted = summary
        ? summary.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
        : '';
      parts.push(`> [!summary]- ${title}`, quoted);
      if (sections) parts.push('', sections);
      return parts.join('\n');
    }
  );
}

export function renderNote(
  meeting: MeetingRow,
  speakers: Map<number, string>,
  opts: RenderOptions
): string {
  let body = meeting.notes ?? '';
  body = stripLeadingThematicBreak(body);
  body = convertToggles(body, opts.summaryMode);
  body = substituteSpeakers(body, speakers, opts.resolveSpeakerNames);
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  // If body is empty after all processing and summary exists, render the summary as fallback.
  if (!body && meeting.summary?.trim()) {
    const summary = meeting.summary.trim();
    const substituted = substituteSpeakers(summary, speakers, opts.resolveSpeakerNames);
    const { lead, sections } = splitAtSections(substituted);

    if (opts.summaryMode === 'omit') {
      // User explicitly asked to omit summaries; drop lead paragraph but keep sections.
      if (sections) {
        body = sections;
      } else {
        // No sections, so frontmatter-only outcome.
        const parts = [frontmatter(meeting, speakers, 'note')];
        if (opts.transcriptLink) parts.push(`[[${opts.transcriptLink}]]`, '');
        return parts.join('\n');
      }
    } else if (opts.summaryMode === 'heading') {
      // Render as plain heading: title, lead, then sections at top level.
      const parts: string[] = [];
      parts.push('## Flow Summary');
      if (lead) parts.push('', lead);
      if (sections) parts.push('', sections);
      body = parts.join('\n');
    } else {
      // callout mode: quote only the lead paragraph; sections at top level.
      const parts: string[] = [];
      const quoted = lead
        ? lead.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
        : '';
      parts.push('> [!summary]- Flow Summary', quoted);
      if (sections) parts.push('', sections);
      body = parts.join('\n');
    }
  }

  const parts = [frontmatter(meeting, speakers, 'note')];
  if (body) parts.push(body, '');
  if (opts.transcriptLink) parts.push(`[[${opts.transcriptLink}]]`, '');
  return parts.join('\n');
}

/** The transcript lines alone, with no frontmatter. Shared by the standalone
 *  transcript note and the `combined` mode that appends into the meeting note,
 *  so the two can never drift apart. */
export function renderTranscriptBody(
  segments: TranscriptSegment[],
  speakers: Map<number, string>,
  opts: RenderOptions
): string {
  return segments
    .map((s) => {
      const who = opts.resolveSpeakerNames
        ? speakerName(speakers, s.speakerId)
        : s.speakerId === null
          ? 'Unknown Speaker'
          : `<@speaker:${s.speakerId}>`;
      return `**${s.timestamp}** **${who}**: ${s.text.trim()}`;
    })
    .join('\n');
}

export function renderTranscript(
  meeting: MeetingRow,
  segments: TranscriptSegment[],
  speakers: Map<number, string>,
  opts: RenderOptions
): string {
  const body = renderTranscriptBody(segments, speakers, opts);
  const parts = [frontmatter(meeting, speakers, 'transcript')];
  if (body) parts.push(body, '');
  return parts.join('\n');
}
