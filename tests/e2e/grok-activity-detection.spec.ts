/**
 * E2E tests for Grok Build activity detection + the hook pipeline.
 *
 * Grok's runtime strategy is `ActivityDetection.hooksAndPty()`: Claude-
 * compatible hooks are the primary activity source, delivered through a
 * static per-cwd hook file (`<cwd>/.grok/hooks/kangentic.json`, written by
 * GrokCommandBuilder at spawn) whose bridge commands resolve the per-session
 * events path from the spawn env (`env:KANGENTIC_EVENTS_PATH`). The
 * `updates.jsonl` tail provides usage telemetry and backstop activity hints.
 *
 * mock-grok.js emulates the real CLI end to end: it writes the real session
 * store layout AND executes the hook file's commands with grok-shaped
 * payloads (inheriting the PTY env), so these specs exercise the FULL
 * production pipeline inside the app:
 *
 *  - Spawned Grok session appears in the activity IPC map and settles idle
 *  - Hook-driven events (prompt, tool_start with the extracted grok fields,
 *    idle with the Stop reason) land in the events cache - proving the hook
 *    file content, the env routing, the event-bridge `env:` sentinel, and
 *    GrokStatusParser.parseEvent as one chain
 *  - With hooks suppressed (MOCK_GROK_NO_HOOKS=1, the untrusted-folder
 *    path), activity still settles idle via the PTY fallback
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  cleanupGrokSessionsForCwd,
  getTestDataDir,
  cleanupTestDataDir,
  mockAgentPath,
  setProjectDefaultAgent,
  waitForScrollback,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState, SessionEvent } from '../../src/shared/types';

// Each describe block launches its own Electron app against its own isolated
// KANGENTIC_DATA_DIR and tmpDir (unique TEST_NAME per block); mode:'parallel'
// dispatches each to a separate worker process, so the MOCK_GROK_NO_HOOKS
// process.env mutation in the second block is fully isolated.
test.describe.configure({ mode: 'parallel' });

const runId = Date.now();

function writeAgentConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      agent: {
        cliPaths: { grok: mockAgentPath('grok') },
        permissionMode: 'acceptEdits',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: { worktreesEnabled: false },
    }),
  );
}

test.describe('Grok Agent - hook-driven activity detection', () => {
  const TEST_NAME = 'grok-activity-detection';
  const PROJECT_NAME = `Grok Activity Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeAgentConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'grok');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupGrokSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  // ONE self-contained test: this file runs in mode:'parallel', where every
  // test gets its own worker (and its own app via beforeAll), so a second
  // test can never observe a spawn made by the first.
  test('spawned Grok session settles idle and its hook events reach the events cache', async () => {
    test.slow();
    const title = `Grok Activity ${runId}`;
    await createTask(page, title, 'Verify hook-driven activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_GROK_SESSION:');

    // The mock fires the Stop hook (-> idle event via the events pipeline)
    // and its updates.jsonl ends with turn_completed (-> Activity.Idle via
    // the history tail); the PTY silence timer also lands idle. Any path
    // satisfies the assertion within 15s.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');

    // Hook chain end to end: the mock executes the commands from the hook
    // file GrokCommandBuilder wrote, those commands run the REAL
    // event-bridge with the `env:KANGENTIC_EVENTS_PATH` sentinel resolved
    // from the PTY env, and GrokStatusParser.parseEvent feeds the cache.
    await expect.poll(async () => {
      const eventsMap = await page.evaluate(() => window.electronAPI.sessions.getEventsCache());
      const allEvents = Object.values(eventsMap as Record<string, SessionEvent[]>).flat();
      const hasPrompt = allEvents.some((event) => event.type === 'prompt' && event.detail === undefined);
      const hasToolStart = allEvents.some((event) =>
        event.type === 'tool_start'
        && event.tool === 'read_file'
        && event.toolId === 'call-mock-1'
        && event.detail === 'hello.txt');
      const hasIdleWithReason = allEvents.some((event) => event.type === 'idle' && event.detail === 'end_turn');
      return hasPrompt && hasToolStart && hasIdleWithReason;
    }, {
      timeout: 30000,
      message: 'Expected prompt + tool_start(read_file/call-mock-1/hello.txt) + idle(end_turn) hook events in the cache',
    }).toBe(true);
  });
});

test.describe('Grok Agent - PTY fallback when hooks do not fire (MOCK_GROK_NO_HOOKS=1)', () => {
  const TEST_NAME = 'grok-pty-fallback';
  const PROJECT_NAME = `Grok Fallback Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    // The untrusted-folder path: real grok silently skips project hooks when
    // the folder is not trusted, which is exactly "hooks never fire". The
    // hooksAndPty strategy must settle activity via the PTY silence timer.
    process.env.MOCK_GROK_NO_HOOKS = '1';

    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeAgentConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
    await setProjectDefaultAgent(page, 'grok');
  });

  test.afterAll(async () => {
    delete process.env.MOCK_GROK_NO_HOOKS;
    await closeApp(app);
    cleanupGrokSessionsForCwd(tmpDir);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('session settles to idle through the PTY silence fallback', async () => {
    test.slow();
    const title = `Grok Fallback ${runId}`;
    await createTask(page, title, 'Verify PTY fallback when hooks are gated off');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_GROK_SESSION:');

    // No hook events at all; the mock goes silent after its banner, so only
    // the PTY silence timer (or the updates.jsonl turn_completed hint) can
    // settle the session. The longer timeout covers the silence threshold.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 30000 }).toContain('idle');
  });
});
