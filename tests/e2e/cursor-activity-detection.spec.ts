/**
 * E2E test for Cursor CLI activity detection.
 *
 * Cursor's runtime strategy is `ActivityDetection.pty()` - the CLI has no
 * hooks system, so activity is derived purely from PTY silence. This spec
 * verifies that:
 *  - A spawned Cursor session shows up in the activity IPC map
 *  - The session settles to 'idle' once the mock stops emitting output
 *  - The mock CLI receives the correct prompt and mode flags
 *  - Session suspend (move to Done) and resume (unarchive) work correctly
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
  closeApp,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState } from '../../src/shared/types';

// Each describe block launches its own Electron app against a unique
// KANGENTIC_DATA_DIR and tmpDir. Running them in parallel on the available
// workers cuts the file wall-clock by roughly half (2 describes, each ~30s
// serial) and eliminates the 20-30s inter-describe gap that inflated shard
// 4/10 to 115s. No shared mutable state between the blocks.
test.describe.configure({ mode: 'parallel' });

const runId = Date.now();

test.describe('Cursor Agent - Activity Detection', () => {
  const TEST_NAME = 'cursor-activity-detection';
  const PROJECT_NAME = `Cursor Activity Test ${runId}`;

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
          cliPaths: { cursor: mockAgentPath('cursor') },
          permissionMode: 'default',
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
    await setProjectDefaultAgent(page, 'cursor');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('spawned Cursor session reports activity and settles to idle', async () => {
    const title = `Cursor Activity ${runId}`;
    await createTask(page, title, 'Verify pty-only activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Move to Planning - triggers agent spawn
    await moveTaskIpc(page, taskId, swimlaneIds.planning);

    // Wait for mock CLI to start and emit session marker
    await waitForScrollback(page, 'MOCK_CURSOR_SESSION:');

    // PTY-only strategy: with no further mock output, the silence-based
    // detector should land us on 'idle' within a few seconds.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');
  });

  test('prompt is delivered to the mock CLI', async () => {
    const title = `Cursor Prompt ${runId}`;
    const description = 'Verify prompt delivery via PTY';
    await createTask(page, title, description);

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);

    // The mock CLI outputs MOCK_CURSOR_PROMPT:<text> when it receives a prompt.
    // The default prompt template includes the task title.
    const scrollback = await waitForScrollback(page, 'MOCK_CURSOR_PROMPT:', 15000);
    expect(scrollback).toContain('MOCK_CURSOR_PROMPT:');
  });

  test('plan permission mode emits stream-json (non-interactive)', async () => {
    // Cursor CLI does not have a native --plan flag. Cursor's
    // --output-format stream-json is the only way to surface the model
    // and session_id to the ContextBar, and it requires --print. The
    // default Planning swimlane ships with permission_mode='plan'
    // (see src/main/db/migrations/project-schema.ts:229), so the Cursor
    // adapter routes it to -p + --output-format stream-json. An
    // interactive-but-telemetry-less spawn would leave ContextBar stuck
    // on "Starting agent...".
    const title = `Cursor Mode ${runId}`;
    await createTask(page, title, 'Verify non-interactive stream-json mode');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);

    // mock-cursor.js writes MOCK_CURSOR_MODE: and the stream-json init event
    // as two separate console.log calls, so they can land in two separate
    // PTY chunks - waiting on the first marker alone raced the second's
    // arrival. Wait on the later-arriving marker instead: scrollback is
    // append-only, so its presence guarantees the earlier line already
    // landed too.
    const scrollback = await waitForScrollback(page, '"subtype":"init"', 15000);
    expect(scrollback).toContain('MOCK_CURSOR_MODE:noninteractive');
    // And the stream-json init event is present so ContextBar can light up.
    expect(scrollback).toContain('"subtype":"init"');
  });
});

// "Idle Detection with TUI Redraws" coverage moved to
// agent-activity-special-modes.spec.ts so it can share an Electron launch
// with the codex/cursor/copilot/warp special-mode regression guards.

test.describe('Cursor Agent - Session Lifecycle', () => {
  const TEST_NAME = 'cursor-session-lifecycle';
  const PROJECT_NAME = `Cursor Lifecycle Test ${runId}`;

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
          cliPaths: { cursor: mockAgentPath('cursor') },
          permissionMode: 'default',
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
    await setProjectDefaultAgent(page, 'cursor');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('moving to Done suspends the session', async () => {
    const title = `Cursor Suspend ${runId}`;
    await createTask(page, title, 'Verify session suspend on move to Done');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn session by moving to Planning
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_CURSOR_SESSION:');

    // Move to Done - should suspend the session
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
  });
});
