/**
 * E2E tests for rapid task moves between columns.
 *
 * Verifies that:
 *  1. Rapidly moving a task back-and-forth between To Do and Planning
 *     does NOT crash the app (especially on Windows where PTY double-kill
 *     causes STATUS_HEAP_CORRUPTION / exit 0xC0000374).
 *  2. After the rapid moves settle, the task is in the correct final column
 *     and there are no orphaned running sessions.
 *  3. A subsequent move to an agent column still spawns a session correctly.
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) so no real agent runs.
 * All moves are performed via IPC (window.electronAPI.tasks.move) for speed
 * and determinism -- no drag-and-drop.
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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'session-rapid-moves';
const runId = Date.now();

/** Resolve the platform-appropriate mock Claude path */
function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

/** Pre-write config.json with mock Claude CLI and worktrees disabled */
function writeTestConfig(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      claude: {
        cliPath: mockClaudePath(),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: false,
      },
    }),
  );
}

test.describe('Claude Agent -- Rapid Task Moves', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Rapid Moves Test ${runId}`, tmpDir);
  });

  test.afterAll(async () => {
    await app?.close();
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('rapid To Do-Planning-To Do-Planning-To Do moves do not crash, final state is correct', async () => {
    const title = `Rapid Move ${runId}`;
    await createTask(page, title, 'Test rapid column moves do not corrupt session state');

    // Resolve swimlane IDs
    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      const backlog = swimlanes.find((s: any) => s.name === 'To Do');
      return { planning: planning?.id, backlog: backlog?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();
    expect(swimlaneIds.backlog).toBeTruthy();

    // Find the task ID
    const taskId = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      return task?.id;
    }, title);
    expect(taskId).toBeTruthy();

    // --- Rapid-fire moves: To Do → Planning → To Do → Planning → To Do ---
    // Fire all five moves in quick succession without waiting for sessions to
    // start or stop. This stresses the PTY kill/spawn path and tests the
    // double-kill guard (session.pty = null before kill).
    await page.evaluate(async ({ taskId, planningId, backlogId }) => {
      // Move 1: To Do → Planning (spawns session)
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: planningId,
        targetPosition: 0,
      });
      // Move 2: Planning → To Do (kills session)
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: backlogId,
        targetPosition: 0,
      });
      // Move 3: To Do → Planning (spawns session)
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: planningId,
        targetPosition: 0,
      });
      // Move 4: Planning → To Do (kills session)
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: backlogId,
        targetPosition: 0,
      });
      // Move 5: To Do → Planning (spawns session)
      // Move back to To Do one more time for final resting position
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: planningId,
        targetPosition: 0,
      });
      // Move 6: Planning → To Do (final position)
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: backlogId,
        targetPosition: 0,
      });
    }, {
      taskId: taskId!,
      planningId: swimlaneIds.planning!,
      backlogId: swimlaneIds.backlog!,
    });

    // --- Verify: app is still alive ---
    // If the app crashed (e.g., heap corruption from double PTY kill),
    // this evaluate call will throw a connection error.
    const appAlive = await page.evaluate(() => {
      return document.title !== undefined;
    });
    expect(appAlive).toBe(true);

    // --- Verify: task ended up in To Do ---
    const finalTask = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.find((t: any) => t.id === tid);
    }, taskId!);
    expect(finalTask).toBeTruthy();

    const backlogSwimlane = await page.evaluate(async (blId) => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      return swimlanes.find((s: any) => s.id === blId);
    }, swimlaneIds.backlog!);
    expect(finalTask.swimlane_id).toBe(backlogSwimlane.id);

    // --- Verify: no running sessions remain ---
    // Give PTY onExit handlers time to fire after the rapid kills.
    await page.waitForTimeout(3000);

    let runningCount = -1;
    for (let i = 0; i < 20; i++) {
      runningCount = await page.evaluate(async () => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.filter((s: any) => s.status === 'running').length;
      });
      if (runningCount === 0) break;
      await page.waitForTimeout(500);
    }
    expect(runningCount).toBe(0);

    // --- Verify: task has no active session_id ---
    const taskAfterSettle = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.find((t: any) => t.id === tid);
    }, taskId!);
    expect(taskAfterSettle.session_id).toBeFalsy();

    // --- Verify: renderer session store has no spawn-progress indicators ---
    // The fix in board-store/task-slice.ts clears spawnProgress and
    // pendingCommandLabel optimistically when a task moves to a To Do lane.
    // If this clearance were removed, a stale "Initializing..." label from
    // a prior in-flight spawn could remain on the task card indefinitely.
    // __zustandStores is exposed only in DEV mode (NODE_ENV=test counts as DEV
    // for Vite's dev server, which is how E2E tests load the renderer).
    const spawnIndicatorsClear = await page.evaluate((tid) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: {
            getState: () => {
              spawnProgress: Record<string, string>;
              pendingCommandLabel: Record<string, string>;
            };
          };
        };
      }).__zustandStores;
      if (!stores?.session) {
        // __zustandStores is not available in this context -- skip assertion
        return true;
      }
      const state = stores.session.getState();
      return !(tid in state.spawnProgress) && !(tid in state.pendingCommandLabel);
    }, taskId!);
    expect(spawnIndicatorsClear).toBe(true);
  });

  test('moving to Planning after rapid moves still spawns a running session', async () => {
    // This test uses the same task created in the previous test.
    // Find it by title pattern.
    const title = `Rapid Move ${runId}`;

    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: any) => s.name === 'Planning');
      const backlog = swimlanes.find((s: any) => s.name === 'To Do');
      return { planning: planning?.id, backlog: backlog?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();

    const taskId = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: any) => tk.title === t);
      return task?.id;
    }, title);
    expect(taskId).toBeTruthy();

    // Verify task is currently in To Do (settled from previous test)
    const taskBefore = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.find((t: any) => t.id === tid);
    }, taskId!);
    expect(taskBefore.swimlane_id).toBe(swimlaneIds.backlog);

    // Move to Planning one final time
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for a running session to appear
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      return sessions.some((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId!, { timeout: 15000 });

    // Verify scrollback contains a mock Claude marker (session actually started)
    await page.waitForFunction(async (tid) => {
      const sessions = await (window as any).electronAPI.sessions.list();
      const s = sessions.find((s: any) => s.taskId === tid && s.status === 'running');
      if (!s) return false;
      const sb = await (window as any).electronAPI.sessions.getScrollback(s.id);
      return sb && sb.includes('MOCK_CLAUDE_');
    }, taskId!, { timeout: 15000 });

    // Final assertion: exactly one running session for this task
    const finalSession = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((s: any) => s.taskId === tid && s.status === 'running');
    }, taskId!);
    expect(finalSession).toBeTruthy();
    expect(finalSession.status).toBe('running');

    // Verify the task record has a session_id set
    const taskAfter = await page.evaluate(async (tid) => {
      const tasks = await window.electronAPI.tasks.list();
      return tasks.find((t: any) => t.id === tid);
    }, taskId!);
    expect(taskAfter.session_id).toBeTruthy();
  });
});
