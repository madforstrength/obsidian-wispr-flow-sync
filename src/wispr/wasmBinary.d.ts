/** Type-only companion to the generated `wasmBinary.ts`.
 *
 *  `wasmBinary.ts` is produced by `npm run inline-wasm` and is gitignored, so
 *  it does not exist in a fresh clone. Static analysis that runs against the
 *  repository without building it — Obsidian's community-plugin review
 *  scanner, for one — therefore resolved `./wasmBinary` to nothing and typed
 *  `WASM_BASE64` as `any`, which surfaced as a no-unsafe-argument warning
 *  where it is passed to `base64ToBytes(b64: string)`.
 *
 *  Declaring the shape here fixes the type in a checked-in file without
 *  committing the 558 KB generated one. When `wasmBinary.ts` is present,
 *  TypeScript prefers it and this file is inert; when it is absent, this
 *  keeps the import correctly typed as a string.
 */
export declare const WASM_BASE64: string;
