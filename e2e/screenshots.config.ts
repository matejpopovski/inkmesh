import base from '../playwright.config.js';
import { defineConfig } from '@playwright/test';

/** Captures the README images from the running app. Output goes to docs/screenshots. */
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'shots/*.shots.ts',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
});
