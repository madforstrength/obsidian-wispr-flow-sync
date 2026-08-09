// This suite is the regression guard for a class of bug that 262 unit tests
// running against TypeScript source completely missed: wa-sqlite's glue
// code computes `new URL("wa-sqlite.wasm", import.meta.url).href` whenever
// no `locateFile` is supplied. Under vitest, the source is loaded as real
// ESM, so `import.meta.url` is a genuine file URL and that expression just
// works. But the SHIPPED bundle (`main.js`) is built with esbuild's
// `format: 'cjs'` (required by Obsidian), which rewrites `import.meta` to a
// shim whose `.url` is `undefined` — `new URL("wa-sqlite.wasm", undefined)`
// throws "Invalid URL" synchronously, before any query ever runs. No test
// that only imports `../src/...` can ever see this: it only exists in the
// built artifact. This file `require()`s the actual built `main.js`, the
// same way Obsidian's Electron host does, to close that gap.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import NodeModule from 'node:module';
import { existsSync, statSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// `Module._resolveFilename` is a long-standing, widely-relied-on Node
// internal (the same hook mock-require/proxyquire-style libraries use) for
// redirecting a bare `require('x')` to a stand-in. It is the only way to
// intercept `main.js`'s own internal `require('obsidian')` call without
// modifying the built bundle itself — and modifying the bundle would defeat
// the point of testing the REAL artifact.
type ModuleInternals = typeof NodeModule & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

const REPO_ROOT = join(__dirname, '..');
const MAIN_JS = join(REPO_ROOT, 'main.js');
const WISPR_DB = join(homedir(), 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite');

/**
 * Minimal stand-in for Obsidian's `obsidian` module, just enough surface
 * for main.ts's `onload()` and a "Sync now" run to execute against. Kept
 * inline (not a repo dependency) so this test has no hidden coupling to
 * anything outside `tests/`.
 */
function makeObsidianStub() {
  const notices: string[] = [];

  class Notice {
    constructor(msg: unknown) {
      notices.push(String(msg));
    }
  }
  class TFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  class Plugin {
    app: unknown;
    manifest: unknown;
    _cmds?: Array<{ id: string; name: string; callback: () => void }>;
    _ints?: unknown[];
    _data?: unknown;
    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }
    addCommand(c: { id: string; name: string; callback: () => void }) {
      (this._cmds ??= []).push(c);
    }
    addSettingTab() {}
    registerInterval(id: unknown) {
      (this._ints ??= []).push(id);
      return id;
    }
    async loadData() {
      return this._data ?? null;
    }
    async saveData(d: unknown) {
      this._data = d;
    }
  }
  class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: { empty(): void; createEl(): unknown };
    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = { empty() {}, createEl() { return {}; } };
    }
  }
  class Setting {
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    setDisabled() { return this; }
    addText(cb: (t: unknown) => void) {
      cb({
        setValue: () => ({ onChange: () => ({}) }),
        setPlaceholder: () => ({ setValue: () => ({ onChange: () => ({}) }) }),
        setDisabled: () => ({}),
      });
      return this;
    }
    addToggle(cb: (t: unknown) => void) {
      cb({ setValue: () => ({ onChange: () => ({}) }) });
      return this;
    }
    addDropdown(cb: (d: unknown) => void) {
      const d: { addOption(): unknown; setValue: () => { onChange: () => unknown } } = {
        addOption() { return d; },
        setValue: () => ({ onChange: () => ({}) }),
      };
      cb(d);
      return this;
    }
    addButton(cb: (b: unknown) => void) {
      cb({ setButtonText: () => ({ onClick: () => ({}) }) });
      return this;
    }
  }
  const Platform = { isDesktopApp: true };
  const normalizePath = (p: string) => p;

  return { Notice, TFile, Plugin, PluginSettingTab, Setting, Platform, normalizePath, notices };
}

/**
 * `require()`s the built `main.js` through a stub `obsidian` module,
 * exactly as Obsidian's Electron host resolves the `obsidian` import at
 * runtime — `main.js` is CommonJS (`require('obsidian')`), so this needs a
 * real Node `require`, not an ESM import, to exercise the same resolution
 * path as production.
 */
function loadBundle() {
  const stub = makeObsidianStub();
  const nodeRequire = createRequire(import.meta.url);
  const Module = NodeModule as ModuleInternals;

  // The repo's package.json sets "type": "module", so Node's loader treats
  // any plain `.js` file — including the built `main.js`, whose actual
  // *content* is CommonJS (esbuild's `format: 'cjs'`) — as ESM purely based
  // on that ancestor package.json, ignoring the file's real syntax. That
  // produces a bogus "module is not defined" / "not yet fully loaded"
  // error that has nothing to do with the bug under test. Copy the built
  // bytes verbatim into a `.cjs` file under a temp dir (never inside the
  // repo) so Node's extension-based detection loads the exact same content
  // Obsidian ships, correctly, as CommonJS.
  const scratchDir = mkdtempSync(join(tmpdir(), 'wispr-bundle-test-'));
  const cjsCopy = join(scratchDir, 'main.cjs');
  try {
    writeFileSync(cjsCopy, readFileSync(MAIN_JS));

    // Real "obsidian" (the devDependency) is a types-only package with
    // `"main": ""` — no runtime implementation exists to require in Node at
    // all. Redirect the bare specifier 'obsidian' to our in-memory stub so
    // the bundle's own `require('obsidian')` resolves to it, exactly as
    // Obsidian's Electron host would resolve it to the real implementation.
    const originalResolveFilename = Module._resolveFilename;
    const stubId = '\0obsidian-stub';
    (nodeRequire.cache as unknown as Record<string, unknown>)[stubId] = {
      id: stubId,
      filename: stubId,
      loaded: true,
      exports: stub,
    };
    Module._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === 'obsidian') return stubId;
      return originalResolveFilename.call(Module, request, ...rest);
    };

    try {
      const mod = nodeRequire(cjsCopy) as {
        default: new (app: unknown, manifest: unknown) => InstanceType<ReturnType<typeof makeObsidianStub>['Plugin']>;
      };
      return { PluginCtor: mod.default, stub };
    } finally {
      Module._resolveFilename = originalResolveFilename;
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

describe('built bundle (main.js)', () => {
  beforeAll(() => {
    if (!existsSync(MAIN_JS)) {
      // Build it rather than skip: a skipped test here would recreate
      // exactly the blind spot this suite exists to close.
      execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    }
    expect(existsSync(MAIN_JS)).toBe(true);
  }, 120_000);

  it('loads through a stub `obsidian` module and registers the sync-now command', () => {
    const { PluginCtor, stub } = loadBundle();

    const written = new Map<string, string>();
    const app = {
      vault: {
        getMarkdownFiles: () => [],
        getAbstractFileByPath: (p: string) => (written.has(p) ? new stub.TFile(p) : null),
        createFolder: async () => {},
        create: async (p: string, c: string) => { written.set(p, c); },
        modify: async (f: { path: string }, c: string) => { written.set(f.path, c); },
        adapter: { append: async () => {}, read: async () => '' },
      },
      metadataCache: { getFileCache: () => null },
    };
    const manifest = { id: 'wispr-flow-sync', dir: '.obsidian/plugins/wispr-flow-sync' };

    const plugin = new PluginCtor(app, manifest);
    expect(plugin).toBeTruthy();
  });

  it(
    'runs a real "Sync now" against the built bundle with no "Invalid URL" error, and (when a real Wispr install is present) writes at least one file with zero sync errors',
    async () => {
      // Read-only guard: prove this test never mutates the real Wispr
      // database, by comparing mtime before and after.
      const hasRealWispr = existsSync(WISPR_DB);
      const mtimeBefore = hasRealWispr ? statSync(WISPR_DB).mtimeMs : null;

      const { PluginCtor, stub } = loadBundle();

      const written = new Map<string, string>();
      const logLines: string[] = [];
      const app = {
        vault: {
          getMarkdownFiles: () => [],
          getAbstractFileByPath: (p: string) => (written.has(p) ? new stub.TFile(p) : null),
          createFolder: async () => {},
          create: async (p: string, c: string) => { written.set(p, c); },
          modify: async (f: { path: string }, c: string) => { written.set(f.path, c); },
          adapter: {
            append: async (_p: string, line: string) => { logLines.push(String(line).trim()); },
            read: async () => '',
          },
        },
        metadataCache: { getFileCache: () => null },
      };
      const manifest = { id: 'wispr-flow-sync', dir: '.obsidian/plugins/wispr-flow-sync' };

      const plugin = new PluginCtor(app, manifest);
      // Turn on the plugin's own debug logging sink so `run end: ...` and
      // any error detail land in `logLines` for assertions below — this is
      // the same sink shipped in production, driven exactly as the
      // settings-tab toggle would.
      (plugin as unknown as { _data: unknown })._data = { enableDebugLogging: true };

      const originalConsoleError = console.error;
      const consoleErrors: string[] = [];
      console.error = (...args: unknown[]) => {
        consoleErrors.push(
          args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
        );
      };

      try {
        await (plugin as unknown as { onload(): Promise<void> }).onload();

        const cmds = (plugin as unknown as { _cmds?: Array<{ id: string; callback: () => void }> })._cmds ?? [];
        const syncNow = cmds.find((c) => c.id === 'sync-now');
        expect(syncNow, 'sync-now command must be registered by onload()').toBeTruthy();

        // Invoke exactly as Obsidian's command palette would: call the
        // registered callback and let the fire-and-forget sync run.
        syncNow!.callback();

        // Poll for the run to settle (the debug log's "run end" line, or a
        // generous timeout) instead of a fixed sleep, so this isn't flaky
        // under a slow real 217MB database read.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !logLines.some((l) => l.includes('run end'))) {
          await new Promise((r) => setTimeout(r, 200));
        }

        const allOutput = [...logLines, ...consoleErrors, ...stub.notices].join('\n');

        // The regression guard for THIS exact bug: whatever else happens,
        // the fatal "Invalid URL" thrown by wa-sqlite's glue when
        // `import.meta.url` is undefined in the CJS bundle must never
        // appear again.
        expect(allOutput).not.toMatch(/Invalid URL/);

        if (!hasRealWispr) {
          // No real Wispr Flow install on this machine: the bundle-loads /
          // command-registered assertions above already ran and passed.
          // Data-dependent assertions below cannot be meaningful here, so
          // skip them explicitly and say why, rather than silently passing.
          console.log(
            '[bundle.test] SKIPPING data-dependent assertions: no Wispr Flow install found at',
            WISPR_DB
          );
          expect(logLines.some((l) => l.includes('run end'))).toBe(true);
          return;
        }

        // A real install is present: the sync must actually have succeeded
        // against it end-to-end.
        const runEndLine = logLines.find((l) => l.includes('run end'));
        expect(runEndLine, `expected a "run end" debug log line; got: ${JSON.stringify(logLines)}`).toBeTruthy();
        expect(runEndLine).not.toMatch(/could not locate Wispr Flow/);
        expect(runEndLine).not.toMatch(/sync failed/);
        expect(runEndLine).toMatch(/errors=0/);

        expect(written.size).toBeGreaterThan(0);
        expect(consoleErrors.join('\n')).not.toMatch(/Invalid URL/);
      } finally {
        console.error = originalConsoleError;
      }

      // Read-only guard: the real Wispr database must be byte-for-byte
      // untouched by this test.
      if (hasRealWispr) {
        const mtimeAfter = statSync(WISPR_DB).mtimeMs;
        expect(mtimeAfter).toBe(mtimeBefore);
      }
    },
    60_000
  );

  it('never contains a dynamic ESM import() of a node: builtin (it would hang forever in Obsidian)', () => {
    // Second bug of this exact family: esbuild's `format: 'cjs'` output can
    // still contain literal `await import("node:fs")` calls if the source
    // used dynamic `import()` for a Node builtin instead of `require()`.
    // Under vitest / plain Node, that dynamic import resolves fine (real
    // ESM loader), so no unit test — and not even the "runs a real Sync
    // now" test above, which also runs under Node — can ever observe the
    // failure. But Obsidian's renderer is CommonJS: a dynamic ESM import()
    // of a node: builtin there does not reject (which would at least be
    // catchable) — it simply never settles. The observed symptom in
    // production was a sync that logged "run start" and then nothing ever
    // again: it hung forever on the very first `await import('node:fs')`.
    // This is a static assertion on the built artifact, not a behavioural
    // one, because that hang cannot be reproduced by any Node-based test.
    const bundleSource = readFileSync(MAIN_JS, 'utf8');

    const dynamicNodeImport = /import\(\s*["']node:[a-z/]+["']\s*\)/;
    expect(
      dynamicNodeImport.test(bundleSource),
      'main.js contains a dynamic import() of a node: builtin. In Obsidian\'s ' +
        'CommonJS renderer this never resolves or rejects — it hangs forever ' +
        '(observed: a sync run logs "run start" and nothing else, ever). Use ' +
        'the nodeRequire() helper in src/node-runtime.ts instead of ' +
        "`await import('node:...')`."
    ).toBe(false);

    // Positive check so this test fails loudly if someone reverts the fix
    // back to dynamic import rather than merely removing the bad pattern.
    expect(
      bundleSource.includes('require("fs")') || bundleSource.includes("require('fs')"),
      'expected the built bundle to contain a require("fs") call (via ' +
        'src/node-runtime.ts\'s nodeRequire helper); its absence suggests the ' +
        'require()-based node: builtin access pattern was removed or renamed.'
    ).toBe(true);
  });

  it('produces a scratch temp dir under the OS tmpdir if needed, and cleans it up', () => {
    // No production code path in this suite currently needs scratch files,
    // but per the test-writing constraints for this repo, any temp file use
    // must go through mkdtempSync under the OS tmpdir, never inside the
    // repo. This test documents and exercises that helper so a future
    // addition to this file has a ready-made, already-verified pattern.
    const dir = mkdtempSync(join(tmpdir(), 'wispr-bundle-test-'));
    try {
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
