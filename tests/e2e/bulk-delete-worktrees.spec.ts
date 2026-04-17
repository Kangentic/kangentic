/**
 * E2E regression for the "bulk delete orphans worktrees" bug.
 *
 * Prior behavior (sync fs.rmSync + 2 retries / 500ms total):
 *   - Bulk-deleting many tasks froze the UI while cleanup ran.
 *   - Worktree directories survived on disk because Windows NTFS handles
 *     weren't released within the retry budget.
 *
 * New behavior (async fs.promises.rm + 10 retries / 200ms, concurrency 8):
 *   - Main process stays responsive.
 *   - Worktree directories are actually removed.
 *
 * This test asserts the second property on-disk by:
 *   1. Enabling worktrees for the test project.
 *   2. Creating N tasks and moving them through a worktree-creating column
 *      so real worktree directories land under .kangentic/worktrees/.
 *   3. Calling TASK_BULK_DELETE via IPC.
 *   4. Asserting every expected worktree path is gone.
 *
 * Cross-platform: the `fs.promises.rm({ maxRetries, retryDelay })` contract
 * is platform-agnostic (retries are no-ops on POSIX where EBUSY is rare),
 * so the same assertions apply on Windows / macOS / Linux. Uses mock-claude
 * so no real Claude install is needed.
 */
import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  mockAgentPath,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'bulk-delete-worktrees';
const runId = Date.now();
const PROJECT_NAME = `BulkDel ${runId}`;
const TASK_COUNT = 3;

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
      claude: {
        cliPath: mockAgentPath('claude'),
        permissionMode: 'default',
        maxConcurrentSessions: 5,
        queueOverflow: 'queue',
      },
      git: {
        worktreesEnabled: true,
      },
    }),
  );

  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await app?.close();
  cleanupTempProject(TEST_NAME);
});

test('TASK_BULK_DELETE removes every worktree directory from disk', async () => {
  const worktreesDir = path.join(tmpDir, '.kangentic', 'worktrees');

  const titles = Array.from({ length: TASK_COUNT }, (_, index) => `BulkDelWT ${runId}-${index}`);

  // Create tasks in To Do
  for (const title of titles) {
    await createTask(page, title, 'Exercises bulk delete + worktree cleanup');
  }

  // Move each to Planning via IPC - auto_spawn=true triggers ensureTaskWorktree.
  // IPC is faster than drag-and-drop for a bulk setup like this.
  const taskIds = await page.evaluate(async (taskTitles) => {
    const lanes = await window.electronAPI.swimlanes.list();
    const planning = lanes.find((lane) => lane.name === 'Planning');
    if (!planning) throw new Error('Planning lane not found');
    const tasks = await window.electronAPI.tasks.list();
    const ids: string[] = [];
    let position = 0;
    for (const title of taskTitles) {
      const task = tasks.find((candidate) => candidate.title === title);
      if (!task) throw new Error(`Task not found: ${title}`);
      ids.push(task.id);
      await window.electronAPI.tasks.move({
        taskId: task.id,
        targetSwimlaneId: planning.id,
        targetPosition: position,
      });
      position += 1;
    }
    return ids;
  }, titles);

  // Wait for every task to have a worktree_path set in the DB. Worktree
  // creation is synchronous-ish inside the lock, but the IPC move resolves
  // before every downstream step finishes - poll until done.
  await expect
    .poll(
      async () => {
        return page.evaluate(async (ids) => {
          const tasks = await window.electronAPI.tasks.list();
          return ids.every((id) => {
            const task = tasks.find((candidate) => candidate.id === id);
            return task?.worktree_path != null;
          });
        }, taskIds);
      },
      { timeout: 45000 },
    )
    .toBe(true);

  // Capture the worktree paths for later assertion
  const worktreePaths: string[] = await page.evaluate(async (ids) => {
    const tasks = await window.electronAPI.tasks.list();
    return ids
      .map((id) => tasks.find((candidate) => candidate.id === id)?.worktree_path)
      .filter((value): value is string => typeof value === 'string');
  }, taskIds);

  expect(worktreePaths.length).toBe(TASK_COUNT);
  for (const worktreePath of worktreePaths) {
    expect(fs.existsSync(worktreePath)).toBe(true);
  }

  // Kill any live sessions so PTYs release their CWD handle on the worktree
  // before we delete. cleanupTaskResources awaits process exit anyway, but
  // killing eagerly shortens the test.
  await page.evaluate(async (ids) => {
    const tasks = await window.electronAPI.tasks.list();
    for (const id of ids) {
      const task = tasks.find((candidate) => candidate.id === id);
      if (task?.session_id) {
        await window.electronAPI.sessions.kill(task.session_id);
      }
    }
  }, taskIds);

  // Bulk delete via IPC (the renderer path that the Completed Tasks dialog
  // triggers). Use the typed return to assert zero cleanup failures.
  const result = await page.evaluate(async (ids) => {
    return window.electronAPI.tasks.bulkDelete(ids);
  }, taskIds);

  expect(result.deleted).toBe(TASK_COUNT);
  expect(result.failures).toEqual([]);

  // Every expected worktree path must be gone from disk. This is the
  // specific regression guard - with the old sync-rmSync + 2-retry logic
  // on Windows, most of these paths would still exist.
  for (const worktreePath of worktreePaths) {
    expect(fs.existsSync(worktreePath)).toBe(false);
  }

  // And the task rows themselves are gone
  const remainingTaskCount = await page.evaluate(async (ids) => {
    const tasks = await window.electronAPI.tasks.list();
    const archived = await window.electronAPI.tasks.listArchived();
    const idSet = new Set(ids);
    return tasks.filter((task) => idSet.has(task.id)).length
      + archived.filter((task) => idSet.has(task.id)).length;
  }, taskIds);
  expect(remainingTaskCount).toBe(0);

  // Main process didn't freeze - board is still responsive
  await waitForBoard(page);

  // Final sanity: the worktrees directory either doesn't exist or has no
  // residual folders from this test's tasks. (Other tests / prior runs may
  // leave unrelated entries - we only assert our specific paths are gone.)
  if (fs.existsSync(worktreesDir)) {
    const remaining = fs.readdirSync(worktreesDir);
    for (const worktreePath of worktreePaths) {
      const basename = path.basename(worktreePath);
      expect(remaining).not.toContain(basename);
    }
  }
});
