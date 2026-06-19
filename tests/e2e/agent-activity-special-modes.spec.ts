/**
 * Consolidated coverage for agent-specific activity detection regression
 * guards: TUI redraw silence, status-bar parsing, active-output transitions.
 *
 * Replaces four single-test "describe 2" blocks across codex/cursor/copilot/
 * warp activity-detection specs. Each agent's mode is enabled via an
 * agent-prefixed mock env var (no cross-agent conflict), so all four can
 * share one Electron launch.
 *
 * Coverage matrix:
 *   - codex   (MOCK_CODEX_TUI_REDRAWS=1)   -> settles to idle despite Ink TUI redraws
 *   - cursor  (MOCK_CURSOR_TUI_REDRAWS=1)  -> settles to idle despite Ink TUI redraws
 *   - copilot (MOCK_COPILOT_TUI_STATUS=1)  -> "GPT-5 mini" status bar appears in scrollback
 *   - warp    (MOCK_WARP_ACTIVE_OUTPUT=1)  -> settles to idle once "Working..." lines stop
 *
 * The simple "spawn + settle to idle without special output" coverage stays
 * in each agent's own activity-detection spec - those tests need a clean
 * mock environment that this consolidated launch's special-mode flags would
 * disturb.
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
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  closeApp,
  type AgentName,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ActivityState } from '../../src/shared/types';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'agent-activity-special-modes';
const runId = Date.now();
const PROJECT_NAME = `Activity Special Modes ${runId}`;

test.describe('Agent activity detection - special TUI / output modes', () => {
  // Each test pairs a 15s spawn-marker wait with a 20s idle-poll, exceeding
  // the 30s electron default; bump the describe timeout instead of marking
  // every test slow individually.
  test.describe.configure({ timeout: 60_000 });

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
            codex: mockAgentPath('codex'),
            cursor: mockAgentPath('cursor'),
            copilot: mockAgentPath('copilot'),
            warp: mockAgentPath('warp'),
          },
          permissionMode: 'acceptEdits',
          maxConcurrentSessions: 5,
          queueOverflow: 'queue',
        },
        git: { worktreesEnabled: false },
      }),
    );
    const result = await launchApp({
      dataDir,
      // Agent-prefixed flags enabled in parallel. Each mock only reads its
      // own prefix, so cross-agent contamination is impossible.
      extraEnv: {
        MOCK_CODEX_TUI_REDRAWS: '1',
        MOCK_CURSOR_TUI_REDRAWS: '1',
        MOCK_COPILOT_TUI_STATUS: '1',
        MOCK_WARP_ACTIVE_OUTPUT: '1',
      },
    });
    app = result.app;
    page = result.page;
    await createProject(page, PROJECT_NAME, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  async function spawnAndWaitForMarker(agent: AgentName, marker: string): Promise<string> {
    await setProjectDefaultAgent(page, agent);

    const taskTitle = `${agent} special ${runId}`;
    await createTask(page, taskTitle, `Special-mode activity check for ${agent}`);
    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, taskTitle);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    return waitForScrollback(page, marker);
  }

  test('Codex: settles to idle despite continuous TUI redraws', async () => {
    await spawnAndWaitForMarker('codex', 'MOCK_CODEX_SESSION:');
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, {
      timeout: 20000,
      message: 'Codex session should reach idle despite TUI redraw stream',
    }).toContain('idle');
  });

  test('Cursor: settles to idle despite continuous TUI redraws', async () => {
    await spawnAndWaitForMarker('cursor', 'MOCK_CURSOR_SESSION:');
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, {
      timeout: 20000,
      message: 'Cursor session should reach idle despite TUI redraw stream',
    }).toContain('idle');
  });

  test('Copilot: PTY status bar containing GPT-5 mini appears in scrollback', async () => {
    await spawnAndWaitForMarker('copilot', 'MOCK_COPILOT_SESSION:');
    // The status bar string is in raw PTY scrollback (with ANSI codes).
    // What matters is that it reaches the scrollback at all - that proves
    // the streamOutput -> session-manager -> scrollback wiring is intact.
    const scrollback = await waitForScrollback(page, 'GPT-5 mini', 15000);
    expect(scrollback).toContain('GPT-5 mini');
  });

  test('Warp: settles to idle after active output stops', async () => {
    await spawnAndWaitForMarker('warp', 'MOCK_WARP_SESSION:');
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return Object.values(activity as Record<string, ActivityState>);
    }, {
      timeout: 20000,
      message: 'Warp session should reach idle after active output stops',
    }).toContain('idle');
  });
});
