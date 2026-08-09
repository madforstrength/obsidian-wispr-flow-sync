import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  minify: production,
  treeShaking: true,
  // Obsidian and Node builtins are provided by the host at runtime.
  external: ['obsidian', 'electron', 'fs', 'path', 'os', 'node:fs', 'node:path', 'node:os'],
});

if (production) { await ctx.rebuild(); await ctx.dispose(); }
else { await ctx.watch(); }
