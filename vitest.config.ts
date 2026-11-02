import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const alias = {
  '@inkmesh/crdt': source('./packages/crdt/src/index.ts'),
  '@inkmesh/protocol': source('./packages/protocol/src/index.ts'),
  '@inkmesh/sync': source('./packages/sync/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'crdt', include: ['packages/crdt/test/**/*.test.ts'] } },
      {
        resolve: { alias },
        test: { name: 'protocol', include: ['packages/protocol/test/**/*.test.ts'] },
      },
      { resolve: { alias }, test: { name: 'sync', include: ['packages/sync/test/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'server', include: ['apps/server/test/**/*.test.ts'] } },
      { resolve: { alias }, test: { name: 'web', include: ['apps/web/test/**/*.test.ts'] } },
    ],
  },
});
