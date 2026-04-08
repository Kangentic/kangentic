/**
 * E2E tests for Codex agent session suspend and resume.
 *
 * Mirrors session-resume.spec.ts (Claude) but exercises the Codex adapter:
 *  - PTY `fromOutput` capture catches `session id: <uuid>` startup header
 *  - Resume command uses `codex resume <id> -C <cwd>` subcommand form
 *  - Same agent_session_id is preserved across suspend/resume
 *
 * Uses tests/fixtures/mock-codex which prints both:
 *   `session id: <uuid>`        -> matched by Codex adapter fromOutput regex
 *   `MOCK_CODEX_SESSION:<uuid>` -> stable marker for the test to assert on
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
  waitForRunningSession,
  waitForNoRunningSession,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'codex-session-resume';
const runId = Date.now();
const PROJECT_NAME = `Codex Resume Test ${runId}`;

function writeTestConfig(dataDir: string): void {
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
}

function extractSessionId(scrollback: string, marker: 'SESSION' | 'RESUMED'): string | null {
  const pattern = new RegExp(`MOCK_CODEX_${marker}:([a-f0-9-]+)`);
  const match = scrollback.match(pattern);
  return match ? match[1] : null;
}

test.describe('Codex Agent -- Session Resume via Column Move', () => {
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
    await setProjectDefaultAgent(page, 'codex');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(`${TEST_NAME}-move`);
    cleanupTestDataDir(`${TEST_NAME}-move`);
  });

  test('moving Planning -> Done -> unarchive resumes Codex with same session ID', async () => {
    const title = `Codex Move Resume ${runId}`;
    await createTask(page, title, 'Test Codex suspend and resume via Done/unarchive');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // --- Move to Planning -> spawns fresh Codex session ---
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    const scrollback1 = await waitForScrollback(page, 'MOCK_CODEX_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // --- Move to Done -> suspends + archives ---
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
    await page.waitForTimeout(2000);

    // --- Unarchive back to Planning -> should RESUME with same ID ---
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback2 = await waitForScrollback(page, 'MOCK_CODEX_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();
    expect(resumedSessionId).toBe(originalSessionId);
  });
});
