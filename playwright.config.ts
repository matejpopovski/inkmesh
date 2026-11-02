import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { E2E_PORT } from './e2e/support/server.js';

const databasePath =
  process.env['INKMESH_E2E_DB'] ?? join(mkdtempSync(join(tmpdir(), 'inkmesh-e2e-')), 'e2e.sqlite');
process.env['INKMESH_E2E_DB'] = databasePath;

/**
 * The suite restarts the server itself, so it owns the process instead of using `webServer`.
 * Tests run one at a time because they share that process and one of them kills it.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
