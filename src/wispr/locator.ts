import { requireFs, requirePath, requireOs } from '../node-runtime';

export interface WisprPaths {
  root: string;
  database: string;
  meetingsDir: string;
}

export type LocateResult =
  | { ok: true; paths: WisprPaths }
  | { ok: false; error: string; triedPath: string | null };

/** Wispr Flow's Notetaker is macOS-only at time of writing. The Windows path
 *  is a best-effort guess and is documented as untested. */
export function defaultWisprRoot(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'darwin') return `${home}/Library/Application Support/Wispr Flow`;
  if (platform === 'win32') return `${home}\\AppData\\Roaming\\Wispr Flow`;
  return null;
}

export async function locateWispr(override: string | null): Promise<LocateResult> {
  const fs = requireFs();
  const path = requirePath();
  const os = requireOs();

  const root = override?.trim() || defaultWisprRoot(process.platform, os.homedir());
  if (!root) {
    return {
      ok: false,
      error: 'Wispr Flow is not available on this platform. Set a data folder manually in settings.',
      triedPath: null,
    };
  }
  if (!fs.existsSync(root)) {
    return { ok: false, error: `Wispr Flow data folder not found at: ${root}`, triedPath: root };
  }

  // Verify root is a directory, not a file
  try {
    const rootStat = fs.statSync(root);
    if (!rootStat.isDirectory()) {
      return { ok: false, error: `Wispr Flow data folder path exists but is not a folder: ${root}`, triedPath: root };
    }
  } catch {
    // If stat fails (permission, race condition), return error without throwing
    return { ok: false, error: `Cannot access Wispr Flow data folder at: ${root}`, triedPath: root };
  }

  const database = path.join(root, 'flow.sqlite');
  if (!fs.existsSync(database)) {
    return { ok: false, error: `No flow.sqlite inside: ${root}`, triedPath: root };
  }

  // Verify flow.sqlite is a file, not a directory
  try {
    const dbStat = fs.statSync(database);
    if (!dbStat.isFile()) {
      return { ok: false, error: `flow.sqlite exists but is not a file at: ${root}`, triedPath: root };
    }
  } catch {
    // If stat fails (permission, race condition), return error without throwing
    return { ok: false, error: `Cannot access flow.sqlite database at: ${database}`, triedPath: root };
  }

  return { ok: true, paths: { root, database, meetingsDir: path.join(root, 'meetings') } };
}
