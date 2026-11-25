import { build } from 'esbuild';
await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  alias: {
    '@formpilot/contracts': '../../packages/contracts/src/index.ts',
    '@formpilot/config': '../../packages/config/src/index.ts',
    '@formpilot/ai': '../../packages/ai/src/index.ts',
    '@formpilot/domain': '../../packages/domain/src/index.ts',
  },
});
