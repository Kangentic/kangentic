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
  waitForTaskScrollback,
  waitForTaskSession,
  getTaskIdByTitle,
  getSwimlaneIds,
  moveTaskIpc,
  closeApp,
  type AgentName,
  type TaskScrollbackResult,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ActivityState } from '../../src/shared/types';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'agent-activity-special-modes';
const runId = Date.now();
const PROJECT_NAME = `Activity Special Modes ${runId}`;

test.describe('Agent activity detection - special TUI / output modes', () => {
  // Each test pairs a 30s spawn-marker wait (see spawnAndWaitForMarker's doc
  // comment for why every test gets that budget, not just whichever runs
  // first) with a 20s idle-poll, exceeding the 30s electron default; bump
  // the describe timeout instead of marking every test slow individually.
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

  /**
   * Creates a task for `agent` and moves it into Planning, triggering a
   * spawn. Shared setup for both {@link spawnAndWaitForMarker} and
   * {@link spawnAndWaitForSession} - the two differ only in how they decide
   * the spawn has landed.
   *
   * The task title includes `test.info().retry`, which is 0 on the initial
   * attempt and increments on every CI retry. Without this, a retried test
   * re-creates a task with the SAME title as the failed attempt's task,
   * `getTaskIdByTitle` can resolve back onto that stale (still-Planning,
   * already-spawned) task instead of the freshly created one, and the retry
   * ends up observing the leftover session's now-warmed-up state rather than
   * testing a real spawn.
   */
  async function spawnTaskForAgent(agent: AgentName): Promise<string> {
    await setProjectDefaultAgent(page, agent);

    const taskTitle = `${agent} special ${runId}-r${test.info().retry}`;
    await createTask(page, taskTitle, `Special-mode activity check for ${agent}`);
    const swimlaneIds = await getSwimlaneIds(page);
    const taskId = await getTaskIdByTitle(page, taskTitle);

    await moveTaskIpc(page, taskId, swimlaneIds.planning);
    return taskId;
  }

  /**
   * Spawns a task for `agent` and waits for `marker` in THAT task's own
   * session scrollback (never any other live session's - see
   * waitForTaskScrollback's doc comment for why that distinction matters in
   * a file that shares one Electron app across four tests).
   *
   * markerTimeoutMs defaults to 30s (double waitForTaskScrollback's own
   * 15s default): the renderer reload inside setProjectDefaultAgent plus a
   * first worktree + PTY spawn is a real cold-start cost on a CI runner
   * where the electron project's workers (8 on Linux CI) are all launching
   * Electron apps concurrently against a shared, small vCPU budget. Which
   * of the four tests in this file actually pays that cold cost is NOT
   * fixed to "whichever runs first" - CI splits specs into shards by
   * cumulative test index, so a shard boundary can land mid-file and make
   * Cursor, Copilot, or Warp the first spawn in that shard's copy of the
   * app instead of Codex. Giving every call the same headroom (rather than
   * only the literally-first test) is what actually fixes that. Still a
   * condition poll (waitForTaskScrollback), never a bare sleep - cost on
   * the warm path is zero, since the poll returns as soon as the marker
   * lands.
   */
  async function spawnAndWaitForMarker(
    agent: AgentName,
    marker: string,
    markerTimeoutMs = 30000,
  ): Promise<TaskScrollbackResult & { taskId: string }> {
    const taskId = await spawnTaskForAgent(agent);
    const result = await waitForTaskScrollback(page, taskId, marker, markerTimeoutMs);
    return { taskId, ...result };
  }

  /**
   * Same spawn sequence as {@link spawnAndWaitForMarker}, but waits for the
   * task's session to reach status='running' via IPC instead of a scrollback
   * marker - see {@link waitForTaskSession}'s doc comment for why.
   *
   * Codex and Cursor's `MOCK_*_TUI_REDRAWS` mode prints its startup marker
   * BEFORE its first `\x1b[2J` full-screen clear (on a fixed ~500ms
   * interval), which makes a scrollback-marker wait for those two agents
   * racy: as soon as that clear is written into the session's PTY buffer,
   * `getScrollback` permanently strips everything before it (an eager,
   * write-time effect, not a read-time cache - see
   * {@link waitForTaskSession}'s doc comment). A poll whose first successful
   * read lands before that clear passes immediately; one whose setup pushes
   * past it - e.g. under CI load - finds the marker already and permanently
   * gone and spins for its full timeout (this was PR #344 CI's observed
   * flake: full 30s timeout on attempt 1, instant pass on retry's fresh
   * session/buffer). Copilot and Warp's TUI-redraw mocks never emit
   * `\x1b[2J`, so their markers stay put in scrollback and those two tests
   * keep using {@link spawnAndWaitForMarker} directly.
   */
  async function spawnAndWaitForSession(
    agent: AgentName,
    timeoutMs = 30000,
  ): Promise<{ taskId: string; sessionId: string }> {
    const taskId = await spawnTaskForAgent(agent);
    const { sessionId } = await waitForTaskSession(page, taskId, timeoutMs);
    return { taskId, sessionId };
  }

  test('Codex: settles to idle despite continuous TUI redraws', async () => {
    const { sessionId } = await spawnAndWaitForSession('codex');
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return (activity as Record<string, ActivityState>)[sessionId];
    }, {
      timeout: 20000,
      message: 'Codex session should reach idle despite TUI redraw stream',
    }).toBe('idle');
  });

  test('Cursor: settles to idle despite continuous TUI redraws', async () => {
    const { sessionId } = await spawnAndWaitForSession('cursor');
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return (activity as Record<string, ActivityState>)[sessionId];
    }, {
      timeout: 20000,
      message: 'Cursor session should reach idle despite TUI redraw stream',
    }).toBe('idle');
  });

  test('Copilot: PTY status bar containing GPT-5 mini appears in scrollback', async () => {
    const { taskId } = await spawnAndWaitForMarker('copilot', 'MOCK_COPILOT_SESSION:');
    // The status bar string is in raw PTY scrollback (with ANSI codes).
    // What matters is that it reaches the scrollback at all - that proves
    // the streamOutput -> session-manager -> scrollback wiring is intact.
    // Scoped to this task's own session (not waitForScrollback's all-session
    // join) for the same reason as spawnAndWaitForMarker above.
    const { scrollback } = await waitForTaskScrollback(page, taskId, 'GPT-5 mini', 15000);
    expect(scrollback).toContain('GPT-5 mini');
  });

  test('Warp: settles to idle after active output stops', async () => {
    const { sessionId } = await spawnAndWaitForMarker('warp', 'MOCK_WARP_SESSION:');
    await expect.poll(async () => {
      const activity = await page.evaluate(() => window.electronAPI.sessions.getActivity());
      return (activity as Record<string, ActivityState>)[sessionId];
    }, {
      timeout: 20000,
      message: 'Warp session should reach idle after active output stops',
    }).toBe('idle');
  });
});
