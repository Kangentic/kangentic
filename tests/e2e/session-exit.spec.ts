/**
 * E2E tests for session exit handling.
 *
 * Verifies that:
 *  1. When a session is killed, its status updates to 'exited'
 *  2. The session count decrements after exit
 *  3. Moving a task back to an agent column after exit spawns a new PTY
 *     (session ID is reused by design, but a fresh PTY is created)
 *
 * Uses the mock Claude CLI (tests/fixtures/mock-claude) and triggers exit
 * via the sessions.kill() IPC, which fires the PTY onExit handler.
 *
 * NOT migrated to shared-app fixture: the test asserts SESSION_LIST returns
 * exactly 1 running session after a move. SESSION_LIST is unfiltered (returns
 * all projects' sessions). In the shared Electron instance, a session from a
 * prior test's project can still be transitioning from 'running' to 'exited'
 * while this test's assert fires, causing "Expected: 1, Received: 2". With
 * its own boot the registry is empty at start. 1/10 failure in shared mode;
 * keeping own boot.
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
  closeApp,
  waitForRunningSession,
  waitForNoRunningSession,
  waitForTaskSession,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'session-exit';
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

/** Pre-write config.json with mock Claude CLI */
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

/**
 * Scrollback of the task's RUNNING session, or '' when it has none.
 *
 * Filters on status === 'running' on purpose: a task that was moved to To Do
 * and back keeps an exited row in sessions.list(), and an unfiltered lookup
 * could read that stale row's scrollback instead of the fresh PTY's.
 *
 * Callers poll this through expect.poll. An async predicate handed to
 * page.waitForFunction resolves on its first evaluation (the Promise is
 * truthy), so it never waits.
 */
async function readRunningTaskScrollback(page: Page, taskId: string): Promise<string> {
  return page.evaluate(async (targetTaskId) => {
    const sessions = await window.electronAPI.sessions.list();
    const runningSession = sessions.find(
      (session: { taskId: string; status: string }) =>
        session.taskId === targetTaskId && session.status === 'running',
    );
    if (!runningSession) return '';
    return (await window.electronAPI.sessions.getScrollback(runningSession.id)) ?? '';
  }, taskId);
}

test.describe('Claude Agent -- Session Exit Handling', () => {
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
    await createProject(page, `Exit Test ${runId}`, tmpDir);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('moving to non-agent column kills session and clears running state', async () => {
    const title = `Exit Task ${runId}`;
    await createTask(page, title, 'Test session exit handling');

    // Get swimlane IDs
    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: { name: string }) => s.name === 'Planning');
      const backlog = swimlanes.find((s: { name: string }) => s.name === 'To Do');
      return { planning: planning?.id, backlog: backlog?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();
    expect(swimlaneIds.backlog).toBeTruthy();

    const taskId = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: { title: string }) => tk.title === t);
      return task?.id;
    }, title);
    expect(taskId).toBeTruthy();

    // Move to Planning → spawns session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for session to be running
    await waitForRunningSession(page, 15000);

    // Verify we have exactly 1 running session
    const runningBefore = await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.filter((s: { status: string }) => s.status === 'running').length;
    });
    expect(runningBefore).toBe(1);

    // Move to To Do → suspends and kills the session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.backlog! });

    // Wait for the session to no longer be running.
    await expect
      .poll(
        async () => page.evaluate(async () => {
          const sessions = await window.electronAPI.sessions.list();
          return sessions.filter((s: { status: string }) => s.status === 'running').length;
        }),
        { timeout: 13_000, intervals: [200, 500] },
      )
      .toBe(0);
  });

  test('moving task back to agent column after exit creates a new PTY', async () => {
    const title = `Re-spawn ${runId}`;
    await createTask(page, title, 'Test re-spawn after exit');

    // Get swimlane IDs
    const swimlaneIds = await page.evaluate(async () => {
      const swimlanes = await window.electronAPI.swimlanes.list();
      const planning = swimlanes.find((s: { name: string }) => s.name === 'Planning');
      const backlog = swimlanes.find((s: { name: string }) => s.name === 'To Do');
      return { planning: planning?.id, backlog: backlog?.id };
    });
    expect(swimlaneIds.planning).toBeTruthy();
    expect(swimlaneIds.backlog).toBeTruthy();

    const taskId = await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: { title: string }) => tk.title === t);
      return task?.id;
    }, title);
    expect(taskId).toBeTruthy();

    // Move to Planning → spawns session
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for running
    await waitForTaskSession(page, taskId!, 15000);

    // Wait for scrollback to have content (session fully started)
    await expect
      .poll(async () => (await readRunningTaskScrollback(page, taskId!)).length, {
        timeout: 15000,
        intervals: [200, 500],
      })
      .toBeGreaterThan(10);

    // Move to To Do (suspends session, kills PTY)
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.backlog! });

    // Wait for no running sessions (global is correct here: this spec owns its
    // Electron boot and the first test already drained its own session).
    await waitForNoRunningSession(page, 15000);

    // The fixed 1 s pause that stood here let the To Do move finish detaching
    // the dead session from the task before the move back. That is observable:
    // the task's session_id is cleared once the teardown has landed.
    await expect
      .poll(
        async () => page.evaluate(async (tid) => {
          const tasks = await window.electronAPI.tasks.list();
          return tasks.find((task: { id: string }) => task.id === tid)?.session_id ?? null;
        }, taskId!),
        { timeout: 5000, intervals: [100, 250] },
      )
      .toBeNull();

    // Move back to Planning → spawns new PTY
    await page.evaluate(async ({ taskId, swimlaneId }) => {
      await window.electronAPI.tasks.move({
        taskId,
        targetSwimlaneId: swimlaneId,
        targetPosition: 0,
      });
    }, { taskId: taskId!, swimlaneId: swimlaneIds.planning! });

    // Wait for a new running session
    await waitForTaskSession(page, taskId!, 15000);

    // Wait for the new session to produce scrollback
    await expect
      .poll(async () => readRunningTaskScrollback(page, taskId!), {
        timeout: 15000,
        intervals: [200, 500],
      })
      .toContain('MOCK_CLAUDE_');

    // Verify a running session exists for this task
    const newSession = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      return sessions.find((s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running');
    }, taskId!);

    expect(newSession).toBeTruthy();
    expect(newSession.status).toBe('running');

    // To Do marks sessions as 'exited' (not 'suspended'), so re-entry
    // must spawn a FRESH session (MOCK_CLAUDE_SESSION), never a resumed one.
    await expect
      .poll(async () => readRunningTaskScrollback(page, taskId!), {
        timeout: 15000,
        intervals: [200, 500],
      })
      .toContain('MOCK_CLAUDE_SESSION:');
  });
});
