import { build } from 'esbuild';
await build({
  entryPoints: ['src/content/index.ts'],
  outfile: 'dist/content.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
});
