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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState } from '../../src/shared/types';

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
    await app?.close();
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

    const scrollback = await waitForScrollback(page, 'MOCK_CURSOR_MODE:', 15000);
    expect(scrollback).toContain('MOCK_CURSOR_MODE:noninteractive');
    // And the stream-json init event is present so ContextBar can light up.
    expect(scrollback).toContain('"subtype":"init"');
  });
});

test.describe('Cursor Agent - Idle Detection with TUI Redraws', () => {
  const TEST_NAME = 'cursor-tui-idle';
  const PROJECT_NAME = `Cursor TUI Idle Test ${runId}`;

  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    // Enable TUI redraw simulation: mock-cursor.js will emit periodic
    // ANSI-only cursor repositioning sequences every 500ms, mimicking
    // real Cursor CLI TUI behavior when idle.
    process.env.MOCK_CURSOR_TUI_REDRAWS = '1';

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
    delete process.env.MOCK_CURSOR_TUI_REDRAWS;
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('settles to idle despite continuous TUI redraws', async () => {
    // This test verifies that Cursor tasks don't get stuck in 'active' when
    // idle. The mock emits continuous ANSI-only PTY data (cursor redraws)
    // every 500ms, mimicking real TUI behavior. The content dedup in
    // SessionManager should classify identical frames as noise. The
    // silence timer (3s) should fire and transition to idle.
    const title = `Cursor TUI Idle ${runId}`;
    await createTask(page, title, 'Verify idle detection with TUI redraws');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_CURSOR_SESSION:');

    // Despite continuous ANSI redraws every 500ms, the content dedup in
    // SessionManager should classify identical frames as noise. The
    // silence timer should fire and transition to idle.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 20000, message: 'Expected session to reach idle despite TUI redraws' }).toContain('idle');
  });
});

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
    await app?.close();
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
