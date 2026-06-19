/**
 * E2E for the Done-column worktree lifecycle introduced by the redesign:
 *  - Moving a task to Done suspends the session AND deletes the local
 *    worktree directory, while preserving branch_name. The session record
 *    (and its agent_session_id) survives so the task is resumable.
 *  - Moving the task back out of Done into any column whose role is not
 *    'todo' or 'done' recreates the worktree from the preserved branch.
 *
 * The existing session-move-lifecycle.spec.ts test for Done unarchive runs
 * with worktreesEnabled=false, so it never exercises the new delete /
 * recreate behavior. This spec is the worktree-enabled counterpart and is
 * the only place where on-disk state of `.kangentic/worktrees/` is asserted.
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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'done-worktree-lifecycle';
const runId = Date.now();

function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

/** Pre-write config.json with worktrees ENABLED (the whole point of this spec). */
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
        worktreesEnabled: true,
        // Keep the branch on cleanup paths so the recreate step can find it.
        autoCleanup: false,
      },
    }),
  );
}

async function getSwimlaneIds(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const swimlanes = await window.electronAPI.swimlanes.list();
    const result: Record<string, string> = {};
    for (const lane of swimlanes) {
      result[lane.name] = lane.id;
      if (lane.role) result[`role:${lane.role}`] = lane.id;
    }
    return result;
  });
}

async function getTaskId(page: Page, title: string): Promise<string> {
  const taskId = await page.evaluate(async (t) => {
    const active = await window.electronAPI.tasks.list();
    const archived = await window.electronAPI.tasks.listArchived();
    return [...active, ...archived].find((task: { title: string }) => task.title === t)?.id;
  }, title);
  if (!taskId) throw new Error(`Task "${title}" not found`);
  return taskId;
}

async function getTaskFromAny(page: Page, taskId: string): Promise<{
  id: string;
  worktree_path: string | null;
  branch_name: string | null;
  archived_at: string | null;
  session_id: string | null;
} | null> {
  return page.evaluate(async (id) => {
    const active = await window.electronAPI.tasks.list();
    const archived = await window.electronAPI.tasks.listArchived();
    return [...active, ...archived].find((task: { id: string }) => task.id === id) ?? null;
  }, taskId);
}

async function moveTaskIpc(page: Page, taskId: string, targetSwimlaneId: string): Promise<void> {
  await page.evaluate(async ({ taskId, swimlaneId }) => {
    await window.electronAPI.tasks.move({
      taskId,
      targetSwimlaneId: swimlaneId,
      targetPosition: 0,
    });
  }, { taskId, swimlaneId: targetSwimlaneId });
}

async function unarchiveTaskIpc(page: Page, taskId: string, targetSwimlaneId: string): Promise<void> {
  await page.evaluate(async ({ taskId, swimlaneId }) => {
    await window.electronAPI.tasks.unarchive({ id: taskId, targetSwimlaneId: swimlaneId });
  }, { taskId, swimlaneId: targetSwimlaneId });
}

async function waitForRunningSession(page: Page, timeoutMs = 15000): Promise<void> {
  await page.waitForFunction(async () => {
    const sessions = await (window as unknown as {
      electronAPI: { sessions: { list: () => Promise<Array<{ status: string }>> } }
    }).electronAPI.sessions.list();
    return sessions.some((session) => session.status === 'running');
  }, null, { timeout: timeoutMs });
}

/**
 * Poll a specific task's running session scrollback for a marker string.
 * Returns the scrollback text if found; throws on timeout.
 */
async function waitForTaskScrollback(page: Page, taskId: string, marker: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scrollback = await page.evaluate(async (tid) => {
      const sessions = await window.electronAPI.sessions.list();
      const session = sessions.find((s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running');
      if (!session) return '';
      return window.electronAPI.sessions.getScrollback(session.id);
    }, taskId);

    if (scrollback.includes(marker)) return scrollback;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for task ${taskId.slice(0, 8)} scrollback containing: ${marker}`);
}

function extractSessionId(scrollback: string, marker: 'SESSION' | 'RESUMED'): string | null {
  const pattern = new RegExp(`MOCK_CLAUDE_${marker}:([a-f0-9-]+)`);
  const match = scrollback.match(pattern);
  return match ? match[1] : null;
}

test.describe('Done worktree lifecycle (worktrees enabled)', () => {
  let app: ElectronApplication;
  let page: Page;
  let tmpDir: string;
  let dataDir: string;
  let lanes: Record<string, string>;

  test.beforeAll(async () => {
    tmpDir = createTempProject(TEST_NAME);
    dataDir = getTestDataDir(TEST_NAME);
    writeTestConfig(dataDir);

    const result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;
    await createProject(page, `Done Worktree ${runId}`, tmpDir);

    lanes = await getSwimlaneIds(page);
  });

  test.afterAll(async () => {
    await closeApp(app);
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('Move-to-Done deletes the worktree dir; unarchive recreates it and resumes the same session', async () => {
    const title = `Worktree Cycle ${runId}`;
    await createTask(page, title, 'Verify worktree delete on Done, recreate on unarchive');

    const taskId = await getTaskId(page, title);

    // Move to Planning -> spawns session, creates worktree
    await moveTaskIpc(page, taskId, lanes['Planning']);
    await waitForRunningSession(page);

    const initialScrollback = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:');
    const originalSessionId = extractSessionId(initialScrollback, 'SESSION');
    expect(originalSessionId, 'mock CLI should emit a session id').toBeTruthy();

    const taskBeforeDone = await getTaskFromAny(page, taskId);
    expect(taskBeforeDone?.worktree_path, 'worktree_path should be set after Planning move').toBeTruthy();
    expect(taskBeforeDone?.branch_name, 'branch_name should be set after Planning move').toBeTruthy();
    const worktreePath = taskBeforeDone!.worktree_path!;
    const branchName = taskBeforeDone!.branch_name!;
    expect(fs.existsSync(worktreePath), `worktree dir should exist on disk: ${worktreePath}`).toBe(true);

    // Move to Done -> suspend session + delete worktree + archive task
    await moveTaskIpc(page, taskId, lanes['role:done']);

    // Poll combined post-Done state. The active sessions list should no
    // longer have a running entry for this task (session_id cleared); the
    // task should be archived; the worktree dir should be gone; branch_name
    // should be preserved (so unarchive can rebuild from it).
    await expect.poll(async () => {
      const task = await getTaskFromAny(page, taskId);
      const stillRunning = await page.evaluate(async (tid) => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.some((s: { taskId: string; status: string }) => s.taskId === tid && s.status === 'running');
      }, taskId);
      return {
        archived: !!task?.archived_at,
        worktreePathNull: task?.worktree_path === null,
        branchPreserved: task?.branch_name === branchName,
        worktreeDirGone: !fs.existsSync(worktreePath),
        sessionIdCleared: task?.session_id === null,
        noRunningSession: !stillRunning,
      };
    }, { timeout: 15000 }).toEqual({
      archived: true,
      worktreePathNull: true,
      branchPreserved: true,
      worktreeDirGone: true,
      sessionIdCleared: true,
      noRunningSession: true,
    });

    // Unarchive into Code Review (custom column, auto_spawn=true). The new
    // TASK_UNARCHIVE branch recreates the worktree from branch_name even if
    // auto_spawn were false; here auto_spawn=true so the agent also resumes.
    await unarchiveTaskIpc(page, taskId, lanes['Code Review']);

    await expect.poll(async () => {
      const task = await getTaskFromAny(page, taskId);
      return {
        unarchived: task?.archived_at === null,
        worktreePathSet: !!task?.worktree_path,
        worktreeDirExists: !!task?.worktree_path && fs.existsSync(task.worktree_path),
        branchSame: task?.branch_name === branchName,
      };
    }, { timeout: 15000 }).toEqual({
      unarchived: true,
      worktreePathSet: true,
      worktreeDirExists: true,
      branchSame: true,
    });

    // Session should resume with the same agent session id (mock prints
    // MOCK_CLAUDE_RESUMED:<id> when --resume is used).
    await waitForRunningSession(page);
    const resumedScrollback = await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_RESUMED:');
    const resumedSessionId = extractSessionId(resumedScrollback, 'RESUMED');
    expect(resumedSessionId).toBe(originalSessionId);
  });

  test('Move-to-Done is a clean no-op when the task never had a worktree', async () => {
    // The deleteTaskWorktree early-return path: a task that goes straight
    // from To Do to Done has no worktree to delete. Verifies the helper's
    // null-guard and the Done branch's `if (task.worktree_path)` wrapper.
    const title = `No Worktree ${runId}`;
    await createTask(page, title, 'Move directly To Do -> Done without ever spawning');

    const taskId = await getTaskId(page, title);

    await moveTaskIpc(page, taskId, lanes['role:done']);

    await expect.poll(async () => {
      const task = await getTaskFromAny(page, taskId);
      return {
        archived: !!task?.archived_at,
        worktreePathNull: task?.worktree_path === null,
      };
    }, { timeout: 5000 }).toEqual({
      archived: true,
      worktreePathNull: true,
    });
  });
});
