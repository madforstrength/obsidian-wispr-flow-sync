// Obsidian's renderer is CommonJS. A dynamic ESM `import()` of a node:
// builtin never settles there, so the plugin must use require() — called
// lazily inside a function, never at module top level, so that loading this
// module cannot fail just by being imported.
//
// Bare specifiers ('fs', not 'node:fs') are used at the require() call below
// because those are the most broadly compatible with Electron's renderer
// `require`. The `node:`-prefixed form is still used in the *type* position
// (`typeof import('node:fs')`) so typing is unaffected.
//
// This is deliberately three small one-line functions rather than a single
// generic `nodeRequire(id: string)` taking a variable: esbuild bundles a
// generic helper into ONE shared function and rewrites every call site to
// pass its module name through a parameter (`return require(id)`), so the
// literal text `require("fs")` never appears anywhere in the built artifact
// — only an indirect call like `require(id)` does. tests/bundle.test.ts
// asserts on the literal `require("fs")` text in the built main.js (the
// positive half of the regression guard for this bug), so each builtin gets
// its own function with the string literal written directly next to the
// require() call, which survives bundling and minification verbatim.
declare const require: (id: string) => unknown;

export function requireFs(): typeof import('node:fs') {
  return require('fs') as typeof import('node:fs');
}

export function requirePath(): typeof import('node:path') {
  return require('path') as typeof import('node:path');
}

export function requireOs(): typeof import('node:os') {
  return require('os') as typeof import('node:os');
}
