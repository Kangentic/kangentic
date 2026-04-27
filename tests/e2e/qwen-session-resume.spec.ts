/**
 * E2E tests for Qwen Code agent session suspend and resume.
 *
 * Mirrors gemini-session-resume.spec.ts for Qwen Code:
 *  - PTY `fromOutput` capture catches `Session ID: <uuid>` line
 *  - Resume command uses `qwen --resume <uuid>` flag form
 *  - Same agent_session_id is preserved across suspend/resume
 *  - Merged `.qwen/settings.json` is written on spawn (hook plumbing)
 *
 * Uses tests/fixtures/mock-qwen which:
 *  - Prints `Session ID: <uuid>` header (matched by adapter's fromOutput regex)
 *  - Writes a real session JSONL to ~/.qwen/projects/<sanitized-cwd>/chats/<id>.jsonl
 *  - Prints `MOCK_QWEN_SESSION:<uuid>` on fresh spawn and `MOCK_QWEN_RESUMED:<uuid>`
 *    when --resume targets an existing session
 *  - Self-cleans the JSONL on exit (no afterAll filesystem cleanup needed)
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

const TEST_NAME = 'qwen-session-resume';
const runId = Date.now();
const PROJECT_NAME = `Qwen Resume Test ${runId}`;

function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      agent: {
        cliPaths: { qwen: mockAgentPath('qwen') },
        permissionMode: 'acceptEdits',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );
}

function extractSessionId(scrollback: string, marker: 'SESSION' | 'RESUMED'): string | null {
  const pattern = new RegExp(`MOCK_QWEN_${marker}:([a-f0-9-]+)`);
  const match = scrollback.match(pattern);
  return match ? match[1] : null;
}

test.describe('Qwen Agent - Session Resume via Column Move', () => {
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
    await setProjectDefaultAgent(page, 'qwen');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(`${TEST_NAME}-move`);
    cleanupTestDataDir(`${TEST_NAME}-move`);
  });

  test('moving Planning -> Done -> unarchive resumes Qwen with same session ID', async () => {
    const title = `Qwen Move Resume ${runId}`;
    await createTask(page, title, 'Test Qwen suspend and resume via Done/unarchive');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // --- Move to Planning -> spawns fresh Qwen session ---
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    const scrollback1 = await waitForScrollback(page, 'MOCK_QWEN_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // Verify .qwen/settings.json was written into the project cwd by the
    // hook-manager (this is the hook plumbing path - if the file isn't
    // there, hooks would never fire even with a real Qwen CLI).
    const qwenSettingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    expect(fs.existsSync(qwenSettingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(qwenSettingsPath, 'utf-8')) as {
      hooks?: Record<string, unknown>;
    };
    expect(settings.hooks).toBeTruthy();

    // --- Move to Done -> suspend ---
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
    // Wait until the move-to-Done DB transaction has committed (task appears
    // in listArchived) AND the session record's agent_session_id has been
    // persisted. Without this, unarchive can race the suspend persistence
    // and either fail to find the task or resume with a stale session ID.
    await expect.poll(async () => {
      return page.evaluate(async (id) => {
        const archived: Array<{ id: string }> =
          await window.electronAPI.tasks.listArchived();
        return archived.some((task) => task.id === id);
      }, taskId);
    }, { timeout: 15000, intervals: [200, 500, 1000] }).toBe(true);

    // --- Unarchive back -> RESUME ---
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback2 = await waitForScrollback(page, 'MOCK_QWEN_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();
    expect(resumedSessionId).toBe(originalSessionId);
  });
});
