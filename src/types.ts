/** A row from Wispr's `Meetings` table. Columns absent in older/newer
 *  schema versions arrive as null — never assume presence. */
export interface MeetingRow {
  id: string;
  title: string | null;
  notes: string | null;
  summary: string | null;
  speakerMap: string | null;
  /** Wispr format: "2026-08-06 06:51:41.341 +00:00" */
  createdAt: string | null;
  modifiedAt: string | null;
  /** Epoch milliseconds. */
  endedAt: number | null;
  isDeleted: number;
  finalized: number;
}

export interface TranscriptSegment {
  /** As stored, e.g. "00:03". Not normalised. */
  timestamp: string;
  text: string;
  speakerId: number | null;
}
