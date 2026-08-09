/** Order matters: an explicit human correction in Wispr must beat
 *  automatic inference. Verified against real speakerMap payloads. */
const PRECEDENCE = ['user', 'consensus', 'mic', 'dom', 'llm'] as const;

interface Person { name?: unknown }
interface SpeakerMap {
  people?: Record<string, Person>;
  assignments?: Record<string, Record<string, unknown>>;
}

export function resolveSpeakers(speakerMapJson: string | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!speakerMapJson) return out;

  let parsed: SpeakerMap;
  try {
    parsed = JSON.parse(speakerMapJson) as SpeakerMap;
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;

  const people = parsed.people ?? {};
  const assignments = parsed.assignments ?? {};

  for (const [rawId, assignment] of Object.entries(assignments)) {
    const id = Number(rawId);
    if (!Number.isInteger(id)) continue;
    if (!assignment || typeof assignment !== 'object') continue;

    for (const key of PRECEDENCE) {
      const personId = assignment[key];
      if (typeof personId !== 'string' || !personId) continue;
      const name = people[personId]?.name;
      if (typeof name === 'string' && name.trim()) {
        out.set(id, name.trim());
        break;
      }
    }
  }
  return out;
}

export function speakerName(speakers: Map<number, string>, id: number | null): string {
  if (id === null || !Number.isInteger(id)) return 'Unknown Speaker';
  return speakers.get(id) ?? `Speaker ${id}`;
}
