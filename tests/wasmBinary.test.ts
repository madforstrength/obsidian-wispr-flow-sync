import { describe, it, expect } from 'vitest';
import { WASM_BASE64 } from '../src/wispr/wasmBinary';

describe('inlined wasm binary', () => {
  it('decodes to a valid wasm module header', () => {
    const bytes = Buffer.from(WASM_BASE64, 'base64');
    expect(bytes.length).toBeGreaterThan(100_000);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});
