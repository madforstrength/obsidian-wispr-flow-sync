# Wispr Flow Sync

Sync Wispr Flow meeting notes and transcripts into your vault. Reads local files only and never connects to the network.

> **Unofficial.** This plugin is not affiliated with, endorsed by, or sponsored by Wispr AI. "Wispr Flow" is a trademark of its owner. This plugin uses no Wispr logo or icon.

## What it does

The plugin reads meeting notes and transcripts that Wispr Flow's desktop app has already recorded locally — including those still sitting in the database's write-ahead log, which is where a running Wispr Flow keeps most recent meetings — and writes them into your vault as Markdown — one note per meeting, with YAML frontmatter carrying a `wispr_id` field, and optionally a companion transcript file. It does not talk to Wispr Flow, does not use any Wispr Flow API (none exists locally), and does not modify anything Wispr Flow owns.

## Requirements

- Obsidian desktop. This plugin declares `isDesktopOnly: true` and will not load on Obsidian Mobile.
- macOS, with Wispr Flow installed and its Notetaker used at least once (Notetaker is what produces the meeting notes and transcripts this plugin reads).
- Wispr Flow's Notetaker is macOS-only at the time of writing. A Windows data-folder path is implemented in this plugin but has not been tested against a real Windows Wispr Flow install.

## Installation

**From the community plugin browser** (once listed): search for "Wispr Flow Sync" in Obsidian's Community Plugins browser, install, and enable.

**Manual install**: copy `main.js` and `manifest.json` into `<your-vault>/.obsidian/plugins/wispr-flow-sync/`, then enable "Wispr Flow Sync" under Settings → Community plugins.

## Usage

Two commands are available from the command palette:

- **Sync now** — reads meetings created or modified since the last sync and writes any new or changed ones.
- **Full sync (re-read everything)** — ignores the stored watermark and re-reads all matching meetings from scratch.

By default, notes are written to `Meetings/Wispr` in your vault, with transcripts (if enabled) under `Meetings/Wispr/Transcripts`. Both locations are configurable in settings.

## Settings

| Group | What it controls |
|---|---|
| Sync | Whether to run automatically on an interval, and how often. |
| Notes | Whether to write notes at all, the destination folder, subfolder layout, and filename pattern. |
| Transcripts | Whether to write transcripts, where (same folder as the note, a separate location, or combined into the note), and which transcript source (`refined` or `live`) to prefer. |
| Filtering | How far back to sync (in days, 0 = unlimited), an optional title keyword filter, and whether to include unfinalized meetings. |
| Advanced | An override for Wispr Flow's data folder location, for non-default installs. |
| Debugging | An optional debug log and a button to copy it to the clipboard for troubleshooting. |

Filename and subfolder patterns accept these tokens: `{title} {date} {time} {year} {month} {day} {quarter}`.

Subfolder modes: `none`, `day`, `month`, `year-month`, `year-quarter`, or `custom` (using the same tokens, `/`-separated for nested folders).

**Folder and filename settings apply only to newly-synced meetings.** Changing them never relocates or renames a note or transcript that was already written — that would risk breaking links you've made to it elsewhere in your vault.

## Disclosures

Obsidian's developer policies require plugins to disclose access outside the vault, network use, and telemetry. This section is that disclosure, not marketing copy.

| Disclosure | Answer |
|---|---|
| Files accessed outside the vault | `~/Library/Application Support/Wispr Flow/` — `flow.sqlite`, its write-ahead log `flow.sqlite-wal`, and `meetings/*.ndjson`, opened **read-only**. Justified: Wispr Flow stores meeting notes only there and exposes no local API, so there is no other way to read the data the user is asking to sync. The plugin never writes to, moves, or deletes any Wispr Flow file. |
| Node `fs` usage | Read-only, without exception: `existsSync`, `statSync`, `readFileSync`, `fstatSync`, `readSync`, `closeSync`, and `openSync(path, 'r')` — the read-mode flag. The plugin calls no `fs` write API at all (no `writeFile`, `appendFile`, `mkdir`, `unlink`, `rename`, or `createWriteStream`). The optional debug log is the only file this plugin writes outside your note tree, and it goes through Obsidian's own `vault.adapter.append` into the plugin's folder — not through `fs`. |
| Vault enumeration | One call to `vault.getMarkdownFiles()`, to index existing notes by their `wispr_id` frontmatter. Justified: without it, a re-sync cannot tell that a meeting's note already exists after you move or rename it, and would write a duplicate instead of updating in place. Only frontmatter is inspected; note bodies are never read during indexing. |
| Clipboard access | **Write-only**, and only when you press a button: "Export settings as JSON" and "Copy logs to clipboard" in settings. The plugin calls `navigator.clipboard.writeText` and never `readText`, so it cannot see anything you copied from elsewhere. |
| Network access | None. The plugin makes no network requests of any kind. |
| Telemetry | None, client-side or server-side. |
| Account or paid features | None. Works with Wispr Flow's free tier. |
| Platform | Desktop only. macOS supported; the Windows path is implemented but untested. |
| Closed-source components | None. Bundles `wa-sqlite` (MIT), whose WebAssembly binary is inlined into `main.js`. |

### A note on `fetch` in `main.js`

`main.js` contains two occurrences of `fetch(`. Both are inside the bundled Emscripten WebAssembly loader that ships with `wa-sqlite`, and both are dead branches: the plugin always supplies the WASM binary inline via `wasmBinary`, so the loader's own `fetch`-based paths are never reached. This was verified by replacing `globalThis.fetch` with a spy that throws on any call and running a full sync — zero calls were observed. Noting this here up front is meant to save a review round for anyone grepping the bundle for `fetch(`.

## Privacy

Meeting content never leaves your machine — there is no network access at all (see Disclosures above).

The optional debug log (enabled under Settings → Debugging) is written to a file inside the plugin's own folder. It contains only meeting ids, integer counts, the values of your own settings, and a small set of fixed literal strings. It never contains meeting titles, note bodies, transcript text, or speaker names. This was checked adversarially: with a subfolder pattern of `{title}`, every file path written by a sync contained a real meeting title, while the debug log for that same sync contained none.

## Development

```bash
npm install
npm run inline-wasm   # required before test or build — the generated WASM
                       # constant is gitignored, so a clean checkout has none
npm test
npm run build
```

Issues and pull requests: `https://github.com/madforstrength/obsidian-wispr-flow-sync`.

## License

[MIT](LICENSE)

## Known limitations

- **Existing notes are never relocated or renamed** when you change folder or filename settings. The new settings apply only to meetings synced from that point on.
- **Changing the sync interval requires reloading the plugin** (disable/enable, or restart Obsidian). Obsidian's interval registration cannot be rescheduled in place once set.
- **A title made almost entirely of emoji can lose its trailing date** in the generated filename. The filename length limit is enforced in UTF-8 bytes, and emoji are multi-byte, so a very emoji-heavy title can consume the whole budget before the date suffix is appended. This only affects unusually emoji-dense titles.
- **Wispr Flow's database schema is undocumented** and its Notetaker feature is relatively new, so a future Wispr Flow update could change the schema in a way that breaks syncing. The plugin checks for the columns it depends on and reports one clear error message if they're missing, rather than failing with an obscure SQL error.
- **The debug log has no size cap or rotation.** If you enable debug logging and leave it on indefinitely, the log file will grow without bound. Turn it off when you're done troubleshooting, or delete the file periodically.
