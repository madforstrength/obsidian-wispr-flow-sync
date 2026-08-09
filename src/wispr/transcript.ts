import type { TranscriptSegment } from '../types';
import { requireFs, requirePath } from '../node-runtime';

interface RawLine {
  timestamp?: unknown;
  text?: unknown;
  speaker?: { id?: unknown } | null;
  meta?: unknown;
  marker?: unknown;
}

/** Tolerant by design: Wispr appends to these files while recording, so the
 *  final line can be truncated mid-write. A bad line is skipped and counted,
 *  never fatal. */
export function parseNdjson(content: string): { segments: TranscriptSegment[]; skipped: number } {
  const segments: TranscriptSegment[] = [];
  let skipped = 0;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let parsed: RawLine;
    try {
      parsed = JSON.parse(line) as RawLine;
    } catch {
      skipped++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object') { skipped++; continue; }
    if ('meta' in parsed && parsed.meta !== undefined) continue;  // header line
    // Text wins over marker. A structural `marker` line (e.g. recording
    // paused) legitimately carries no text and must be skipped WITHOUT
    // counting as malformed. But a line carrying both a marker and real
    // text is real speech — checking marker first silently dropped it.
    if (typeof parsed.text !== 'string') {
      if ('marker' in parsed && parsed.marker !== undefined) continue;  // structural marker
      skipped++;
      continue;
    }

    const rawId = parsed.speaker?.id;
    segments.push({
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
      text: parsed.text.trim(),
      speakerId: typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : null,
    });
  }
  return { segments, skipped };
}

export async function readTranscript(
  meetingsDir: string,
  meetingId: string,
  source: 'refined' | 'live'
): Promise<{ segments: TranscriptSegment[]; skipped: number }> {
  const fs = requireFs();
  const path = requirePath();
  const file = path.join(meetingsDir, meetingId, `${source}.ndjson`);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { segments: [], skipped: 0 };
  }
  return parseNdjson(content);
}
