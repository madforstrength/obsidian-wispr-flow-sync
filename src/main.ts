import {
  ButtonComponent,
  Notice,
  Plugin,
  PluginSettingTab,
  TFile,
  Platform,
  normalizePath,
  type SettingDefinitionItem,
} from 'obsidian';
import { DEFAULT_SETTINGS, type WisprSyncSettings } from './settings';
import { locateWispr } from './wispr/locator';
import { openWisprDatabase } from './wispr/db';
import { syncMeetings, type VaultAdapter } from './sync/engine';
import type { Logger } from './logging';
import type { SubfolderPattern } from './render/paths';

/** Filename only (not a path) for the debug log, written inside the plugin's
 *  own directory (`manifest.dir`) — never inside the vault's note tree, and
 *  never anywhere outside the plugin folder. Shared between the sink
 *  (debugLogPath) and the settings tab's "Copy logs" button so both agree on
 *  exactly one location. */
const DEBUG_LOG_FILENAME = 'wispr-flow-sync-debug.log';

/** Floor and ceiling for `syncIntervalSeconds`, enforced everywhere the
 *  setting is read OR written. `window.setInterval`'s delay argument is
 *  truncated to a 32-bit signed int internally; a delay above ~24.8 days
 *  (2^31 - 1 ms) wraps to a negative number, which browsers (and Electron,
 *  which Obsidian's desktop app embeds) treat as 0 — firing the interval
 *  back-to-back forever instead of on the interval the user asked for.
 *  86400 seconds (24h) is comfortably under that wrap point and is already
 *  a generous upper bound for a sync interval, so it costs nothing to clamp
 *  there defensively rather than anywhere near the actual overflow point. */
const MIN_SYNC_INTERVAL_SECONDS = 60;
const MAX_SYNC_INTERVAL_SECONDS = 86400;

function clampSyncIntervalSeconds(value: number): number {
  return Math.min(MAX_SYNC_INTERVAL_SECONDS, Math.max(MIN_SYNC_INTERVAL_SECONDS, value));
}

// NOTE: no ISSUES_URL constant here. This repo has no git remote and no
// public repository yet — Stage 3 owns creating it and submitting to the
// community plugin store (see docs/superpowers/STAGE-2-3-CARRY-FORWARD.md).
// A guessed or placeholder URL would 404 for every user who clicks it, which
// reads as "abandoned" — worse than no link at all. The Support section
// below states this in its description instead of linking anywhere; wire
// the real issues URL in once Stage 3 creates the repository.

export default class WisprFlowSyncPlugin extends Plugin {
  settings: WisprSyncSettings = { ...DEFAULT_SETTINGS };

  /** True while a runSync() is in flight. Guards against a second "Sync
   *  now" (double click, or re-triggering from the command palette) racing
   *  the first: both would compute the same vault index, resolve the same
   *  paths, and both call vault.create for a brand-new note, so one throws.
   *  Reset in runSync's finally so a thrown sync can never wedge this true
   *  forever. */
  private syncInProgress = false;

  /** True once onunload() has run. A sync started before the plugin was
   *  disabled keeps running after onunload (we don't attempt to cancel work
   *  mid-flight), so runSync checks this before persisting settings or
   *  showing notices, to avoid touching a dead plugin instance. */
  private unloaded = false;

  /** True once the "debug logging is unavailable" Notice has been shown.
   *  `manifest.dir` is optional in Obsidian's own typing (a plugin loaded in
   *  some unusual way can lack one), and without this flag debugSink() would
   *  otherwise pop that Notice on every single sync — a re-sync every few
   *  minutes on periodic sync would spam it. Shown once per plugin
   *  lifetime is enough to tell the user their setting isn't doing anything,
   *  without being annoying about it. */
  private debugLoggingUnavailableNoticeShown = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new WisprSyncSettingTab(this));
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => { void this.runSync(); },
    });
    this.addCommand({
      id: 'full-sync',
      name: 'Full sync (re-read everything)',
      callback: () => { void this.runSync({ fullSync: true }); },
    });

    // registerInterval hands the id to Obsidian for cleanup on unload; it
    // cannot be rescheduled in place. So if the user changes syncIntervalSeconds
    // or toggles periodicSyncEnabled, the new value only takes effect once
    // this onload() runs again (disable/re-enable the plugin, or restart
    // Obsidian). The settings tab's description says this explicitly so the
    // user isn't left wondering why nothing changed.
    if (this.settings.periodicSyncEnabled) {
      const ms = clampSyncIntervalSeconds(this.settings.syncIntervalSeconds) * 1000;
      this.registerInterval(window.setInterval(() => { void this.runSync(); }, ms));
    }
  }

  onunload(): void {
    this.unloaded = true;
  }

  async loadSettings(): Promise<void> {
    // onload awaits this directly, so it must never reject: a rejecting
    // onload can leave the plugin half-initialised (settings tab and command
    // never registered, with no indication to the user why). Fall back to
    // defaults and surface the failure instead of throwing.
    try {
      // loadData() is typed `any`; narrow it at the boundary so the spread
      // below is a checked merge rather than an unsafe assignment.
      const stored = (await this.loadData()) as Partial<WisprSyncSettings> | null;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
    } catch (err) {
      console.error('[wispr-flow-sync] failed to load settings, using defaults', err);
      this.settings = { ...DEFAULT_SETTINGS };
      new Notice('Wispr Flow Sync: could not load settings; using defaults.', 10_000);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Persist settings from a UI handler (a Setting's onChange/onClick)
   *  instead of calling saveSettings() directly. Obsidian's Setting API
   *  never awaits these handlers itself, so each one is its own async entry
   *  point: an uncaught rejection inside it becomes an unhandled promise
   *  rejection rather than propagating anywhere, and surfaces to the user as
   *  an opaque Obsidian-level error with no indication it came from this
   *  plugin. Containing the error here and telling the user their setting
   *  did not save keeps every entry point self-contained. */
  async persist(): Promise<void> {
    try {
      await this.saveSettings();
    } catch (err) {
      console.error('[wispr-flow-sync] failed to save settings', err);
      new Notice('Wispr Flow Sync: could not save that setting.', 10_000);
    }
  }

  /** Index existing notes by BOTH their wispr_id and type frontmatter so
   *  renames and folder moves update in place instead of duplicating. A
   *  meeting's note and its transcript share the same wispr_id, differing
   *  only by `type:`, so the index key must be the composite of both —
   *  otherwise a note lookup could resolve to the transcript's path (or vice
   *  versa) and the engine would silently overwrite one with the other.
   *
   *  Not private, so a test can build one directly and exercise `write`'s
   *  overwrite-protection (fix 6) and the duplicate-index detection (fix 7)
   *  without going through a full runSync() — mirrors why debugLogPath()
   *  below is exposed the same way. `log` is the same debug sink runSync
   *  already built for this run (or undefined when disabled); threading it
   *  through lets duplicate-index detection land in the same debug log
   *  file as everything else this run logs. */
  buildVaultAdapter(log?: Logger): VaultAdapter {
    const index = new Map<string, string>();
    // Tracks how many markdown files map to the same `${wispr_id}:${type}`
    // key. Stage 1 flagged "last-write-wins on duplicate id:type — warn
    // rather than silently picking one" as a carry-forward item; this is
    // that warning. Deliberately does NOT try to decide which file is
    // canonical — there's no principled way to choose from frontmatter
    // alone, and guessing wrong would be worse than staying silent about
    // which one "wins" (index.set below still picks one, unchanged from
    // before this fix; only the silence is fixed).
    const duplicateCounts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      // getFileCache() can return undefined for a file Obsidian has not
      // finished indexing yet (e.g. right after vault load, or a large bulk
      // change just happened). Such a file is silently excluded from the
      // index below. The write path then finds a file already at the
      // recomputed path whose frontmatter it cannot read, treats it as "not
      // ours", and refuses to overwrite it — recording an error for that
      // meeting rather than destroying content it cannot identify. This
      // self-heals: once the cache catches up, the next sync reads the
      // frontmatter, resolves the meeting normally, and updates in place.
      // Asserted to just the two keys read below, not Record<string, unknown>:
      // FrontMatterCache is an `any`-valued index signature, so a Record cast
      // is a no-op that leaves `id`/`type` as `any`.
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
        | { wispr_id?: unknown; type?: unknown }
        | undefined;
      const id = frontmatter?.['wispr_id'];
      const type = frontmatter?.['type'];
      if (typeof id === 'string' && id && (type === 'note' || type === 'transcript')) {
        const key = `${id}:${type}`;
        duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
        index.set(key, file.path);
      }
    }

    let duplicateKeysFound = 0;
    for (const [key, count] of duplicateCounts) {
      if (count <= 1) continue;
      duplicateKeysFound++;
      const [id, type] = key.split(':');
      // Content-free: a meeting id, a fixed literal ('note'/'transcript'),
      // and an integer count — nothing derived from meeting content.
      log?.(`duplicate vault index entry: id=${id} type=${type} count=${count}`);
    }
    if (duplicateKeysFound > 0 && !this.unloaded) {
      new Notice(
        `Wispr Flow Sync: found ${duplicateKeysFound} duplicate note/transcript ID(s) in ` +
          'your vault — only one copy of each was used. Enable debug logging and sync again ' +
          'for details.',
        10_000
      );
    }

    return {
      findByWisprId: (id, type) => index.get(`${id}:${type}`) ?? null,
      write: async (path, content) => {
        const normalized = normalizePath(path);
        const dir = normalized.split('/').slice(0, -1).join('/');
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
          await this.app.vault.createFolder(dir).catch(() => undefined);
        }
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof TFile) {
          // Never overwrite a file this plugin did not create for THIS
          // meeting/type. A composed path can collide with a note the user
          // wrote by hand (or with a different meeting's note, if settings
          // or vault state produced an unexpected clash) — without this
          // check `modify()` below would destroy content this plugin never
          // owned. The composed `content` always carries its own
          // `wispr_id`/`type` frontmatter (see render/markdown.ts), so
          // comparing against the EXISTING file's frontmatter is enough to
          // tell "ours, being updated" apart from "not ours" without a
          // second parameter on this method.
          const existingFrontmatter = this.app.metadataCache.getFileCache(existing)?.frontmatter as
            | { wispr_id?: unknown; type?: unknown }
            | undefined;
          const existingId = existingFrontmatter?.['wispr_id'];
          const existingType = existingFrontmatter?.['type'];
          const newId = content.match(/^wispr_id: (.+)$/m)?.[1]?.trim();
          const newType = content.match(/^type: (.+)$/m)?.[1]?.trim();
          const sameMeeting =
            typeof existingId === 'string' &&
            existingId === newId &&
            typeof existingType === 'string' &&
            existingType === newType;
          if (!sameMeeting) {
            throw new Error(
              `Refusing to overwrite "${normalized}" — it already exists and is not a note ` +
                'this plugin created for this meeting.'
            );
          }
          await this.app.vault.modify(existing, content);
        } else {
          await this.app.vault.create(normalized, content);
        }
      },
    };
  }

  /** Absolute (vault-relative-to-adapter) path of the debug log, inside this
   *  plugin's own directory — never inside the note tree the sync writes
   *  to. Exposed (not private) so the settings tab's "Copy logs" button
   *  reads from the exact same location this writes to. Only meaningful
   *  when `manifest.dir` is set; see debugSink() for what happens when it
   *  is not. */
  debugLogPath(): string {
    return `${this.manifest.dir}/${DEBUG_LOG_FILENAME}`;
  }

  /** Reads the debug log via the vault adapter (not Node fs — this must
   *  stay usable on mobile-shaped code paths even though the plugin itself
   *  is desktop-only) and copies it to the clipboard, for the settings
   *  tab's "Copy logs" button. A missing file (never enabled logging, or
   *  nothing synced yet) and a read that throws both surface as their own
   *  Notice instead of throwing or silently doing nothing. A file that
   *  exists but is empty or whitespace-only gets the same treatment: there
   *  is nothing useful to put on the clipboard, so this tells the user that
   *  instead of "succeeding" with an empty clipboard and a misleading
   *  success Notice. */
  async copyLogsToClipboard(): Promise<void> {
    try {
      const content = await this.app.vault.adapter.read(this.debugLogPath());
      if (!content.trim()) {
        new Notice('Wispr Flow Sync: log file is empty — nothing to copy.');
        return;
      }
      await navigator.clipboard.writeText(content);
      new Notice('Wispr Flow Sync: logs copied to clipboard.');
    } catch {
      new Notice('Wispr Flow Sync: no log file found. Enable debug logging and run a sync first.');
    }
  }

  /** Builds a fresh sink each call so a debug-logging toggle flipped between
   *  syncs takes effect on the very next run. Returns undefined when
   *  disabled, so callers can use `log?.(...)` and pass `log` straight
   *  through to syncMeetings without a branch.
   *
   *  `manifest.dir` is OPTIONAL per Obsidian's own typing. Without it, the
   *  log path becomes the literal string `"undefined/wispr-flow-sync-debug.log"`
   *  and every append fails ENOENT — silently, since the write is fire-
   *  and-forget (see below). Rather than build a sink that pretends to work
   *  while doing nothing, return undefined here too, and tell the user once
   *  via Notice so "enable debug logging" doesn't look like it took effect
   *  when it didn't.
   *
   *  *** PRIVACY BOUNDARY, NOT A CONVENIENCE ***
   *  This sink lands inside the user's vault. The engine (see sync/engine.ts)
   *  only ever interpolates a meeting id, an integer count, a user-authored
   *  settings string, or a fixed literal into what it logs — never meeting
   *  content. This method must not add anything beyond that: the run-start/
   *  run-end markers below carry only counts and fixed literals, matching
   *  the same rule. */
  private debugSink(): Logger | undefined {
    if (!this.settings.enableDebugLogging) return undefined;
    if (!this.manifest.dir) {
      if (!this.debugLoggingUnavailableNoticeShown) {
        this.debugLoggingUnavailableNoticeShown = true;
        new Notice(
          'Wispr Flow Sync: debug logging is enabled but unavailable (this plugin has no ' +
            'known directory). No log file will be written.',
          10_000
        );
      }
      return undefined;
    }
    const file = this.debugLogPath();
    // The engine (sync/engine.ts) already wraps whatever sink we pass here
    // with withPrefix('sync', ...), which both prefixes every message and
    // isolates a throwing sink so it can never take down a sync. Wrapping
    // again here would double the prefix ("[sync] [sync] ...").
    return (message: string) => {
      const line = `${new Date().toISOString()} ${message}\n`;
      void this.app.vault.adapter.append(file, line).catch(() => undefined);
    };
  }

  async runSync(opts: { fullSync?: boolean } = {}): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice('Wispr Flow Sync requires the desktop app.');
      return;
    }

    if (this.syncInProgress) {
      new Notice('Wispr Flow Sync: a sync is already running.');
      return;
    }
    this.syncInProgress = true;

    const log = this.debugSink();
    log?.(opts.fullSync ? 'run start: full sync' : 'run start');

    try {
      const located = await locateWispr(this.settings.wisprDataFolder || null);
      if (!located.ok) {
        if (!this.unloaded) new Notice(`Wispr Flow Sync: ${located.error}`, 10_000);
        log?.('run end: could not locate Wispr Flow');
        return;
      }

      if (!this.unloaded) new Notice('Wispr Flow Sync: syncing…');
      try {
        // Full sync re-reads everything by treating the watermark as absent
        // for THIS RUN ONLY. `runSettings` is a shallow copy, so
        // this.settings — and whatever persist() later writes from it — is
        // never mutated by the attempt itself.
        const runSettings = opts.fullSync
          ? { ...this.settings, latestSyncWatermark: null }
          : this.settings;

        const report = await syncMeetings({
          vault: this.buildVaultAdapter(log),
          settings: runSettings,
          databasePath: located.paths.database,
          meetingsDir: located.paths.meetingsDir,
          openDatabase: openWisprDatabase,
          log,
        });

        // Logged unconditionally (even if the plugin was disabled while this
        // sync was in flight) — it's a diagnostic write to a file, not a
        // settings persist or a Notice, so the onunload() guard below does
        // not need to gate it.
        log?.(
          `run end: written=${report.written} transcripts=${report.transcripts} ` +
            `skipped=${report.skipped} errors=${report.errors.length}`
        );

        // The plugin may have been disabled while the sync above was in
        // flight. We don't cancel work mid-flight, but a dead instance must
        // not persist settings or pop notices, so bail before either.
        if (this.unloaded) return;

        if (report.watermark) {
          this.settings.latestSyncWatermark = report.watermark;
          await this.saveSettings();
        }
        if (!this.unloaded) {
          // Name up to a few failures BY TITLE. That is legitimate here —
          // this Notice is transient, on the user's own screen, showing
          // their own data — unlike the debug log file or console.error
          // below, neither of which may ever carry a title or a message;
          // see errorKind's doc comment in sync/engine.ts for why. Without
          // this, "N problem(s)" told the user something failed but never
          // which meeting, forcing them into devtools to find out.
          const uniqueFailedTitles = [...new Set(report.failedMeetingTitles ?? [])];
          const maxNamed = 3;
          const namedFailures = uniqueFailedTitles.slice(0, maxNamed);
          const remainingFailures = uniqueFailedTitles.length - namedFailures.length;
          new Notice(
            `Wispr Flow Sync: ${report.written} note(s), ${report.transcripts} transcript(s).` +
              (report.transcriptLinesSkipped > 0
                ? ` ${report.transcriptLinesSkipped} transcript line(s) skipped.`
                : '') +
              (report.errors.length ? ` ${report.errors.length} problem(s).` : '') +
              (namedFailures.length
                ? ` Failed: ${namedFailures.join(', ')}` +
                  (remainingFailures > 0 ? `, and ${remainingFailures} more.` : '.')
                : ''),
            10_000
          );
        }
        // Content-free, unlike report.errors: never a title or a `.message`
        // — only what SyncErrorDetail carries. console.error output is not
        // "the user's own screen" in the sense that justifies a title
        // elsewhere in this method: users paste devtools output into public
        // bug reports just as readily as a log file, which is exactly the
        // content this plugin's file sink was built to keep out of anything
        // that can leave the user's machine. See sync/engine.ts's errorKind
        // doc comment for the full reasoning.
        for (const d of (report.errorDetails ?? []).slice(0, 3)) {
          console.error('[wispr-flow-sync] error', { id: d.id, kind: d.kind, errorKind: d.errorKind });
        }
      } catch (err) {
        // Must never escape: an unhandled rejection here would surface as an
        // Obsidian-level error with no useful context. Log only the error's
        // constructor name to console — an unexpected exception's message
        // could embed a path or a title (see errorKind's doc comment in
        // sync/engine.ts for why that's not console-safe).
        console.error('[wispr-flow-sync] sync failed', (err as Error)?.constructor?.name ?? 'Error');
        log?.('run end: sync failed');
        if (!this.unloaded) {
          new Notice(`Wispr Flow Sync failed: ${(err as Error).message}`, 10_000);
        }
      }
    } finally {
      this.syncInProgress = false;
    }
  }
}

const SUBFOLDER_OPTIONS: Record<SubfolderPattern, string> = {
  none: 'None',
  day: 'Daily (YYYY-MM-DD)',
  month: 'Monthly (YYYY-MM)',
  'year-month': 'Year / month (YYYY/MM)',
  'year-quarter': 'Year / quarter (YYYY/QN)',
  custom: 'Custom pattern',
};

/** Text settings where blanking the field must restore the default rather
 *  than persist an empty string — an empty notes folder would silently write
 *  every note to the vault root. Mirrors the `v || DEFAULT_SETTINGS.x` guard
 *  each of these rows carried when the tab rendered itself imperatively. */
const BLANK_RESTORES_DEFAULT = new Set<string>([
  'notesFolder',
  'notesFilenamePattern',
  'transcriptsFolder',
  'transcriptFilenamePattern',
]);

class WisprSyncSettingTab extends PluginSettingTab {
  constructor(private plugin: WisprFlowSyncPlugin) {
    super(plugin.app, plugin);
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /** Persists one changed control. The imperative tab normalised each value
   *  inside its own onChange — clamping the numbers, restoring a default when
   *  a path was blanked, trimming the data folder. Those guards all live here
   *  now, so every write goes through exactly one place. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;

    let next: unknown = value;
    if (key === 'syncIntervalSeconds' || key === 'syncHistoryDays') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return; // ignore garbage, keep current
      next =
        key === 'syncIntervalSeconds'
          ? clampSyncIntervalSeconds(Math.trunc(parsed))
          : Math.max(0, Math.trunc(parsed));
    } else if (key === 'wisprDataFolder') {
      next = String(value).trim();
    } else if (BLANK_RESTORES_DEFAULT.has(key)) {
      next = String(value) || DEFAULT_SETTINGS[key as keyof WisprSyncSettings];
    }

    settings[key] = next;
    await this.plugin.persist();
    // Several rows gate on another row's value. The imperative tab re-ran
    // display() for that; refreshDomState re-evaluates every `disabled`
    // predicate below in place, without rebuilding the tab.
    this.refreshDomState();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const transcriptsOff = (): boolean => !s.syncTranscripts;
    const transcriptsFolderOff = (): boolean =>
      !s.syncTranscripts || s.transcriptHandling !== 'custom-location';

    return [
      {
        type: 'group',
        heading: 'Sync',
        items: [
          {
            name: 'Enable periodic sync',
            desc:
              'Automatically run "Sync now" on a timer. Takes effect after Obsidian reloads this ' +
              'plugin (toggle it off/on in Community plugins, or restart Obsidian) — an interval ' +
              'already scheduled cannot be rescheduled in place.',
            control: { type: 'toggle', key: 'periodicSyncEnabled' },
          },
          {
            name: 'Sync interval',
            desc:
              'Seconds between automatic syncs. Minimum 60, maximum 86400 (24 hours). Takes effect ' +
              'after Obsidian reloads the plugin.',
            control: {
              type: 'number',
              key: 'syncIntervalSeconds',
              min: MIN_SYNC_INTERVAL_SECONDS,
              max: MAX_SYNC_INTERVAL_SECONDS,
            },
          },
        ],
      },

      {
        type: 'group',
        heading: 'Notes',
        items: [
          {
            name: 'Sync notes',
            desc: 'Write a note for each meeting.',
            control: { type: 'toggle', key: 'syncNotes' },
          },
          {
            name: 'Notes folder',
            desc:
              'Where newly-synced meeting notes are saved. Changing this does not move notes that ' +
              'already exist — they stay where they are, including on a Full sync.',
            control: { type: 'text', key: 'notesFolder' },
          },
          {
            name: 'Notes subfolder organization',
            desc:
              'Nest newly-synced notes under a date-based subfolder inside the notes folder above. ' +
              'Existing notes are not moved into (or out of) a subfolder when this changes.',
            control: { type: 'dropdown', key: 'notesSubfolder', options: SUBFOLDER_OPTIONS },
          },
          {
            name: 'Notes custom subfolder pattern',
            desc:
              'Only used when subfolder organization above is "Custom pattern". ' +
              'Tokens: {title} {date} {time} {year} {month} {day} {quarter}.',
            control: {
              type: 'text',
              key: 'notesCustomSubfolder',
              disabled: () => s.notesSubfolder !== 'custom',
            },
          },
          {
            name: 'Notes filename pattern',
            desc:
              'Tokens: {title} {date} {time} {year} {month} {day} {quarter}. Applies to newly-' +
              'synced meetings — existing notes are not renamed when this changes.',
            control: { type: 'text', key: 'notesFilenamePattern' },
          },
          {
            name: 'Resolve speaker names',
            desc: 'Replace speaker placeholders with real names from Wispr. Applies to notes and transcripts alike.',
            control: { type: 'toggle', key: 'resolveSpeakerNames' },
          },
          {
            name: 'Flow Summary',
            desc: 'How the Flow-generated summary is rendered inside the note.',
            control: {
              type: 'dropdown',
              key: 'summaryMode',
              options: { callout: 'Collapsible callout', heading: 'Plain heading', omit: 'Omit' },
            },
          },
        ],
      },

      {
        type: 'group',
        heading: 'Transcripts',
        items: [
          {
            name: 'Sync transcripts',
            desc: 'Also sync each meeting\'s transcript (see "Transcript handling" below for where it lands).',
            control: { type: 'toggle', key: 'syncTranscripts' },
          },
          {
            name: 'Transcript source',
            desc: 'Refined is cleaner and diarized. Live is the real-time version.',
            control: {
              type: 'dropdown',
              key: 'transcriptSource',
              options: { refined: 'Refined', live: 'Live' },
              disabled: transcriptsOff,
            },
          },
          {
            name: 'Transcript handling',
            desc:
              'Custom location: a separate file in its own folder. Same location: a separate file ' +
              'beside the note. Combined: appended into the note under "## Transcript".',
            control: {
              type: 'dropdown',
              key: 'transcriptHandling',
              options: {
                'custom-location': 'Custom location',
                'same-location': 'Same location as note',
                combined: 'Combined into note',
              },
              disabled: transcriptsOff,
            },
          },
          {
            name: 'Transcripts folder',
            desc:
              'Only used when transcript handling above is "Custom location". Applies to newly-' +
              'synced meetings — existing transcripts are not moved when this changes.',
            control: { type: 'text', key: 'transcriptsFolder', disabled: transcriptsFolderOff },
          },
          {
            name: 'Transcripts subfolder organization',
            desc:
              'Only used when transcript handling above is "Custom location". Applies to newly-' +
              'synced meetings — existing transcripts are not moved when this changes.',
            control: {
              type: 'dropdown',
              key: 'transcriptsSubfolder',
              options: SUBFOLDER_OPTIONS,
              disabled: transcriptsFolderOff,
            },
          },
          {
            name: 'Transcripts custom subfolder pattern',
            desc:
              'Only used when transcript handling is "Custom location" and subfolder organization ' +
              'above is "Custom pattern".',
            control: {
              type: 'text',
              key: 'transcriptsCustomSubfolder',
              disabled: () => transcriptsFolderOff() || s.transcriptsSubfolder !== 'custom',
            },
          },
          {
            name: 'Transcript filename pattern',
            desc:
              'Tokens: {title} {date} {time} {year} {month} {day} {quarter}. Applies to newly-' +
              'synced meetings — existing transcripts are not renamed when this changes.',
            control: { type: 'text', key: 'transcriptFilenamePattern', disabled: transcriptsOff },
          },
        ],
      },

      {
        type: 'group',
        heading: 'Filtering',
        items: [
          {
            name: 'Sync history',
            desc: 'Only sync meetings created in the last N days. 0 means no limit.',
            control: { type: 'number', key: 'syncHistoryDays', min: 0 },
          },
          {
            name: 'Title filter',
            desc: 'Include or exclude meetings whose title contains a keyword.',
            control: {
              type: 'dropdown',
              key: 'titleFilterMode',
              options: { disabled: 'Disabled', include: 'Include matching', exclude: 'Exclude matching' },
            },
          },
          {
            name: 'Title filter keyword',
            desc: 'Case-insensitive. Only used when the title filter above is not "Disabled".',
            control: {
              type: 'text',
              key: 'titleFilterKeyword',
              disabled: () => s.titleFilterMode === 'disabled',
            },
          },
          {
            name: 'Include unfinalized meetings',
            desc: 'Sync meetings Wispr is still processing.',
            control: { type: 'toggle', key: 'includeUnfinalized' },
          },
        ],
      },

      {
        type: 'group',
        heading: 'Advanced',
        items: [
          {
            name: 'Wispr Flow data folder',
            desc: 'Leave empty to use the default location. Read-only; never modified.',
            control: {
              type: 'text',
              key: 'wisprDataFolder',
              placeholder: '~/Library/Application Support/Wispr Flow',
            },
          },
          {
            name: 'Reset sync watermark',
            desc:
              'Forget what has been synced so the next run re-reads every meeting from Wispr. For ' +
              'a one-off re-read without touching this setting, use the "Full sync" command ' +
              'instead. Either way, this only re-reads data from Wispr — it never moves or renames ' +
              'notes that already exist in your vault; the folder/filename settings above apply ' +
              'only to newly-synced meetings.',
            action: (el) => {
              new ButtonComponent(el).setButtonText('Reset').onClick(() => {
                this.plugin.settings.latestSyncWatermark = null;
                void this.plugin.persist();
                new Notice('Wispr Flow Sync: watermark reset.');
              });
            },
          },
        ],
      },

      {
        type: 'group',
        heading: 'Debugging',
        items: [
          {
            name: 'Enable debug logging',
            desc:
              `Writes a log to "${DEBUG_LOG_FILENAME}" inside this plugin's own folder (not your ` +
              'note tree). It records meeting ids, counts, and the settings above — never meeting ' +
              'titles, note bodies, or transcript text.',
            control: { type: 'toggle', key: 'enableDebugLogging' },
          },
          {
            name: 'Export settings as JSON',
            desc: 'Copy the current settings (including the sync watermark) to the clipboard, for diagnostics or backup.',
            action: (el) => {
              new ButtonComponent(el).setButtonText('Export').onClick(() => {
                void this.exportSettings();
              });
            },
          },
          {
            name: 'Copy logs to clipboard',
            desc: 'Copy the debug log file to the clipboard.',
            action: (el) => {
              new ButtonComponent(el).setButtonText('Copy logs').onClick(() => {
                void this.plugin.copyLogsToClipboard();
              });
            },
          },
        ],
      },

      // No issue-tracker link yet — see the NOTE near the top of this file for
      // why a placeholder URL is not an acceptable substitute.
      {
        type: 'group',
        heading: 'Support',
        items: [
          {
            name: 'Issue tracker',
            desc: 'The issue tracker link will be added here once this plugin is released.',
          },
        ],
      },
    ];
  }

  /** Copies the settings object verbatim (no transformation, watermark
   *  included — it's diagnostic) to the clipboard. Never a network call:
   *  navigator.clipboard.writeText only touches the OS clipboard. */
  private async exportSettings(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(this.plugin.settings, null, 2));
      new Notice('Wispr Flow Sync: settings copied to clipboard.');
    } catch (err) {
      console.error('[wispr-flow-sync] failed to export settings', err);
      new Notice('Wispr Flow Sync: could not copy settings to clipboard.');
    }
  }
}
