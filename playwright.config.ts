import { defineConfig } from '@playwright/test';

const isWorktree = __dirname.replace(/\\/g, '/').includes('.kangentic/worktrees/');
const vitePort = parseInt(process.env.VITE_PORT || '', 10) || (isWorktree ? 5174 : 5173);

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
    command: `npx vite --port ${vitePort}`,
    port: vitePort,
    reuseExistingServer: !isWorktree,
    timeout: 30000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/reports', open: 'never' }],
  ],
});
