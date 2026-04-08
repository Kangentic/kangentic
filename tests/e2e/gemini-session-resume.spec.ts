/**
 * E2E tests for Gemini agent session suspend and resume.
 *
 * Mirrors session-resume.spec.ts (Claude) for Gemini:
 *  - PTY `fromOutput` capture catches `Session ID: <uuid>` line
 *  - Resume command uses `gemini --resume <uuid>` flag form
 *  - Same agent_session_id is preserved across suspend/resume
 *  - Merged `.gemini/settings.json` is written on spawn (hook plumbing)
 *
 * Known limitation: concurrent Gemini sessions race on `.gemini/settings.json`
 * because Gemini CLI has no per-session settings flag (see
 * gemini/command-builder.ts createMergedSettings comment). Not exercised by
 * this spec - it would need two parallel project sessions and is documented
 * upstream for a per-session settings flag PR.
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

const TEST_NAME = 'gemini-session-resume';
const runId = Date.now();
const PROJECT_NAME = `Gemini Resume Test ${runId}`;

function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      agent: {
        cliPaths: { gemini: mockAgentPath('gemini') },
        permissionMode: 'acceptEdits',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );
}

function extractSessionId(scrollback: string, marker: 'SESSION' | 'RESUMED'): string | null {
  const pattern = new RegExp(`MOCK_GEMINI_${marker}:([a-f0-9-]+)`);
  const match = scrollback.match(pattern);
  return match ? match[1] : null;
}

test.describe('Gemini Agent -- Session Resume via Column Move', () => {
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
    await setProjectDefaultAgent(page, 'gemini');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(`${TEST_NAME}-move`);
    cleanupTestDataDir(`${TEST_NAME}-move`);
  });

  test('moving Planning -> Done -> unarchive resumes Gemini with same session ID', async () => {
    const title = `Gemini Move Resume ${runId}`;
    await createTask(page, title, 'Test Gemini suspend and resume via Done/unarchive');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // --- Move to Planning -> spawns fresh Gemini session ---
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);

    const scrollback1 = await waitForScrollback(page, 'MOCK_GEMINI_SESSION:');
    const originalSessionId = extractSessionId(scrollback1, 'SESSION');
    expect(originalSessionId).toBeTruthy();

    // Verify .gemini/settings.json was written into the project cwd by the
    // command builder (this is the hook plumbing path - if the file isn't
    // there, hooks would never fire even with a real Gemini CLI).
    const geminiSettingsPath = path.join(tmpDir, '.gemini', 'settings.json');
    expect(fs.existsSync(geminiSettingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(geminiSettingsPath, 'utf-8')) as {
      hooks?: Record<string, unknown>;
    };
    expect(settings.hooks).toBeTruthy();

    // --- Move to Done -> suspend ---
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
    await page.waitForTimeout(2000);

    // --- Unarchive back -> RESUME ---
    await page.evaluate(async ({ taskId: id, swimlaneId }) => {
      await window.electronAPI.tasks.unarchive({ id, targetSwimlaneId: swimlaneId });
    }, { taskId, swimlaneId: swimlaneIds.planning });

    await waitForRunningSession(page);
    const scrollback2 = await waitForScrollback(page, 'MOCK_GEMINI_RESUMED:');
    const resumedSessionId = extractSessionId(scrollback2, 'RESUMED');
    expect(resumedSessionId).toBeTruthy();
    expect(resumedSessionId).toBe(originalSessionId);
  });
});
