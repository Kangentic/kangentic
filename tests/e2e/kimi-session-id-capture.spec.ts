/**
 * E2E test for Kimi session-ID capture via the welcome-banner regex.
 *
 * Kimi prints a welcome banner on every spawn that includes a stable
 * `Session: <uuid>` line. The KimiAdapter's `runtime.sessionId.fromOutput`
 * regex anchors on that line and feeds the captured UUID through the
 * SessionIdScanner -> notifyAgentSessionId -> DB pipeline.
 *
 * This spec verifies the full chain by:
 *  1. Spawning a Kimi session (mock prints the banner with a fresh UUID).
 *  2. Asserting the captured ID landed in the sessions DB record.
 *  3. Suspending and resuming - if capture worked, the resume command will
 *     reuse the same UUID via `--session <id>`, and mock-kimi will print
 *     `MOCK_KIMI_RESUMED:<id>` (because the wire.jsonl already exists for
 *     that hash + UUID combo).
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  cleanupKimiSessionsForCwd,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
  setProjectDefaultAgent,
  waitForScrollback,
  waitForRunningSession,
  waitForNoRunningSession,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const runId = Date.now();

test.describe('Kimi Agent - Session ID Capture from PTY Banner', () => {
  const TEST_NAME = 'kimi-session-id-capture';
  const PROJECT_NAME = `Kimi Capture Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { kimi: mockAgentPath('kimi') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );
    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'kimi');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('captured banner UUID flows through to the resume command', async () => {
    const title = `Kimi Capture ${runId}`;
    await createTask(page, title, 'Verify Session: <uuid> banner regex through suspend/resume');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn Kimi - mock prints the banner with a fresh UUID.
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    const scrollback1 = await waitForScrollback(page, 'MOCK_KIMI_SESSION:');

    const sessionMatch = scrollback1.match(/MOCK_KIMI_SESSION:([a-f0-9-]+)/);
    expect(sessionMatch).toBeTruthy();
    const originalSessionId = sessionMatch![1];

    // Suspend by moving to Done.
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);

    // Resume by unarchiving back to Planning. If the PTY scraper captured
    // the UUID from the banner, the resume command will be:
    //   kimi -w <cwd> --session <originalSessionId> ...
    // The mock detects the existing wire.jsonl under <hash>/<uuid>/ and
    // prints MOCK_KIMI_RESUMED:<uuid> instead of MOCK_KIMI_SESSION:<uuid>.
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback2 = await waitForScrollback(page, 'MOCK_KIMI_RESUMED:');
    const resumedMatch = scrollback2.match(/MOCK_KIMI_RESUMED:([a-f0-9-]+)/);
    expect(resumedMatch).toBeTruthy();
    expect(resumedMatch![1]).toBe(originalSessionId);
  });
});

test.describe('Kimi Agent - Session ID Capture via Filesystem Fallback', () => {
  const TEST_NAME = 'kimi-fs-capture';
  const PROJECT_NAME = `Kimi FS Capture ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    // Suppress the welcome banner so the PTY anchor never fires.
    // The fromFilesystem path (mtime-windowed scan of ~/.kimi/sessions)
    // must catch up and surface the UUID instead.
    process.env.MOCK_KIMI_NO_BANNER = '1';

    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        agent: {
          cliPaths: { kimi: mockAgentPath('kimi') },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'kimi');
  });

  test.afterAll(async () => {
    delete process.env.MOCK_KIMI_NO_BANNER;
    await app?.close();
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('resume uses filesystem-captured session ID when banner is suppressed', async () => {
    const title = `Kimi FS Capture ${runId}`;
    await createTask(page, title, 'Verify fromFilesystem capture path');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    // Without the banner, the only way to recover the UUID is to find the
    // freshly-created session directory under ~/.kimi/sessions. The mock
    // emits MOCK_KIMI_SESSION:<id> for the test to pick up the truth value.
    const scrollback1 = await waitForScrollback(page, 'MOCK_KIMI_SESSION:');
    const sessionMatch = scrollback1.match(/MOCK_KIMI_SESSION:([a-f0-9-]+)/);
    expect(sessionMatch).toBeTruthy();
    const originalSessionId = sessionMatch![1];

    // Give the filesystem fallback time to fire (it polls at 500ms).
    await page.waitForTimeout(2000);

    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);

    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback2 = await waitForScrollback(page, 'MOCK_KIMI_RESUMED:');
    const resumedMatch = scrollback2.match(/MOCK_KIMI_RESUMED:([a-f0-9-]+)/);
    expect(resumedMatch).toBeTruthy();
    expect(resumedMatch![1]).toBe(originalSessionId);
  });
});
