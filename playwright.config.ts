import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 60000,
  retries: 0,
  workers: 8,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'ui',
      testDir: './tests/ui',
      testMatch: '**/*.spec.ts',
      use: {
        browserName: 'chromium',
        headless: true,
      },
    },
    {
      name: 'electron',
      testDir: './tests/e2e',
      testMatch: '**/*.spec.ts',
    },
  ],
  webServer: {
    command: 'npx vite --port 5173',
    port: 5173,
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/reports', open: 'never' }],
  ],
});
