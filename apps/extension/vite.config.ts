import { defineConfig } from 'vite';
import { manifest } from './manifest';
export default defineConfig({
  plugins: [
    {
      name: 'manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: JSON.stringify(manifest, null, 2),
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        popup: 'popup.html',
        options: 'options.html',
        sidepanel: 'sidepanel.html',
        background: 'src/background/index.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background'
            ? 'background.js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
});
