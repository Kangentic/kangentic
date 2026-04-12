import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';

function isPortFree(port: number): boolean {
  try {
    // Connect as a client to catch listeners on both IPv4 and IPv6.
    // Uses execFileSync (no shell) to avoid Windows quote-escaping issues.
    execFileSync('node', [
      '-e',
      `var s=require("net").createConnection({port:${port},host:"localhost"},function(){s.end();process.exit(1)});s.on("error",function(){process.exit(0)})`,
    ], { timeout: 2000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findFreePort(start: number): number {
  for (let port = start; port < start + 100; port++) {
    if (isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}–${start + 99}`);
}

const isWorktree = __dirname.replace(/\\/g, '/').includes('.kangentic/worktrees/');
const explicitPort = parseInt(process.env.VITE_PORT || '', 10);
const inheritedPort = parseInt(process.env.PLAYWRIGHT_VITE_PORT || '', 10);
const vitePort = explicitPort || inheritedPort || findFreePort(isWorktree ? 5174 : 5173);
const reuseServer = !!explicitPort;

process.env.PLAYWRIGHT_VITE_PORT = String(vitePort);

export default defineConfig({
  timeout: 60000,
  retries: 0,
  workers: 4,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'ui',
      testDir: './tests/ui',
      testMatch: '**/*.spec.ts',
      timeout: 15_000,
      use: {
        browserName: 'chromium',
        headless: true,
      },
    },
    {
      name: 'electron',
      testDir: './tests/e2e',
      testMatch: '**/*.spec.ts',
      workers: 1,
      // Retries are CI-only. Local /test runs do not pay 2x cost on the
      // occasional Windows Electron debug-pipe flake; CI keeps the safety net
      // to avoid PR-blocking transients.
      retries: process.env.CI ? 1 : 0,
    },
    {
      name: 'captures',
      testDir: './tests/captures',
      testMatch: '**/*.capture.ts',
      timeout: 30_000,
      workers: 1,
      use: {
        browserName: 'chromium',
        headless: true,
      },
    },
  ],
  webServer: {
    command: `npx vite --port ${vitePort}`,
    port: vitePort,
    reuseExistingServer: reuseServer,
    timeout: 60000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/reports', open: 'never' }],
  ],
});
