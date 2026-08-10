import type { MeetingRow } from '../types';
import type { WisprSyncSettings } from '../settings';
import type { WisprDb } from '../wispr/db';
import { listMeetings, probeSchema } from '../wispr/repository';
import { readTranscript } from '../wispr/transcript';
import { resolveSpeakers } from '../wispr/speakers';
import { renderNote, renderTranscript, renderTranscriptBody, wisprDateToEpoch } from '../render/markdown';
import { composePath, pathKey } from '../render/paths';
import { createdAfterFloor, matchesTitleFilter } from './filter';
import { NULL_LOGGER, withPrefix } from '../logging';

/** The error's constructor name (e.g. `TypeError`, `Error`), never its
 *  `.message`. A caught error's message is producer-controlled and, for a
 *  vault write failure in particular, can legitimately embed the path it
 *  failed to write — which can carry a meeting's title via the filename
 *  pattern. Rather than try to scrub that (fragile: real filenames come
 *  from composeStem's budget-based truncation, which doesn't necessarily
 *  match any string we could search for), the log simply never receives
 *  the message at all.
 *
 *  The full message (and the meeting's title) is still available to the
 *  user, but ONLY via `report.errors` and the completion Notice's named
 *  failures (see main.ts) — both rendered transiently on the user's own
 *  screen from their own data. It is NOT available via `console.error`:
 *  main.ts logs `report.errorDetails` there instead, which carries the same
 *  content-free shape as this file's log lines (meeting id, note/transcript
 *  kind, and this error's constructor name) — because devtools output gets
 *  copy-pasted into public bug reports just as easily as a log file would,
 *  and that is exactly the content this privacy boundary exists to keep out
 *  of anything that could leave the user's machine. */
function errorKind(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'Error';
}

export interface VaultAdapter {
  /** Existing path for this meeting's note or transcript, if the vault
   *  already has one. Keyed on BOTH id and kind: a note and its transcript
   *  share the same `wispr_id` in frontmatter (differing only by `type:`),
   *  so an id-only lookup could hand back the transcript's path when
   *  resolving the note (or vice versa), and the engine would silently
   *  overwrite one file's content with the other's. The plugin's real vault
   *  adapter must honour this two-part key. */
  findByWisprId(id: string, type: 'note' | 'transcript'): string | null;
  write(path: string, content: string): Promise<void>;
}

export interface SyncDeps {
  vault: VaultAdapter;
  settings: WisprSyncSettings;
  databasePath: string;
  meetingsDir: string;
  openDatabase(path: string): Promise<WisprDb>;
  /** Injected for testability; defaults to Date.now(). */
  nowMs?: number;
  /** Optional structured log sink. Only ever receives a meeting id, an
   *  integer count, a user-authored settings string, or a fixed literal —
   *  never meeting content. */
  log?: (message: string) => void;
}

/** Content-free counterpart to a `report.errors` entry: safe for any surface
 *  that is not strictly the user's own transient screen (console.error in
 *  particular — see errorKind's doc comment for why). Never a title or a
 *  `.message`. */
export interface SyncErrorDetail {
  id: string;
  kind: 'note' | 'transcript';
  errorKind: string;
}

export interface SyncReport {
  written: number;
  skipped: number;
  transcripts: number;
  /** Malformed transcript lines dropped by readTranscript, summed across
   *  every meeting synced this run. Wispr appends to ndjson files while
   *  recording, so a truncated final line is expected; surfacing the count
   *  keeps a partially-parsed transcript visible instead of looking clean. */
  transcriptLinesSkipped: number;
  watermark: string | null;
  /** Human-facing: `${title-or-id}[ (transcript)]: ${message}`. Intended for
   *  something shown on the user's own screen (the completion Notice,
   *  `report.errors` itself) — never written to a file or logged to the
   *  console. */
  errors: string[];
  /** One entry per failure in `errors`, same order, containing only what
   *  console.error and the debug-log file are allowed to see. */
  errorDetails: SyncErrorDetail[];
  /** Title (falling back to id) of each meeting that failed this run, same
   *  order as `errors`/`errorDetails` (a meeting can appear twice if both
   *  its transcript and its note failed). For the completion Notice to name
   *  a few failures by title — that Notice is transient and on the user's
   *  own screen showing their own data, so this is a legitimate use of the
   *  title, unlike the debug log or the console. */
  failedMeetingTitles: string[];
}

/** Wispr writes to flow.sqlite while we read it. Because we open with
 *  immutable=1 there is no locking, so a concurrent write can surface as a
 *  transient corruption or I/O error. Retry briefly before giving up. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        // window.setTimeout, not the bare global: Obsidian popout windows
        // each own their timer scope, and a timer scheduled on the wrong one
        // is cancelled when that window closes. This module is also unit
        // tested in a bare Node environment, which has no `window` — fall
        // back to globalThis there rather than throwing a ReferenceError.
        const schedule: (fn: () => void, ms: number) => unknown =
          typeof window === 'undefined' ? setTimeout : window.setTimeout.bind(window);
        await new Promise((r) => schedule(() => r(undefined), 100 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

export async function syncMeetings(deps: SyncDeps): Promise<SyncReport> {
  const { vault, settings } = deps;
  // INVARIANT: every value interpolated into a log line below is either a
  // meeting id, an integer count, a user-authored settings string (a folder
  // path or pattern the user typed into settings, before any token
  // expansion — a literal `{title}` in a pattern is a template, not
  // content), or a fixed literal. Nothing derived from meeting content
  // (title, note body, summary, transcript text, speaker name) or from a
  // path composed FROM that content ever reaches this sink — this log is
  // written into a file inside the user's vault, and meeting content is
  // confidential.
  //
  // Wrapped once here (rather than trusting every caller to do it) so a
  // throwing sink can never break a sync regardless of what the caller
  // passes in.
  const log = withPrefix('sync', deps.log ?? NULL_LOGGER);
  const report: SyncReport = {
    written: 0,
    skipped: 0,
    transcripts: 0,
    transcriptLinesSkipped: 0,
    watermark: null,
    errors: [],
    errorDetails: [],
    failedMeetingTitles: [],
  };

  log(`database: ${deps.databasePath}`);
  // Settings are logged ONCE per run, as the user authored them — before
  // any `{title}`/`{date}`/etc. token expansion. This is the diagnostic
  // substitute for logging a per-meeting composed path (which would leak
  // content: `{title}` can appear in customSubfolder just as easily as in
  // a filename pattern, so nothing derived from an expanded path is safe).
  log(
    `settings: syncNotes=${settings.syncNotes} notesFolder=${settings.notesFolder} ` +
      `notesSubfolder=${settings.notesSubfolder} notesCustomSubfolder=${settings.notesCustomSubfolder} ` +
      `notesFilenamePattern=${settings.notesFilenamePattern} syncTranscripts=${settings.syncTranscripts} ` +
      `transcriptHandling=${settings.transcriptHandling} transcriptsFolder=${settings.transcriptsFolder} ` +
      `transcriptsSubfolder=${settings.transcriptsSubfolder} ` +
      `transcriptsCustomSubfolder=${settings.transcriptsCustomSubfolder} ` +
      `transcriptFilenamePattern=${settings.transcriptFilenamePattern}`
  );

  // Read everything up front, then close, then render and write. This keeps
  // the database open for the shortest possible window.
  let meetings: MeetingRow[];
  try {
    const since = settings.latestSyncWatermark;
    const createdAfter = createdAfterFloor(settings.syncHistoryDays, deps.nowMs ?? Date.now());
    log(`since=${since ?? 'null'} createdAfter=${createdAfter ?? 'null'}`);
    const result = await withRetry(async () => {
      const db = await deps.openDatabase(deps.databasePath);
      try {
        // Integer count or 'none' — never content. Distinguishes "Wispr has
        // no meetings" from "the WAL was not read", which are otherwise
        // indistinguishable in a bug report and were the whole reason the
        // pre-overlay data loss went unnoticed.
        log(`wal frames overlaid: ${db.walFrames ?? 'none'}`);
        const probe = await probeSchema(db);
        if (!probe.ok) return { missing: probe.missing, rows: [] as MeetingRow[] };
        const rows = await listMeetings(db, {
          since,
          includeUnfinalized: settings.includeUnfinalized,
          createdAfter,
        });
        return { missing: [] as string[], rows };
      } finally {
        await db.close();
      }
    });

    if (result.missing.length) {
      const message =
        `Wispr Flow's database is missing expected columns (${result.missing.join(', ')}). ` +
        `The app may have updated; please report this.`;
      report.errors.push(message);
      log(`error: ${message}`);
      return report;
    }
    meetings = result.rows;
    log(`meetings returned by query: ${meetings.length}`);
  } catch (err) {
    const message = `Could not read Wispr Flow's database: ${(err as Error).message}`;
    report.errors.push(message);
    log(`error: ${message}`);
    return report;
  }

  const renderOpts = {
    resolveSpeakerNames: settings.resolveSpeakerNames,
    summaryMode: settings.summaryMode,
  };

  // Title filtering happens here, in TypeScript, rather than in the SQL
  // query: it keeps LIKE-escaping out of the query and makes the matching
  // rule unit-testable in isolation (see filter.test.ts).
  const selected = meetings.filter((m) =>
    matchesTitleFilter(m, settings.titleFilterMode, settings.titleFilterKeyword)
  );
  log(`meetings surviving title filter: ${selected.length}`);

  // listMeetings orders by createdAt ASC, so modifiedAt is NOT monotonic
  // across this loop. Track the max locally and only publish it to the
  // report once the whole run is known to be clean (see below).
  //
  // Comparison happens on the parsed instant (epoch ms), not the raw string:
  // Wispr's "YYYY-MM-DD HH:MM:SS.sss +HH:MM" format only sorts correctly as
  // a string when every row shares the same UTC offset. maxModifiedAt still
  // holds the original string — that's what gets persisted and fed back into
  // the repository's `since` clause.
  let maxModifiedAt: string | null = null;
  let maxModifiedEpoch = -Infinity;

  // A single set threaded through every composePath call this run (notes AND
  // transcripts, across every meeting). Two different meetings landing on the
  // same computed path — same title/timestamp, or a pattern that drops the
  // discriminating token — would otherwise let the second write silently
  // clobber the first.
  const usedPaths = new Set<string>();

  // Pre-seed usedPaths with EVERY already-resolved path for EVERY selected
  // meeting before the write loop below even starts. Meetings are processed
  // in createdAt ASC order, so without this an earlier meeting could
  // freshly compute a path that a LATER meeting has already resolved via
  // findByWisprId (e.g. because the user moved/renamed that later meeting's
  // note), write there first, and then have the later meeting's resolved-
  // path write silently clobber it — content lost while `wroteSomething`
  // stays true for the earlier meeting, because collision detection only
  // ever consulted paths resolved SO FAR, not every path this run WILL
  // resolve to. Doing this pass up front, before any write happens, closes
  // that ordering gap regardless of which meeting is processed first.
  //
  // Mirrors the per-meeting gating below: a resolved path is only relevant
  // when the corresponding write is actually enabled, and `combined`
  // transcript handling never resolves a standalone transcript path at all
  // (see the loop below for why).
  for (const meeting of selected) {
    if (settings.syncTranscripts && settings.transcriptHandling !== 'combined') {
      const resolvedTranscriptPath = vault.findByWisprId(meeting.id, 'transcript');
      if (resolvedTranscriptPath) usedPaths.add(pathKey(resolvedTranscriptPath));
    }
    if (settings.syncNotes) {
      const resolvedNotePath = vault.findByWisprId(meeting.id, 'note');
      if (resolvedNotePath) usedPaths.add(pathKey(resolvedNotePath));
    }
  }

  for (const meeting of selected) {
    try {
      const speakers = resolveSpeakers(meeting.speakerMap);

      // Whether THIS meeting produced at least one successful write this
      // run (note or transcript). The watermark may only advance past a
      // meeting that actually landed something in the vault — see the
      // per-meeting gate below. Tracked generally (not special-cased on
      // syncNotes/syncTranscripts) so every combination — notes only,
      // transcripts only, both, or neither enabled — behaves correctly,
      // including the neither-enabled case where nothing is ever written.
      let wroteSomething = false;

      // Whether THIS meeting's transcript read hit any skipped (malformed
      // or truncated) lines. Tracked per meeting, not just globally in
      // report.transcriptLinesSkipped: see the per-meeting watermark gate
      // below for why.
      let meetingHasSkippedTranscriptLines = false;

      // Write the transcript FIRST. Only a successfully-written transcript
      // gets linked from the note — otherwise the note would point at a
      // file that was never created. A transcript failure is recorded as an
      // error but does not stop the note itself from being written.
      //
      // `combined` mode has no separate transcript file at all: the note IS
      // the transcript's carrier, so there is nothing to "write first" and
      // no link to set. Deliberately, `combined` never calls
      // vault.findByWisprId(meeting.id, 'transcript') either — a meeting may
      // have a leftover standalone transcript file from a previous run under
      // a different setting (this plugin never deletes vault content), but
      // resolving and reusing that path here would resurrect a second file
      // this mode is supposed to not have. That stale file is simply left
      // alone.
      let transcriptLink: string | undefined;
      let combinedTranscriptBody: string | undefined;
      if (settings.syncTranscripts) {
        const { segments, skipped } = await readTranscript(
          deps.meetingsDir,
          meeting.id,
          settings.transcriptSource
        );
        report.transcriptLinesSkipped += skipped;
        if (skipped > 0) meetingHasSkippedTranscriptLines = true;

        if (segments.length) {
          if (settings.transcriptHandling === 'combined') {
            const body = renderTranscriptBody(segments, speakers, renderOpts);
            if (body) {
              combinedTranscriptBody = body;
              // Counting happens later, alongside the note write: `combined`
              // has no file of its own, so the transcript is only actually
              // persisted if the note carrying it is (see below).
            }
          } else {
            // A path resolved from the vault's existing index must ALSO be
            // recorded in usedPaths: composePath only self-registers a path
            // it computes fresh, so a resolved (moved/renamed) path was
            // previously invisible to collision detection. Without this, a
            // different meeting computing that same path fresh later in this
            // run could silently overwrite the resolved one.
            let transcriptPath = vault.findByWisprId(meeting.id, 'transcript');
            if (transcriptPath) {
              usedPaths.add(pathKey(transcriptPath));
            } else {
              // `same-location` borrows the NOTES folder/subfolder but keeps
              // the TRANSCRIPT filename pattern, so the transcript lands
              // beside its note while staying distinguishable from it.
              transcriptPath = composePath({
                baseFolder:
                  settings.transcriptHandling === 'same-location'
                    ? settings.notesFolder
                    : settings.transcriptsFolder,
                subfolder:
                  settings.transcriptHandling === 'same-location'
                    ? settings.notesSubfolder
                    : settings.transcriptsSubfolder,
                customSubfolder:
                  settings.transcriptHandling === 'same-location'
                    ? settings.notesCustomSubfolder
                    : settings.transcriptsCustomSubfolder,
                filenamePattern: settings.transcriptFilenamePattern,
                meeting,
                used: usedPaths,
              });
            }
            try {
              await vault.write(
                transcriptPath,
                renderTranscript(meeting, segments, speakers, renderOpts)
              );
              report.transcripts++;
              wroteSomething = true;
              log(`wrote transcript for ${meeting.id}`);
              transcriptLink = transcriptPath.endsWith('.md')
                ? transcriptPath.slice(0, -3)
                : transcriptPath;
            } catch (err) {
              // User-facing (Notice, on the user's own screen): identify by
              // title, falling back to id, with the real message — that's
              // what actually helps someone reading about their own data.
              report.errors.push(
                `${meeting.title ?? meeting.id} (transcript): ${(err as Error).message}`
              );
              report.failedMeetingTitles.push(meeting.title ?? meeting.id);
              report.errorDetails.push({
                id: meeting.id,
                kind: 'transcript',
                errorKind: errorKind(err),
              });
              // Log-facing (a file written into the vault): id and error
              // KIND only — never the message. See errorKind's doc comment
              // for why the message itself is never safe to log here.
              log(`error writing transcript for ${meeting.id}: ${errorKind(err)}`);
            }
          }
        }
      }

      // A meeting counts as `written` only when its note was actually
      // written — a run with syncNotes off legitimately writes zero notes
      // even though transcripts (and the loop itself) succeeded.
      if (settings.syncNotes) {
        // See the transcript branch above for why a resolved path must
        // also be added to usedPaths.
        let notePath = vault.findByWisprId(meeting.id, 'note');
        if (notePath) {
          usedPaths.add(pathKey(notePath));
        } else {
          notePath = composePath({
            baseFolder: settings.notesFolder,
            subfolder: settings.notesSubfolder,
            customSubfolder: settings.notesCustomSubfolder,
            filenamePattern: settings.notesFilenamePattern,
            meeting,
            used: usedPaths,
          });
        }
        let noteContent = renderNote(meeting, speakers, { ...renderOpts, transcriptLink });
        if (combinedTranscriptBody) {
          noteContent = `${noteContent.replace(/\s+$/, '')}\n\n## Transcript\n\n${combinedTranscriptBody}\n`;
        }
        await vault.write(notePath, noteContent);
        report.written++;
        wroteSomething = true;
        log(`wrote note for ${meeting.id}`);
        // A `combined` transcript has no file of its own — it only counts as
        // synced once the note carrying it has actually been written. If
        // this write had thrown, we'd never reach here, so a failed note
        // correctly leaves the embedded transcript uncounted too.
        if (combinedTranscriptBody) {
          report.transcripts++;
        }
      }

      // Gate the watermark contribution on this meeting having actually
      // written something AND its transcript read having been clean.
      //
      // The "wrote something" half: without it, a run where every write is
      // skipped by settings (e.g. syncNotes and syncTranscripts both
      // false) would still advance the watermark past a meeting whose
      // content was never synced — the exact "excluded forever" loss the
      // clean-run rule exists to prevent, reopened through a new door.
      //
      // The "clean transcript read" half: Wispr appends to its ndjson files
      // while recording, so a truncated final line is an expected,
      // transient condition for whichever meeting happens to be recording
      // right now — not a sign anything is actually wrong. This gate is
      // PER MEETING, not global: only the meeting that was mid-recording
      // sits out this round's watermark advance. Every other, cleanly-read
      // meeting still advances it normally. A global gate here would let
      // one perpetually-recording meeting block the watermark forever,
      // forcing a full-history rescan on every single run — the fix is
      // scoped to the one meeting actually affected. The next run re-reads
      // just that meeting's transcript once it's complete; that's cheap
      // because writes are idempotent (upsert by id).
      if (wroteSomething && !meetingHasSkippedTranscriptLines) {
        const epoch = wisprDateToEpoch(meeting.modifiedAt);
        if (epoch !== null && epoch > maxModifiedEpoch) {
          maxModifiedEpoch = epoch;
          maxModifiedAt = meeting.modifiedAt;
        }
      }
    } catch (err) {
      report.skipped++;
      // User-facing (Notice, on the user's own screen): identify by title,
      // falling back to id, with the real message — that's what actually
      // helps someone reading about their own data.
      report.errors.push(`${meeting.title ?? meeting.id}: ${(err as Error).message}`);
      report.failedMeetingTitles.push(meeting.title ?? meeting.id);
      report.errorDetails.push({ id: meeting.id, kind: 'note', errorKind: errorKind(err) });
      // Log-facing (a file written into the vault): id and error KIND
      // only — never the message. See errorKind's doc comment for why.
      //
      // This outer catch wraps the whole per-meeting body, but in practice
      // the note write is the only call in it that can throw (readTranscript
      // swallows its own I/O errors; resolveSpeakers/renderNote/composePath
      // never throw) — hence "writing note" rather than a generic label.
      log(`error writing note for ${meeting.id}: ${errorKind(err)}`);
    }
  }

  // Only advance the watermark when the run was fully clean. A conservative
  // (unmoved) watermark just costs a redundant re-scan next time, which is
  // harmless because writes are idempotent (upsert by id). An over-advanced
  // watermark is worse: the caller persists it, and any meeting that failed
  // this run would fall before the new "since" cutoff on every future run —
  // its note would never be created and the one error message that recorded
  // the failure disappears after this run ends, making the loss permanent
  // and invisible.
  //
  // transcriptLinesSkipped is deliberately NOT part of this global
  // condition — that gate is per-meeting, above, so one meeting's
  // truncated transcript can't block every other meeting's contribution to
  // maxModifiedAt. The total is still kept in the report for visibility.
  report.watermark = report.skipped === 0 && report.errors.length === 0 ? maxModifiedAt : null;

  log(
    `done: written=${report.written} skipped=${report.skipped} transcripts=${report.transcripts} ` +
      `transcriptLinesSkipped=${report.transcriptLinesSkipped} errors=${report.errors.length} ` +
      `watermark=${report.watermark ?? 'null'}`
  );

  return report;
}
