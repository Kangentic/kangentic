/**
 * E2E tests for Kimi session suspend / resume.
 *
 * Mirrors codex-session-resume.spec.ts but exercises the Kimi adapter:
 *  - PTY `fromOutput` regex captures the welcome banner's "Session: <uuid>" line
 *  - Resume reuses the same UUID via `--session <uuid>` (Kimi accepts the same
 *    flag for both initial creation with a caller-owned UUID and for resume)
 *  - The agent_session_id is preserved in the DB across the suspend/resume
 *    transition - no new UUID gets minted.
 *
 * Uses tests/fixtures/mock-kimi which:
 *   - Prints `Session: <uuid>` in the welcome banner (matched by adapter)
 *   - Detects resume by checking for an existing wire.jsonl on disk
 *   - Prints `MOCK_KIMI_RESUMED:<uuid>` when --session targets an existing
 *     session, or `MOCK_KIMI_SESSION:<uuid>` for a fresh spawn
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

const TEST_NAME = 'kimi-session-resume';
const runId = Date.now();
const PROJECT_NAME = `Kimi Resume Test ${runId}`;

function writeTestConfig(dataDir: string): void {
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
}

function extractSessionId(scrollback: string, marker: 'SESSION' | 'RESUMED'): string | null {
  const pattern = new RegExp(`MOCK_KIMI_${marker}:([a-f0-9-]+)`);
  const match = scrollback.match(pattern);
  return match ? match[1] : null;
}

test.describe('Kimi Agent - Session Resume via Column Move', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(`${TEST_NAME}-move`);
    dataDir = getTestDataDir(`${TEST_NAME}-move`);
    writeTestConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'kimi');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupKimiSessionsForCwd(tmpDir);
    cleanupTempProject(`${TEST_NAME}-move`);
    cleanupTestDataDir(`${TEST_NAME}-move`);
  });

  test('moving Planning -> Done -> unarchive resumes Kimi with same session ID', async () => {
    const title = `Kimi Move Resume ${runId}`;
    await createTask(page, title, 'Test Kimi suspend and resume via Done/unarchive');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn fresh Kimi session.
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    const scrollback1 = await waitForScrollback(page, 'MOCK_KIMI_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // Suspend (Done).
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
    await page.waitForTimeout(2000);

    // Resume (unarchive).
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback2 = await waitForScrollback(page, 'MOCK_KIMI_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();
    expect(resumedSessionId).toBe(originalSessionId);
  });
});
