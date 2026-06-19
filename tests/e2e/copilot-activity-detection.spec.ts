/**
 * E2E test for Copilot CLI activity detection.
 *
 * Copilot's runtime strategy is `ActivityDetection.hooksAndPty()` - hooks
 * primary with PTY silence timer as fallback. This spec verifies that:
 *  - A spawned Copilot session shows up in the activity IPC map
 *  - The session settles to 'idle' once the mock stops emitting output
 *  - The Planning swimlane (permission_mode='plan') spawns successfully and
 *    emits a MOCK_COPILOT_SESSION: marker
 *  - Session suspend (move to Done) works correctly
 *  - The PTY -> CopilotStreamParser -> usageTracker -> store pipeline is
 *    wired: when MOCK_COPILOT_TUI_STATUS=1, "GPT-5 mini" appears in scrollback
 *    proving the status-bar regex path fires end-to-end
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

const runId = Date.now();

test.describe('Copilot Agent - Activity Detection', () => {
  const TEST_NAME = 'copilot-activity-detection';
  const PROJECT_NAME = `Copilot Activity Test ${runId}`;

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
          cliPaths: { copilot: mockAgentPath('copilot') },
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
    await setProjectDefaultAgent(page, 'copilot');
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('spawned Copilot session reports activity and settles to idle', async () => {
    const title = `Copilot Activity ${runId}`;
    await createTask(page, title, 'Verify hooksAndPty activity detection');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Move to Planning - triggers agent spawn
    await moveTaskIpc(page, taskId, swimlaneIds.planning);

    // Wait for mock CLI to start and emit session marker
    await waitForScrollback(page, 'MOCK_COPILOT_SESSION:');

    // hooksAndPty strategy: silence-based detector should land on 'idle'
    // once the mock stops emitting output.
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, { timeout: 15000 }).toContain('idle');
  });

  test('Planning swimlane spawns successfully and emits a session marker', async () => {
    // The default Planning swimlane has permission_mode='plan'. Copilot's
    // plan mode uses --plan flag with interactive spawn. This confirms the
    // command builder and adapter wiring produce a real PTY session rather
    // than silently failing.
    const title = `Copilot Plan ${runId}`;
    await createTask(page, title, 'Verify plan mode spawn');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);

    // Marker confirms the mock received a session ID from the adapter.
    const scrollback = await waitForScrollback(page, 'MOCK_COPILOT_SESSION:', 15000);
    expect(scrollback).toContain('MOCK_COPILOT_SESSION:');
  });

  test('moving to Done suspends the session', async () => {
    const title = `Copilot Suspend ${runId}`;
    await createTask(page, title, 'Verify session suspend on move to Done');

    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, title);

    // Spawn session by moving to Planning
    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    await waitForRunningSession(page);
    await waitForScrollback(page, 'MOCK_COPILOT_SESSION:');

    // Move to Done - should suspend the session
    await moveTaskIpc(page, taskId, swimlaneIds.done);
    await waitForNoRunningSession(page);
  });
});

// "TUI Status Bar Smoke Test" coverage moved to
// agent-activity-special-modes.spec.ts so it can share an Electron launch
// with the codex/cursor/copilot/warp special-mode regression guards.
