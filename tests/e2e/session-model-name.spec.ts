/**
 * E2E tests for model name resolution on the task card.
 *
 * REGRESSION: Gemini task cards showed "Loading agent..." forever because
 * captureSessionIdFromFilesystem had a 10s budget that was too short and
 * a redundant double-scan added 0-5s of latency before the file watcher
 * could start tailing the session file for model name data.
 *
 * These tests verify the full pipeline for each agent:
 *   Claude:  status.json -> StatusFileReader -> usage with model name -> card
 *   Codex:   rollout JSONL -> captureSessionIdFromFilesystem -> locate ->
 *            FileWatcher -> parse -> usage with model name -> card
 *   Gemini:  session JSON -> captureSessionIdFromFilesystem -> locate ->
 *            FileWatcher -> parse -> usage with model name -> card
 *
 * Each test spawns a real agent session (using mock CLIs that write
 * realistic session files) and waits for the task card to display the
 * model name, proving the entire telemetry pipeline works end-to-end.
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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

// ---- Claude ----

test.describe('Claude Agent - Model Name on Card', () => {
  const TEST_NAME = 'claude-model-name';
  const runId = Date.now();
  const PROJECT_NAME = `Claude Model Test ${runId}`;
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
          cliPaths: { claude: mockAgentPath('claude') },
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
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('card shows model name from status.json after session starts', async () => {
    const title = `Claude Model ${runId}`;
    await createTask(page, title, 'Verify model name resolution');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn Claude session
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_CLAUDE_SESSION:');

    // Write a synthetic status.json. The session dir is at
    // <project>/.kangentic/sessions/<sessionId>/status.json.
    // Find the session ID from IPC.
    const sessionId = await page.evaluate(async (id: string) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((t: { id: string }) => t.id === id);
      return task?.session_id ?? null;
    }, taskId);
    expect(sessionId).toBeTruthy();

    const statusDir = path.join(tmpDir, '.kangentic', 'sessions', sessionId!);
    fs.mkdirSync(statusDir, { recursive: true });
    const statusContent = JSON.stringify({
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
    });
    fs.writeFileSync(path.join(statusDir, 'status.json'), statusContent);

    // Wait for the card to show the model name
    const usageBar = page.locator(`[data-task-id="${taskId}"] [data-testid="usage-bar"]`);
    await expect(usageBar).toBeVisible({ timeout: 15000 });
    await expect(usageBar).toContainText('Sonnet 4.6', { timeout: 15000 });
    // Must NOT show the loading spinner
    await expect(usageBar).not.toContainText('Loading agent...');
  });
});

// ---- Codex ----

test.describe('Codex Agent - Model Name on Card', () => {
  const TEST_NAME = 'codex-model-name';
  const runId = Date.now();
  const PROJECT_NAME = `Codex Model Test ${runId}`;
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

  test('card shows model name from rollout JSONL after session starts', async () => {
    const title = `Codex Model ${runId}`;
    await createTask(page, title, 'Verify model name resolution');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn Codex session. mock-codex writes a rollout JSONL with
    // model='mock-codex-model' and token counts. The pipeline should:
    // 1. captureSessionIdFromFilesystem finds the rollout file
    // 2. locate() finds the same file
    // 3. FileWatcher tails it
    // 4. parse() extracts model + tokens
    // 5. Card shows model name
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_CODEX_SESSION:');

    // Wait for the card to show the model name from the rollout JSONL.
    // mock-codex writes model='mock-codex-model' in the turn_context entry.
    const usageBar = page.locator(`[data-task-id="${taskId}"] [data-testid="usage-bar"]`);
    await expect(usageBar).toBeVisible({ timeout: 15000 });
    await expect(usageBar).toContainText('mock-codex-model', { timeout: 15000 });
    await expect(usageBar).not.toContainText('Loading agent...');
  });
});

// ---- Gemini ----

test.describe('Gemini Agent - Model Name on Card', () => {
  const TEST_NAME = 'gemini-model-name';
  const runId = Date.now();
  const PROJECT_NAME = `Gemini Model Test ${runId}`;
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
          cliPaths: { gemini: mockAgentPath('gemini') },
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
    await setProjectDefaultAgent(page, 'gemini');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('card shows model name from session JSON after session starts', async () => {
    const title = `Gemini Model ${runId}`;
    await createTask(page, title, 'Verify model name resolution');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn Gemini session. mock-gemini writes a session JSON with
    // model='gemini-3-flash-preview' and token counts. The pipeline should:
    // 1. captureSessionIdFromFilesystem finds the session file
    // 2. locate() gets cached path from capture
    // 3. FileWatcher tails the file
    // 4. parse() extracts model + tokens
    // 5. Card shows model name
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_GEMINI_SESSION:');

    // Wait for the card to show the model name from the session JSON.
    // mock-gemini writes model='gemini-3-flash-preview' in the messages array.
    const usageBar = page.locator(`[data-task-id="${taskId}"] [data-testid="usage-bar"]`);
    await expect(usageBar).toBeVisible({ timeout: 15000 });
    await expect(usageBar).toContainText('gemini-3-flash-preview', { timeout: 15000 });
    await expect(usageBar).not.toContainText('Loading agent...');
  });
});
