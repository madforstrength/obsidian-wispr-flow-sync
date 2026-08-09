import type { SubfolderPattern } from './render/paths';
import type { TitleFilterMode } from './sync/filter';

export type TranscriptHandling = 'custom-location' | 'same-location' | 'combined';

export interface WisprSyncSettings {
  // --- Sync ---
  periodicSyncEnabled: boolean;
  /** Seconds between automatic syncs. */
  syncIntervalSeconds: number;

  // --- Notes ---
  syncNotes: boolean;
  notesFolder: string;
  notesSubfolder: SubfolderPattern;
  notesCustomSubfolder: string;
  notesFilenamePattern: string;

  // --- Transcripts ---
  syncTranscripts: boolean;
  transcriptHandling: TranscriptHandling;
  transcriptsFolder: string;
  transcriptsSubfolder: SubfolderPattern;
  transcriptsCustomSubfolder: string;
  transcriptFilenamePattern: string;
  transcriptSource: 'refined' | 'live';

  // --- Rendering ---
  resolveSpeakerNames: boolean;
  summaryMode: 'callout' | 'heading' | 'omit';

  // --- Filtering ---
  /** 0 means no limit. */
  syncHistoryDays: number;
  titleFilterMode: TitleFilterMode;
  titleFilterKeyword: string;
  includeUnfinalized: boolean;

  // --- Advanced / diagnostics ---
  wisprDataFolder: string;
  enableDebugLogging: boolean;

  /** Wispr-format timestamp of the newest modifiedAt synced so far. */
  latestSyncWatermark: string | null;
}

export const DEFAULT_SETTINGS: WisprSyncSettings = {
  periodicSyncEnabled: false,
  syncIntervalSeconds: 1800,

  syncNotes: true,
  // Defaults to a Wispr-specific subfolder: users may also run Granola, and
  // the same call can be captured by both tools.
  notesFolder: 'Meetings/Wispr',
  notesSubfolder: 'none',
  notesCustomSubfolder: '',
  notesFilenamePattern: '{title}-{date}_{time}',

  syncTranscripts: true,
  transcriptHandling: 'custom-location',
  transcriptsFolder: 'Meetings/Wispr/Transcripts',
  transcriptsSubfolder: 'none',
  transcriptsCustomSubfolder: '',
  transcriptFilenamePattern: '{title}-{date}_{time}-transcript',
  transcriptSource: 'refined',

  resolveSpeakerNames: true,
  summaryMode: 'callout',

  syncHistoryDays: 0,
  titleFilterMode: 'disabled',
  titleFilterKeyword: '',
  includeUnfinalized: false,

  wisprDataFolder: '',
  enableDebugLogging: false,

  latestSyncWatermark: null,
};
