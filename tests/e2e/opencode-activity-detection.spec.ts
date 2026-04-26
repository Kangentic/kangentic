/**
 * E2E test for OpenCode activity detection.
 *
 * OpenCode's runtime strategy is `ActivityDetection.pty()` - the CLI has no
 * hook system, so activity is derived purely from PTY silence (same as Codex).
 * This spec verifies that:
 *  - A spawned OpenCode session shows up in the activity IPC map
 *  - The session settles to 'idle' once the mock stops emitting output
 *  - The Planning swimlane spawns successfully and emits a session marker
 *  - Moving to Done suspends the session
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
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityState } from '../../src/shared/types';

const runId = Date.now();

test.describe('OpenCode Agent - Activity Detection', () => {
  const TEST_NAME = 'opencode-activity-detection';
  const PROJECT_NAME = `OpenCode Activity Test ${runId}`;

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
          cliPaths: { opencode: mockAgentPath('opencode') },
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
    await setProjectDefaultAgent(page, 'opencode');
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('spawned OpenCode session reports activity and settles to idle', async () => {
    const title = `OpenCode Activity ${runId}`;
    await createTask(page, title, 'Verify pty-only activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForScrollback(page, 'MOCK_OPENCODE_SESSION:');

    // PTY-only strategy: with no further mock output after the startup
    // banner, the silence-based detector should land on 'idle' within
    // a few seconds (10s silence budget is the adapter default).
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 20000, message: 'Expected session to reach idle' }).toContain('idle');
  });

  test('Planning swimlane spawns successfully and emits a session marker', async () => {
    const title = `OpenCode Planning ${runId}`;
    await createTask(page, title, 'Verify Planning swimlane spawn');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);

    // The mock prints MOCK_OPENCODE_SESSION:<id> on startup. Waiting for
    // it confirms the PTY spawned and that fromOutput captured the session ID.
    const scrollback = await waitForScrollback(page, 'MOCK_OPENCODE_SESSION:');
    expect(scrollback).toContain('MOCK_OPENCODE_SESSION:');
    // Also verify the session ID header line that fromOutput uses for capture
    expect(scrollback).toContain('session id: ses_2349b5c91ffeKd6qajuUTR4clq');
  });

  test('moving to Done suspends the session', async () => {
    const title = `OpenCode Suspend ${runId}`;
    await createTask(page, title, 'Verify Done lane suspends the PTY');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn by moving to Planning
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_OPENCODE_SESSION:');

    // Confirm a session for this specific task is running before suspending
    const sessionForTask = await page.evaluate(async (id) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((session) => session.taskId === id && session.status === 'running') ?? null;
    }, taskId);
    expect(sessionForTask).not.toBeNull();

    // Suspend by moving to Done. waitForNoRunningSession polls until the
    // PTY is gone - no need for a redundant check after it returns.
    await moveTaskIpc(page, taskId, swimlaneIds.done);

    // Poll specifically for this task's session reaching a non-running state
    // to avoid depending on the global session count (other tests may still
    // have their sessions alive in idle state).
    await expect.poll(async () => {
      const sessions = await page.evaluate(async () => window.electronAPI.sessions.list());
      const taskSession = (sessions as Array<{ taskId: string; status: string }>)
        .find((session) => session.taskId === taskId);
      return taskSession?.status ?? 'not_found';
    }, { timeout: 15000, message: 'Expected task session to leave running state after Done move' })
      .not.toBe('running');
  });
});
