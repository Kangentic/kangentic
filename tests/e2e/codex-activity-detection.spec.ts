/**
 * E2E test for Codex activity detection.
 *
 * Codex's runtime strategy is `ActivityDetection.pty()` -- the Rust CLI
 * does not honor `.codex/hooks.json` so activity is derived purely from
 * PTY silence. This spec verifies that:
 *  - A spawned Codex session shows up in the activity IPC map
 *  - The session settles to 'idle' once the mock stops emitting output
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
  setProjectDefaultAgent,
  waitForScrollback,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState } from '../../src/shared/types';

const TEST_NAME = 'codex-activity-detection';
const runId = Date.now();
const PROJECT_NAME = `Codex Activity Test ${runId}`;

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
        cliPaths: { codex: mockAgentPath('codex') },
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
  await setProjectDefaultAgent(page, 'codex');
});

test.afterAll(async () => {
  await app?.close();
  cleanupTempProject(TEST_NAME);
  cleanupTestDataDir(TEST_NAME);
});

test.describe('Codex Agent -- Activity Detection (PTY only)', () => {
  test('spawned Codex session reports activity and settles to idle', async () => {
    const title = `Codex Activity ${runId}`;
    await createTask(page, title, 'Verify pty-only activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_CODEX_SESSION:');

    // PTY-only strategy: with no further mock output, the silence-based
    // detector should land us on 'idle' within a few seconds.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');
  });
});
