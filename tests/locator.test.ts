import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWisprRoot, locateWispr } from '../src/wispr/locator';

describe('defaultWisprRoot', () => {
  it('uses Application Support on macOS', () => {
    expect(defaultWisprRoot('darwin', '/Users/x'))
      .toBe('/Users/x/Library/Application Support/Wispr Flow');
  });
  it('uses AppData Roaming on Windows', () => {
    expect(defaultWisprRoot('win32', 'C:\\Users\\x'))
      .toContain('Wispr Flow');
  });
  it('returns null on unsupported platforms', () => {
    expect(defaultWisprRoot('linux', '/home/x')).toBeNull();
  });
});

describe('locateWispr', () => {
  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'wispr-'));
    writeFileSync(join(root, 'flow.sqlite'), 'x');
    mkdirSync(join(root, 'meetings'));
    return root;
  };

  it('accepts a valid override directory', async () => {
    const root = makeRoot();
    const r = await locateWispr(root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.paths.database).toBe(join(root, 'flow.sqlite'));
      expect(r.paths.meetingsDir).toBe(join(root, 'meetings'));
    }
  });

  it('reports the path it tried when the directory is missing', async () => {
    const r = await locateWispr('/nope/not/here');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.triedPath).toBe('/nope/not/here');
      expect(r.error).toMatch(/not found|does not exist/i);
    }
  });

  it('fails clearly when the directory exists but has no database', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'wispr-empty-'));
    const r = await locateWispr(empty);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/flow\.sqlite/);
  });

  it('succeeds when meetings/ is absent (no recordings yet)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wispr-nomeet-'));
    writeFileSync(join(root, 'flow.sqlite'), 'x');
    const r = await locateWispr(root);
    expect(r.ok).toBe(true);
  });

  it('fails when flow.sqlite is a directory, not a file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wispr-baddb-'));
    mkdirSync(join(root, 'flow.sqlite'));
    const r = await locateWispr(root);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/flow\.sqlite.*not a file|not a regular file/i);
      expect(r.triedPath).toBe(root);
    }
  });

  it('fails clearly when override points to a file, not a directory', async () => {
    const tempFile = mkdtempSync(join(tmpdir(), 'wispr-fileasroot-'));
    const filePath = join(tempFile, 'notadir');
    writeFileSync(filePath, 'x');
    const r = await locateWispr(filePath);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not a folder|not a directory|not a valid folder/i);
      expect(r.triedPath).toBe(filePath);
    }
  });

  it('does not throw on stat errors', async () => {
    // Test with an impossible path to ensure no throw occurs
    const r = await locateWispr('/dev/null/impossible/path/wispr');
    expect(r.ok).toBe(false);
    // Should return a proper error, not throw
    if (!r.ok) {
      expect(r.triedPath).toBeDefined();
    }
  });
});
