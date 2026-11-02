import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Emits `sw.js` with the exact list of hashed build outputs. Offline reload only works if every
 * asset is cached before the network goes away, and that list only exists at build time.
 */
function serviceWorker(): Plugin {
  return {
    name: 'inkmesh-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((file) => !/\.(map|html)$/.test(file));
      const assets = ['/', '/favicon.svg', ...built.map((file) => `/${file}`)];
      const version = createHash('sha256').update(assets.sort().join()).digest('hex').slice(0, 12);
      const template = readFileSync(source('./sw/sw-template.js'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template
          .replace('__ASSETS__', JSON.stringify(assets))
          .replace('__VERSION__', version),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  resolve: {
    alias: {
      '@inkmesh/crdt': source('../../packages/crdt/src/index.ts'),
      '@inkmesh/protocol': source('../../packages/protocol/src/index.ts'),
      '@inkmesh/sync': source('../../packages/sync/src/index.ts'),
    },
  },
  server: {
    port: 41511,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://127.0.0.1:41510', ws: true } },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 800 },
});
