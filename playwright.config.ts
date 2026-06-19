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
  throw new Error(`No free port found in range ${start}-${start + 99}`);
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
  // Top-level cap on parallelism: a per-project `workers` can go BELOW this but
  // never above it (Playwright caps per-project to the global). 8 on CI so the
  // ui and electron shards can each run 8 workers; 4 locally. The electron
  // project also sets 8 (CI Linux) / 1 (Windows/local) below.
  workers: process.env.CI ? 8 : 4,
  // Sweep leaked app-under-test Electron instances before and after every run.
  // These hooks run once per invocation for every project filter, including
  // CI's `--project=ui` run on Linux, where the sweep finds nothing and is a
  // fast no-op that never throws. See tests/e2e/electron-janitor.ts.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
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
      // CI-only single retry: the UI suite has a few timing-sensitive specs
      // (drag-and-drop settle/animation) that flake under load. A retry marks
      // them "flaky" (still visible) rather than failing the whole run on one
      // flake. Mirrors the `electron` project. Local runs keep retries: 0.
      retries: process.env.CI ? 1 : 0,
      use: {
        browserName: 'chromium',
        headless: true,
      },
    },
    {
      name: 'electron',
      testDir: './tests/e2e',
      testMatch: '**/*.spec.ts',
      // Windows cannot run concurrent electron.launch(), and a local run (any OS)
      // should not spawn a swarm of app windows - so workers=1 there. On CI's
      // headless Linux runners (xvfb) concurrent launches are safe, so use 4 to
      // parallelize the per-file app launch/teardown overhead within each shard.
      // 8 on CI Linux (capped by the top-level `workers: 8` above - both must
      // allow it). 8 >= the max spec files a shard lands (~5-6), so a shard
      // launches all its files in ONE wave instead of a serial 2nd wave
      // (~25s/file of app launch + teardown). Windows/local stay at 1 (no
      // concurrent electron.launch()). Per-file teardown is I/O-bound and
      // overlaps cleanly; per-pid temp-dir isolation keeps launches safe.
      workers: process.env.CI && process.platform !== 'win32' ? 8 : 1,
      // Slowest legitimate test is ~15s; 45s gives ~3x headroom while still
      // catching hangs faster than the global 60s default. The 45s budget
      // also covers `afterAll` Electron app close + PTY cleanup, which can
      // hit ~25-35s on Windows under suite load. Specs that legitimately
      // need longer (multi-phase restart scenarios) opt in via `test.slow()`.
      timeout: 45_000,
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
  // On CI: `list` only, so each shard's job log prints a line per test as it runs.
  // The per-shard logs ARE the results - there is no merged-report job (see
  // .github/workflows/ci.yml). Locally: human-readable list + on-demand HTML.
  reporter: process.env.CI
    ? [['list']]
    : [
        ['list'],
        ['html', { outputFolder: 'tests/reports', open: 'never' }],
      ],
});
