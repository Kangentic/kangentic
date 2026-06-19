/**
 * E2E tests for model name resolution on the task card.
 *
 * REGRESSION: Gemini task cards showed "Loading agent..." forever because
 * captureSessionIdFromFilesystem had a 10s budget that was too short and
 * a redundant double-scan added 0-5s of latency before the file watcher
 * could start tailing the session file for model name data.
 *
 * Each agent uses a different upstream source for model name:
 *   Claude: status.json -> StatusFileReader -> usage with model name -> card
 *   Codex:  rollout JSONL -> captureSessionIdFromFilesystem -> locate ->
 *           FileWatcher -> parse -> usage with model name -> card
 *   Gemini: session JSON -> captureSessionIdFromFilesystem -> locate ->
 *           FileWatcher -> parse -> usage with model name -> card
 *
 * Consolidated into a single describe block with one Electron launch shared
 * across all three agents. The mocks write their own session files except
 * Claude, which has its synthetic status.json planted in-test.
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
  waitForRunningSession,
  waitForScrollback,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'session-model-name';
const runId = Date.now();
const PROJECT_NAME = `Model Name Test ${runId}`;

test.describe('Agent model-name resolution on task card', () => {
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
          cliPaths: {
            claude: mockAgentPath('claude'),
            codex: mockAgentPath('codex'),
            gemini: mockAgentPath('gemini'),
          },
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
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('Claude: card shows model name from status.json after session starts', async () => {
    await setProjectDefaultAgent(page, 'claude');
    const title = `Claude Model ${runId}`;
    await createTask(page, title, 'Verify model name resolution');
    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:');

    // Look up the PTY session ID from IPC and plant a Claude-shape status.json
    // into <project>/.kangentic/sessions/<sessionId>/. The mock-claude fixture
    // does NOT write status.json on its own.
    const sessionId = await page.evaluate(async (id: string) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((t: { id: string }) => t.id === id);
      return task?.session_id ?? null;
    }, taskId);
    expect(sessionId).toBeTruthy();

    const statusDir = path.join(tmpDir, '.kangentic', 'sessions', sessionId!);
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      JSON.stringify({
        type: 'status',
        session_id: sessionId,
        model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
        token_usage: {
          input_tokens: 1500,
          cache_read_tokens: 200,
          cache_creation_tokens: 0,
          output_tokens: 100,
          total_cost_usd: 0.02,
          total_duration_ms: 5000,
          context_window_size: 200000,
        },
      }),
    );

    const usageBar = page.locator(`[data-task-id="${taskId}"] [data-testid="usage-bar"]`);
    await expect(usageBar).toBeVisible({ timeout: 15000 });
    await expect(usageBar).toContainText('Sonnet 4.6', { timeout: 15000 });
    await expect(usageBar).not.toContainText('Loading agent...');
  });

  test('Codex: card shows model name from rollout JSONL after session starts', async () => {
    await setProjectDefaultAgent(page, 'codex');
    const title = `Codex Model ${runId}`;
    await createTask(page, title, 'Verify model name resolution');
    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // mock-codex writes a rollout JSONL with model='mock-codex-model' and token
    // counts. The capture pipeline reads it and pushes through to the card.
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_CODEX_SESSION:');

    const usageBar = page.locator(`[data-task-id="${taskId}"] [data-testid="usage-bar"]`);
    await expect(usageBar).toBeVisible({ timeout: 15000 });
    await expect(usageBar).toContainText('mock-codex-model', { timeout: 15000 });
    await expect(usageBar).not.toContainText('Loading agent...');
  });

  test('Gemini: card shows model name from session JSON after session starts', async () => {
    await setProjectDefaultAgent(page, 'gemini');
    const title = `Gemini Model ${runId}`;
    await createTask(page, title, 'Verify model name resolution');
    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // mock-gemini writes a session JSON with model='gemini-3-flash-preview'
    // in the messages array. Capture pipeline picks it up.
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_GEMINI_SESSION:');

    const usageBar = page.locator(`[data-task-id="${taskId}"] [data-testid="usage-bar"]`);
    await expect(usageBar).toBeVisible({ timeout: 15000 });
    await expect(usageBar).toContainText('gemini-3-flash-preview', { timeout: 15000 });
    await expect(usageBar).not.toContainText('Loading agent...');
  });
});
