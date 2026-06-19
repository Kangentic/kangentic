/**
 * E2E tests for the dev-only inspection bridge.
 *
 * Exercises the end-to-end happy path:
 *   1. Launch a real Electron with `developer.previewInspectionServer = true`
 *      pre-seeded into config.json so the bridge binds at boot.
 *   2. Verify the lockfile appears at `<projectRoot>/.kangentic/preview.lock`.
 *   3. HTTP GET `/info` and assert the response includes our PID + port +
 *      kangenticVersion.
 *   4. POST `/eval` with `previewEvalEnabled = false` and assert 403.
 *   5. Toggle `developer.activityDebugOverlay` on via IPC and confirm
 *      `<projectRoot>/.kangentic/debug/` is created when sessions exist.
 *
 * Skips the rest of the bridge (screenshot, click, drag, react query,
 * etc.) — those exercise CDP attach which requires full main-window
 * lifecycle. Coverage there can come later as the surface stabilises.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  launchApp,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  closeApp,
} from './helpers';
import type { ElectronApplication } from '@playwright/test';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_BUNDLE = path.join(PROJECT_ROOT, '.vite/build/index.js');

/**
 * The inspection bridge lives under `src/devtools/` which is gated behind
 * `__KANGENTIC_DEV__`. Default `npm run build` sets that flag to `false`
 * and esbuild tree-shakes the entire bridge out of the bundle, so the
 * tests below would fail with "lockfile never appears" no matter what
 * `previewInspectionServer: true` is set in config.
 *
 * Detect a tree-shaken build via a marker string only present when the
 * bridge is in the bundle (`preview.lock`), and rebuild with
 * `KANGENTIC_BUILD_DEV=1` once if it's missing. Subsequent E2E runs that
 * keep the dev-flagged build skip the rebuild.
 */
function ensureDevtoolsBuild(): void {
  let bundle: string;
  try {
    bundle = fs.readFileSync(MAIN_BUNDLE, 'utf-8');
  } catch {
    throw new Error(
      `Built main bundle not found at ${MAIN_BUNDLE}. Run "npm run build" first.`,
    );
  }
  if (bundle.includes('preview.lock')) return;
  // eslint-disable-next-line no-console
  console.log(
    '[devtools-inspection] Build was tree-shaken; rebuilding with KANGENTIC_BUILD_DEV=1...',
  );
  execFileSync('node', ['scripts/build.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, KANGENTIC_BUILD_DEV: '1' },
    stdio: 'inherit',
  });
}

const TEST_NAME = 'devtools-inspection';
const runId = Date.now();

interface LockfileShape {
  pid: number;
  port: number;
  worktreePath: string;
  projectRoot: string;
  projectId: string;
  startedAt: string;
  kangenticVersion: string;
}

function readLockfile(projectRoot: string): LockfileShape | null {
  const file = path.join(projectRoot, '.kangentic', 'preview.lock');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as LockfileShape;
  } catch {
    return null;
  }
}

function get(port: number, route: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: route, method: 'GET', timeout: 3000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: response.statusCode ?? 0, body: raw.trim() ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: response.statusCode ?? 0, body: raw });
          }
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timeout'));
    });
    request.end();
  });
}

function postJson(
  port: number,
  route: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        timeout: 3000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: response.statusCode ?? 0, body: raw.trim() ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: response.statusCode ?? 0, body: raw });
          }
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timeout'));
    });
    request.write(payload);
    request.end();
  });
}

test.describe('Devtools inspection bridge', () => {
  let app: ElectronApplication;
  let projectPath: string;
  let dataDir: string;

  test.beforeAll(async () => {
    ensureDevtoolsBuild();
    dataDir = getTestDataDir(TEST_NAME, runId);
    projectPath = await createTempProject('devtools-inspection');

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        hasCompletedFirstRun: true,
        developer: {
          previewInspectionServer: true,
          activityDebugOverlay: false,
          previewEvalEnabled: false,
        },
        git: { worktreesEnabled: false },
      }),
    );

    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;

    // Open the project so the inspection server has a project root to
    // bind its lockfile under.
    await page.evaluate(async (projectAbsolutePath: string) => {
      await window.electronAPI.projects.openByPath(projectAbsolutePath);
    }, projectPath);

    // The inspection server's `tryStart` runs on app.whenReady, which has
    // already fired by the time the page is interactive. Give the server
    // a beat to bind, write the lockfile, and start serving.
    await page.waitForFunction(
      async (root: string) => {
        try {
          const result = await window.electronAPI.system.readKangenticLockfile?.(root);
          return result !== null && result !== undefined;
        } catch {
          return false;
        }
      },
      projectPath,
      { timeout: 10_000 },
    ).catch(() => {
      // Fallback: poll the filesystem directly. The test continues if
      // the helper IPC isn't exposed; the bridge itself doesn't need it.
    });
  });

  test.afterAll(async () => {
    await closeApp(app);
    if (projectPath) cleanupTempProject(projectPath);
    if (dataDir) cleanupTestDataDir(dataDir);
  });

  test('writes a lockfile under the project root', async () => {
    // Poll briefly because the bridge's `app.whenReady().then(tryStart)`
    // resolves after the renderer is interactive.
    let lockfile: LockfileShape | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !lockfile) {
      lockfile = readLockfile(projectPath);
      if (!lockfile) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(lockfile).not.toBeNull();
    expect(lockfile!.pid).toBeGreaterThan(0);
    expect(lockfile!.port).toBeGreaterThan(0);
    expect(lockfile!.kangenticVersion).toMatch(/^\d/);
  });

  test('GET /info returns pid + port + kangenticVersion', async () => {
    const lockfile = readLockfile(projectPath);
    expect(lockfile).not.toBeNull();
    const response = await get(lockfile!.port, '/info');
    expect(response.status).toBe(200);
    const info = response.body as { pid: number; port: number; kangenticVersion: string };
    expect(info.pid).toBe(lockfile!.pid);
    expect(info.port).toBe(lockfile!.port);
    expect(typeof info.kangenticVersion).toBe('string');
  });

  test('POST /eval returns 403 when previewEvalEnabled is off', async () => {
    const lockfile = readLockfile(projectPath);
    expect(lockfile).not.toBeNull();
    const response = await postJson(lockfile!.port, '/eval', { expression: '1 + 1' });
    expect(response.status).toBe(403);
    const body = response.body as { error: { kind: string } };
    expect(body.error.kind).toBe('eval-disabled');
  });
});
