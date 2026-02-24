import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  workers: 8, // Each test suite launches its own isolated Electron app
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.spec.ts',
    },
  ],
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/reports', open: 'never' }],
  ],
});
