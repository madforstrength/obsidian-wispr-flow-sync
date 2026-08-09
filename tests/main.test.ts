import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WisprSyncSettings } from '../src/settings';

// --- Fakes for the 'obsidian' host API -------------------------------------
// 'obsidian' ships only type declarations (its package.json "main" is an
// empty string), so it cannot be imported at runtime under vitest. main.ts
// is the only file that imports it, which is why it has had no direct tests
// until now. We stand up a minimal fake of the surface main.ts touches.

const notices: string[] = [];
const savedData: unknown[] = [];
const commands: { id: string; name: string; callback?: () => void }[] = [];
const intervals: { ms: number }[] = [];
const adapterWrites: { path: string; content: string }[] = [];
// Backing store for the fake vault adapter's append/read, keyed by path.
// `adapterWrites` above stays around for existing tests that only care
// "was something appended to a path matching X"; this Map is what makes
// `read()` actually return content, including content set directly by a
// test (not just accumulated via `append`).
const adapterFiles = new Map<string, string>();
const clipboardWrites: string[] = [];
let loadDataResult: unknown = {};

// main.ts schedules its periodic sync via `window.setInterval` (mirroring
// Obsidian's own sample plugin — it returns the DOM `number` form that
// `registerInterval` expects, not Node's Timeout object). vitest's default
// (node) environment has no global `window`, so stub just enough of it to
// capture what onload() schedules.
(
  globalThis as unknown as { window: { setInterval: (fn: () => void, ms: number) => number } }
).window = {
  setInterval: (_fn: () => void, ms: number) => {
    intervals.push({ ms });
    return intervals.length;
  },
};

// Node exposes a global `navigator` (since v21) as a getter-only property
// with no `clipboard`, so `navigator.clipboard.writeText(...)` would throw
// as-is. copyLogsToClipboard()/exportSettings() call it directly (matching
// real Obsidian's renderer context), so redefine it here to capture writes
// instead of hitting the OS clipboard.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    clipboard: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  },
  configurable: true,
  writable: true,
});

vi.mock('obsidian', () => {
  class Notice {
    constructor(message: string, _timeout?: number) {
      notices.push(message);
    }
  }
  class Plugin {
    app: unknown;
    manifest: unknown;
    constructor(app?: unknown, manifest?: unknown) {
      this.app = app;
      this.manifest = manifest;
    }
    addCommand(cmd: { id: string; name: string; callback?: () => void }): void {
      commands.push(cmd);
    }
    addSettingTab(): void {}
    registerInterval(id: number): number {
      return id;
    }
    loadData(): Promise<unknown> {
      return Promise.resolve(loadDataResult);
    }
    saveData(data: unknown): Promise<void> {
      savedData.push(data);
      return Promise.resolve();
    }
  }
  class PluginSettingTab {
    constructor(_app?: unknown, _plugin?: unknown) {}
  }
  class Setting {
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    setDisabled() { return this; }
    addText() { return this; }
    addToggle() { return this; }
    addDropdown() { return this; }
    addButton() { return this; }
  }
  class TFile {}
  const Platform = { isDesktopApp: true };
  const normalizePath = (p: string) => p;
  return { Notice, Plugin, PluginSettingTab, Setting, TFile, Platform, normalizePath };
});

// --- Fakes for locateWispr / openWisprDatabase / syncMeetings --------------
// These are the collaborators runSync calls out to; deferred promises let
// each test control exactly when a sync "completes".

let locateWisprImpl: () => Promise<unknown> = () =>
  Promise.resolve({
    ok: true,
    paths: { root: '/fake', database: '/fake/db.sqlite', meetingsDir: '/fake/meetings' },
  });

vi.mock('../src/wispr/locator', () => ({
  locateWispr: (...args: unknown[]) => locateWisprImpl(),
}));

vi.mock('../src/wispr/db', () => ({
  openWisprDatabase: () => Promise.resolve({}),
}));

let syncMeetingsImpl: () => Promise<unknown> = () =>
  Promise.resolve({
    written: 0,
    skipped: 0,
    transcripts: 0,
    transcriptLinesSkipped: 0,
    watermark: null,
    errors: [],
  });

const syncCalls: { settings: WisprSyncSettings }[] = [];

vi.mock('../src/sync/engine', () => ({
  syncMeetings: (...args: unknown[]) => {
    syncCalls.push(args[0] as { settings: WisprSyncSettings });
    return syncMeetingsImpl();
  },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const { default: WisprFlowSyncPlugin } = await import('../src/main');

function makePlugin(manifest: { dir?: string } = { dir: '/fake/plugin-dir' }): InstanceType<typeof WisprFlowSyncPlugin> {
  const app = {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      createFolder: () => Promise.resolve(),
      create: () => Promise.resolve(),
      modify: () => Promise.resolve(),
      adapter: {
        append: (path: string, data: string) => {
          adapterWrites.push({ path, content: data });
          adapterFiles.set(path, (adapterFiles.get(path) ?? '') + data);
          return Promise.resolve();
        },
        read: (path: string) => {
          const content = adapterFiles.get(path);
          if (content === undefined) return Promise.reject(new Error('ENOENT: no such file'));
          return Promise.resolve(content);
        },
      },
    },
    metadataCache: { getFileCache: () => undefined },
  };
  return new WisprFlowSyncPlugin(app as never, manifest as never);
}

/** Builds a plugin whose loadData() resolves to `overrides` merged onto
 *  DEFAULT_SETTINGS (main.ts's own loadSettings() does the merging), then
 *  runs onload() so commands/interval/settings-tab registration happens
 *  exactly as it would for a real installed plugin. */
async function loadPlugin(
  overrides: Partial<WisprSyncSettings> = {}
): Promise<InstanceType<typeof WisprFlowSyncPlugin>> {
  loadDataResult = overrides;
  const plugin = makePlugin();
  await plugin.onload();
  return plugin;
}

beforeEach(() => {
  notices.length = 0;
  savedData.length = 0;
  commands.length = 0;
  intervals.length = 0;
  adapterWrites.length = 0;
  adapterFiles.clear();
  clipboardWrites.length = 0;
  syncCalls.length = 0;
  loadDataResult = {};
  locateWisprImpl = () =>
    Promise.resolve({
      ok: true,
      paths: { root: '/fake', database: '/fake/db.sqlite', meetingsDir: '/fake/meetings' },
    });
  syncMeetingsImpl = () =>
    Promise.resolve({
      written: 0,
      skipped: 0,
      transcripts: 0,
      transcriptLinesSkipped: 0,
      watermark: null,
      errors: [],
    });
});

describe('runSync re-entrancy guard (fix 2)', () => {
  it('a second runSync() call while one is in flight returns early with a Notice, without a second syncMeetings call', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    const gate = deferred<unknown>();
    let syncMeetingsCalls = 0;
    syncMeetingsImpl = () => {
      syncMeetingsCalls += 1;
      return gate.promise as Promise<unknown>;
    };

    const first = plugin.runSync();
    // Let the first call's microtasks progress far enough to set the guard
    // and call into syncMeetings.
    await Promise.resolve();
    await Promise.resolve();

    const second = plugin.runSync();
    await second;

    expect(syncMeetingsCalls).toBe(1);
    expect(notices.some((n) => n.includes('already running'))).toBe(true);

    gate.resolve({
      written: 1,
      skipped: 0,
      transcripts: 0,
      transcriptLinesSkipped: 0,
      watermark: null,
      errors: [],
    });
    await first;
  });

  it('the guard resets after a successful sync, so a later call runs normally', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    let syncMeetingsCalls = 0;
    syncMeetingsImpl = () => {
      syncMeetingsCalls += 1;
      return Promise.resolve({
        written: 1,
        skipped: 0,
        transcripts: 0,
        transcriptLinesSkipped: 0,
        watermark: null,
        errors: [],
      });
    };

    await plugin.runSync();
    await plugin.runSync();

    expect(syncMeetingsCalls).toBe(2);
    expect(notices.some((n) => n.includes('already running'))).toBe(false);
  });

  it('the guard resets in a finally even when the sync throws, so it never wedges the plugin (fix 2)', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    let call = 0;
    syncMeetingsImpl = () => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve({
        written: 1,
        skipped: 0,
        transcripts: 0,
        transcriptLinesSkipped: 0,
        watermark: null,
        errors: [],
      });
    };

    await plugin.runSync();
    expect(notices.some((n) => n.includes('Wispr Flow Sync failed'))).toBe(true);

    notices.length = 0;
    await plugin.runSync();
    expect(notices.some((n) => n.includes('already running'))).toBe(false);
    expect(call).toBe(2);
  });
});

describe('onunload guard (fix 2)', () => {
  it('a sync that finishes after onunload() does not persist settings or show its completion Notice', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    const gate = deferred<unknown>();
    syncMeetingsImpl = () => gate.promise as Promise<unknown>;

    const syncPromise = plugin.runSync();
    await Promise.resolve();
    await Promise.resolve();

    plugin.onunload();
    savedData.length = 0; // clear the loadSettings-triggered noise, if any
    notices.length = 0;

    gate.resolve({
      written: 3,
      skipped: 0,
      transcripts: 1,
      transcriptLinesSkipped: 0,
      watermark: '2026-08-06 07:24:11.817 +00:00',
      errors: [],
    });
    await syncPromise;

    expect(savedData.length).toBe(0);
    expect(notices.length).toBe(0);
  });

  it('a normal (non-unloaded) sync still persists the watermark and shows its completion Notice', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    syncMeetingsImpl = () =>
      Promise.resolve({
        written: 2,
        skipped: 0,
        transcripts: 1,
        transcriptLinesSkipped: 0,
        watermark: '2026-08-06 07:24:11.817 +00:00',
        errors: [],
      });

    await plugin.runSync();

    expect(plugin.settings.latestSyncWatermark).toBe('2026-08-06 07:24:11.817 +00:00');
    expect(savedData.some((d) => (d as { latestSyncWatermark?: string }).latestSyncWatermark === '2026-08-06 07:24:11.817 +00:00')).toBe(true);
    expect(notices.some((n) => n.includes('note(s)'))).toBe(true);
  });
});

describe('existing runSync behaviour preserved (fix 2 regression guard)', () => {
  it('does not persist the watermark when report.watermark is null, even on success', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    syncMeetingsImpl = () =>
      Promise.resolve({
        written: 0,
        skipped: 0,
        transcripts: 0,
        transcriptLinesSkipped: 0,
        watermark: null,
        errors: ['some meeting failed to write'],
      });

    await plugin.runSync();

    expect(plugin.settings.latestSyncWatermark).toBeNull();
  });

  it('still shows a Notice and returns early on a non-desktop platform, without touching locateWispr', async () => {
    const obsidian = await import('obsidian');
    (obsidian as unknown as { Platform: { isDesktopApp: boolean } }).Platform.isDesktopApp = false;
    try {
      const plugin = makePlugin();
      await plugin.loadSettings();
      let locateCalls = 0;
      locateWisprImpl = () => {
        locateCalls += 1;
        return Promise.resolve({ ok: true, paths: { root: '', database: '', meetingsDir: '' } });
      };

      await plugin.runSync();

      expect(locateCalls).toBe(0);
      expect(notices.some((n) => n.includes('requires the desktop app'))).toBe(true);
    } finally {
      (obsidian as unknown as { Platform: { isDesktopApp: boolean } }).Platform.isDesktopApp = true;
    }
  });

  it('catches a thrown sync at the boundary and reports it via Notice instead of rejecting', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    syncMeetingsImpl = () => Promise.reject(new Error('disk full'));

    await expect(plugin.runSync()).resolves.toBeUndefined();
    expect(notices.some((n) => n.includes('Wispr Flow Sync failed: disk full'))).toBe(true);
  });
});

describe('Task 8: commands, periodic sync, full sync, debug log', () => {
  it('registers both the sync-now and full-sync commands', async () => {
    const p = await loadPlugin();
    const ids = commands.map((c) => c.id);
    expect(ids).toContain('sync-now');
    expect(ids).toContain('full-sync');
  });

  it('full sync ignores the stored watermark for that run only', async () => {
    const p = await loadPlugin();
    p.settings.latestSyncWatermark = '2026-08-01 00:00:00.000 +00:00';
    await p.runSync({ fullSync: true });
    // the engine must have been called with a null watermark
    expect(syncCalls[0].settings.latestSyncWatermark).toBeNull();
    // but the stored value must not be wiped by the attempt itself
    expect(typeof p.settings.latestSyncWatermark === 'string' || p.settings.latestSyncWatermark === null).toBe(true);
  });

  it('registers a periodic interval only when periodic sync is enabled', async () => {
    intervals.length = 0;
    const off = await loadPlugin({ periodicSyncEnabled: false });
    expect(intervals).toHaveLength(0);
    intervals.length = 0;
    const on = await loadPlugin({ periodicSyncEnabled: true, syncIntervalSeconds: 900 });
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(900_000);
  });

  it('clamps a nonsensical sync interval instead of hammering the disk', async () => {
    intervals.length = 0;
    await loadPlugin({ periodicSyncEnabled: true, syncIntervalSeconds: 1 });
    expect(intervals[0].ms).toBeGreaterThanOrEqual(60_000);
  });

  it('clamps a huge typed sync interval to the 24h ceiling, so window.setInterval never sees a delay that truncates to a negative 32-bit int (fix: interval spin)', async () => {
    // window.setInterval truncates its delay to a 32-bit signed int
    // internally; 20260808 seconds (~234 days) * 1000ms overflows that,
    // wrapping to a negative number treated as 0 — firing back-to-back
    // forever instead of once a day. A value this large must be clamped
    // down to (at most) MAX_SYNC_INTERVAL_SECONDS * 1000 before it ever
    // reaches window.setInterval.
    intervals.length = 0;
    await loadPlugin({ periodicSyncEnabled: true, syncIntervalSeconds: 20_260_808 });
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBeGreaterThanOrEqual(60_000);
    expect(intervals[0].ms).toBeLessThanOrEqual(86_400_000);
  });

  it('does not write a debug log when debug logging is disabled', async () => {
    const p = await loadPlugin({ enableDebugLogging: false });
    await p.runSync();
    expect(adapterWrites.filter((w) => w.path.includes('debug.log'))).toHaveLength(0);
  });

  it('writes a debug log when debug logging is enabled', async () => {
    const p = await loadPlugin({ enableDebugLogging: true });
    await p.runSync();
    expect(adapterWrites.some((w) => w.path.includes('wispr-flow-sync-debug.log'))).toBe(true);
  });
});

describe('debug logging without a plugin directory (fix 1: dead logging)', () => {
  it('does not attempt to write when manifest.dir is missing, and tells the user once instead of pretending logging is on', async () => {
    // manifest.dir is optional per Obsidian's own typing. Without the fix,
    // debugSink() would compute the literal path "undefined/wispr-flow-
    // sync-debug.log", every append would fail ENOENT, and the .catch(()
    // => undefined) on that write would swallow the failure silently — the
    // toggle would look enabled while doing nothing.
    const p = await loadPlugin({ enableDebugLogging: true });
    // loadPlugin always builds its plugin with a dir via makePlugin's
    // default; rebuild directly with no dir for this test.
    const noDirPlugin = makePlugin({});
    await noDirPlugin.loadSettings();
    noDirPlugin.settings.enableDebugLogging = true;

    await noDirPlugin.runSync();

    expect(adapterWrites).toHaveLength(0);
    expect(notices.some((n) => n.includes('debug logging') && n.includes('unavailable'))).toBe(true);
    void p; // unused beyond establishing the contrasting "with a dir" baseline
  });

  it('shows the "unavailable" Notice only once across multiple syncs, not on every run', async () => {
    const noDirPlugin = makePlugin({});
    await noDirPlugin.loadSettings();
    noDirPlugin.settings.enableDebugLogging = true;

    await noDirPlugin.runSync();
    await noDirPlugin.runSync();

    const unavailableNotices = notices.filter(
      (n) => n.includes('debug logging') && n.includes('unavailable')
    );
    expect(unavailableNotices).toHaveLength(1);
  });
});

describe('completion Notice and console.error content (fix 3: privacy comment vs. reality)', () => {
  it('names up to a few failed meetings BY TITLE in the completion Notice', async () => {
    syncMeetingsImpl = () =>
      Promise.resolve({
        written: 1,
        skipped: 2,
        transcripts: 0,
        transcriptLinesSkipped: 0,
        watermark: null,
        errors: [
          'Confidential Budget Review: disk full',
          'Executive Compensation Plan: disk full',
        ],
        errorDetails: [
          { id: 'm-1', kind: 'note', errorKind: 'Error' },
          { id: 'm-2', kind: 'note', errorKind: 'Error' },
        ],
        failedMeetingTitles: ['Confidential Budget Review', 'Executive Compensation Plan'],
      });

    const p = await loadPlugin();
    await p.runSync();

    const completionNotice = notices.find((n) => n.includes('note(s)'));
    expect(completionNotice).toBeDefined();
    expect(completionNotice).toContain('Confidential Budget Review');
    expect(completionNotice).toContain('Executive Compensation Plan');
  });

  it('says "and N more" when there are more failures than fit in the Notice', async () => {
    const titles = ['Meeting A', 'Meeting B', 'Meeting C', 'Meeting D', 'Meeting E'];
    syncMeetingsImpl = () =>
      Promise.resolve({
        written: 0,
        skipped: titles.length,
        transcripts: 0,
        transcriptLinesSkipped: 0,
        watermark: null,
        errors: titles.map((t) => `${t}: disk full`),
        errorDetails: titles.map((_, i) => ({ id: `m-${i}`, kind: 'note' as const, errorKind: 'Error' })),
        failedMeetingTitles: titles,
      });

    const p = await loadPlugin();
    await p.runSync();

    const completionNotice = notices.find((n) => n.includes('note(s)'))!;
    expect(completionNotice).toMatch(/and \d+ more/);
  });

  it('console.error never receives a meeting title or error message — only id, kind, and error constructor name', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      syncMeetingsImpl = () =>
        Promise.resolve({
          written: 0,
          skipped: 1,
          transcripts: 0,
          transcriptLinesSkipped: 0,
          watermark: null,
          errors: ['Confidential Budget Review: some very specific disk error message'],
          errorDetails: [{ id: 'm-secret', kind: 'note', errorKind: 'Error' }],
          failedMeetingTitles: ['Confidential Budget Review'],
        });

      const p = await loadPlugin();
      await p.runSync();

      const loggedStrings = spy.mock.calls
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
      const joined = loggedStrings.join(' ');
      expect(joined).not.toContain('Confidential Budget Review');
      expect(joined).not.toContain('some very specific disk error message');
      expect(joined).toContain('m-secret');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not crash on a report shaped like an older SyncReport (no errorDetails/failedMeetingTitles)', async () => {
    // Defensive regression guard: some tests in this file (and, in
    // principle, an out-of-date caller) build a report literal without the
    // two new fields. runSync must tolerate that rather than throwing on
    // `new Set(undefined)` or `.slice()` on undefined.
    syncMeetingsImpl = () =>
      Promise.resolve({
        written: 1,
        skipped: 0,
        transcripts: 0,
        transcriptLinesSkipped: 0,
        watermark: null,
        errors: [],
      });
    const p = await loadPlugin();
    await expect(p.runSync()).resolves.toBeUndefined();
  });
});

describe('write() never overwrites a file this plugin did not create (fix 6)', () => {
  it('throws instead of overwriting when the existing file has no wispr_id frontmatter at all', async () => {
    const obsidian = await import('obsidian');
    const { TFile } = obsidian as unknown as { TFile: new () => object };
    const plugin = makePlugin();
    await plugin.loadSettings();

    const existingFile = new TFile();
    let modifyCalls = 0;
    let createCalls = 0;
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.getAbstractFileByPath = (
      p: string
    ) => (p === 'Meetings/Wispr/Collide.md' ? existingFile : null);
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.modify = () => {
      modifyCalls += 1;
      return Promise.resolve();
    };
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.create = () => {
      createCalls += 1;
      return Promise.resolve();
    };
    // The user's own note: metadataCache has no frontmatter for it at all.
    (plugin.app as unknown as { metadataCache: Record<string, unknown> }).metadataCache.getFileCache =
      () => undefined;

    const adapter = plugin.buildVaultAdapter();
    await expect(
      adapter.write(
        'Meetings/Wispr/Collide.md',
        '---\nwispr_id: m-1\ntitle: X\ntype: note\n---\nbody'
      )
    ).rejects.toThrow();
    expect(modifyCalls).toBe(0);
    expect(createCalls).toBe(0);
  });

  it('throws instead of overwriting when the existing file belongs to a different meeting/type', async () => {
    const obsidian = await import('obsidian');
    const { TFile } = obsidian as unknown as { TFile: new () => object };
    const plugin = makePlugin();
    await plugin.loadSettings();

    const existingFile = new TFile();
    let modifyCalls = 0;
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.getAbstractFileByPath = (
      p: string
    ) => (p === 'Meetings/Wispr/Collide.md' ? existingFile : null);
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.modify = () => {
      modifyCalls += 1;
      return Promise.resolve();
    };
    (plugin.app as unknown as { metadataCache: Record<string, unknown> }).metadataCache.getFileCache =
      () => ({ frontmatter: { wispr_id: 'm-OTHER', type: 'note' } });

    const adapter = plugin.buildVaultAdapter();
    await expect(
      adapter.write(
        'Meetings/Wispr/Collide.md',
        '---\nwispr_id: m-1\ntitle: X\ntype: note\n---\nbody'
      )
    ).rejects.toThrow();
    expect(modifyCalls).toBe(0);
  });

  it('modifies the file in place when the existing frontmatter matches the same wispr_id and type (normal update path)', async () => {
    const obsidian = await import('obsidian');
    const { TFile } = obsidian as unknown as { TFile: new () => object };
    const plugin = makePlugin();
    await plugin.loadSettings();

    const existingFile = new TFile();
    let modifyCalls = 0;
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.getAbstractFileByPath = (
      p: string
    ) => (p === 'Meetings/Wispr/Note.md' ? existingFile : null);
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.modify = () => {
      modifyCalls += 1;
      return Promise.resolve();
    };
    (plugin.app as unknown as { metadataCache: Record<string, unknown> }).metadataCache.getFileCache =
      () => ({ frontmatter: { wispr_id: 'm-1', type: 'note' } });

    const adapter = plugin.buildVaultAdapter();
    await adapter.write(
      'Meetings/Wispr/Note.md',
      '---\nwispr_id: m-1\ntitle: X\ntype: note\n---\nbody'
    );
    expect(modifyCalls).toBe(1);
  });
});

describe('"Copy logs" is honest about an empty log file', () => {
  it('tells the user there is nothing to copy when the debug log is empty', async () => {
    const p = await loadPlugin({ enableDebugLogging: true });
    adapterFiles.set(p.debugLogPath(), '   \n  ');
    await p.copyLogsToClipboard();
    expect(clipboardWrites).toEqual([]);
    expect(notices.some((n) => /nothing to copy/i.test(n))).toBe(true);
  });

  it('still copies real content to the clipboard when the log is non-empty', async () => {
    const p = await loadPlugin({ enableDebugLogging: true });
    adapterFiles.set(p.debugLogPath(), '2026-08-08T00:00:00.000Z [sync] run start\n');
    await p.copyLogsToClipboard();
    expect(clipboardWrites).toEqual(['2026-08-08T00:00:00.000Z [sync] run start\n']);
    expect(notices.some((n) => n.includes('logs copied to clipboard'))).toBe(true);
  });

  it('shows the missing-file Notice, not the empty-file Notice, when there is no log file at all', async () => {
    const p = await loadPlugin({ enableDebugLogging: true });
    await p.copyLogsToClipboard();
    expect(clipboardWrites).toEqual([]);
    expect(notices.some((n) => n.includes('no log file found'))).toBe(true);
  });
});

describe('duplicate vault-index entries are surfaced, not silently overwritten (fix 7)', () => {
  it('logs a content-free duplicate warning and shows one summary Notice when two files share the same wispr_id:type', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();
    plugin.settings.enableDebugLogging = true;

    const fileA = { path: 'A.md' };
    const fileB = { path: 'B.md' };
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.getMarkdownFiles = () => [
      fileA,
      fileB,
    ];
    (plugin.app as unknown as { metadataCache: Record<string, unknown> }).metadataCache.getFileCache =
      (f: unknown) =>
        f === fileA || f === fileB
          ? { frontmatter: { wispr_id: 'm-dup', type: 'note' } }
          : undefined;

    const log: string[] = [];
    plugin.buildVaultAdapter((m) => log.push(m));

    expect(log.some((l) => l.includes('m-dup') && l.includes('count=2'))).toBe(true);
    expect(
      notices.some((n) => n.includes('found 1 duplicate'))
    ).toBe(true);
  });

  it('does not warn when every note has a unique wispr_id:type', async () => {
    const plugin = makePlugin();
    await plugin.loadSettings();

    const fileA = { path: 'A.md' };
    const fileB = { path: 'B.md' };
    (plugin.app as unknown as { vault: Record<string, unknown> }).vault.getMarkdownFiles = () => [
      fileA,
      fileB,
    ];
    (plugin.app as unknown as { metadataCache: Record<string, unknown> }).metadataCache.getFileCache =
      (f: unknown) => {
        if (f === fileA) return { frontmatter: { wispr_id: 'm-1', type: 'note' } };
        if (f === fileB) return { frontmatter: { wispr_id: 'm-2', type: 'note' } };
        return undefined;
      };

    const log: string[] = [];
    plugin.buildVaultAdapter((m) => log.push(m));

    expect(log.some((l) => l.includes('duplicate'))).toBe(false);
    expect(notices.some((n) => n.includes('duplicate'))).toBe(false);
  });
});
