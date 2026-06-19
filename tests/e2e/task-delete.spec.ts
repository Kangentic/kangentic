/**
 * E2E tests for archiving and deleting tasks -- including tasks with active sessions.
 *
 * Verifies that:
 *  - Archiving a task with a running session doesn't crash the app
 *  - Archiving a task with an exited session doesn't crash the app
 *  - The task is removed from the board after archiving
 *  - Deleting a queued session task via IPC doesn't crash
 *  - Archiving a task without a session works cleanly
 *
 * Uses mock-claude so tests work without a real Claude installation.
 *
 * NOT migrated to shared-app fixture: the "delete task with queued session"
 * test modifies maxConcurrentSessions to 1 via config IPC and restores it in
 * the test body (not a try/finally). With a shared Electron instance, if this
 * test fails before the restore step, subsequent --repeat-each runs see
 * maxConcurrentSessions=1 and the "wait for running session" step times out.
 * With its own Electron boot, each run starts fresh from config.json (which
 * has maxConcurrentSessions=5), so the state cannot leak. 2/10 failures in
 * shared mode; keeping own boot.
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
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const TEST_NAME = 'task-delete';
const runId = Date.now();
const PROJECT_NAME = `TaskDel ${runId}`;
let app: ElectronApplication;
let page: Page;
let tmpDir: string;
let dataDir: string;

function mockClaudePath(): string {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (process.platform === 'win32') {
    return path.join(fixturesDir, 'mock-claude.cmd');
  }
  const jsPath = path.join(fixturesDir, 'mock-claude.js');
  fs.chmodSync(jsPath, 0o755);
  return jsPath;
}

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  dataDir = getTestDataDir(TEST_NAME);

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

  const result = await launchApp({ dataDir });
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await app?.close();
  cleanupTempProject(TEST_NAME);
});

async function ensureBoard() {
  await page.keyboard.press('Escape');
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col) => {
    const el = document.querySelector(`[data-swimlane-name="${col}"]`);
    if (el) el.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.mouse.up();
  // Confirm landing instead of a fixed 500ms post-drop wait.
  await expect(target.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 5000 });
}

/** Wait for a running session to appear for the given task title */
async function waitForSession(taskTitle: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((t: { title: string }) => t.title === title);
      if (!task?.session_id) return null;
      const sessions = await window.electronAPI.sessions.list();
      const session = sessions.find((s: { id: string }) => s.id === task.session_id);
      return session?.status ?? null;
    }, taskTitle);
    if (status === 'running') return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out waiting for running session on task: ${taskTitle}`);
}

/** Open the kebab menu in the task detail dialog and click an action */
async function clickKebabAction(dialog: ReturnType<Page['locator']>, actionText: string) {
  // Click the kebab (MoreHorizontal) button -- it's the icon-only button before the divider
  const kebabButton = dialog.locator('button[title="Actions"]');
  await kebabButton.waitFor({ state: 'visible', timeout: 3000 });
  await kebabButton.click();

  // Click the action in the dropdown
  const actionButton = dialog.locator('button', { hasText: new RegExp(`^${actionText}$`) });
  await actionButton.waitFor({ state: 'visible', timeout: 3000 });
  await actionButton.click();
}

test.describe('Task Delete', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('archive task with active session from detail dialog', async () => {
    const title = `Remove Active ${runId}`;
    await createTask(page, title, 'Session should be cleaned up');

    // Drag to Running to spawn a session
    await dragTaskToColumn(title, 'Code Review');
    await waitForSession(title);

    // Wait for the renderer to reflect the running session (usage-bar appears
    // on the card). TaskCard renders status-bar only for preparing/initializing/
    // queued/suspended states; once waitForSession() returns (session is running)
    // the card switches to rendering usage-bar instead. Without this wait the
    // dialog may open in edit mode because displayState.kind === 'none' until
    // the renderer catches up.
    const codeReviewColumn = page.locator('[data-swimlane-name="Code Review"]');
    await codeReviewColumn.locator('[data-testid="usage-bar"]').waitFor({ state: 'visible', timeout: 10000 });

    // Click on the task card to open the detail dialog
    const card = codeReviewColumn.locator(`text=${title}`).first();
    await card.click();

    // Open kebab menu and click Archive (no confirmation needed).
    // Use data-testid to target the task-detail content panel specifically -
    // the backdrop class .fixed.inset-0 is ambiguous when a confirm dialog
    // briefly coexists with the detail dialog (strict-mode violation on Linux).
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 3000 });
    await clickKebabAction(dialog, 'Archive');

    // Verify the app is still alive (board is visible)
    await waitForBoard(page);

    // Poll for the archive to complete in the DB. The renderer click is fire-
    // and-forget; on the main process, handleTaskMove suspends the active PTY
    // (up to 1500ms graceful exit) before calling tasks.archive(). A fixed
    // timeout would be racy -- poll the IPC until the task appears in the
    // archived list, with 5s budget to cover suspend + DB write.
    await expect.poll(async () => {
      return page.evaluate(async (taskTitle) => {
        const archived = await window.electronAPI.tasks.listArchived();
        return archived.some((archivedTask: { title: string }) => archivedTask.title === taskTitle);
      }, title);
    }, { timeout: 5000 }).toBe(true);

    // Verify the task is gone from active columns (archived tasks appear in Done's "Completed" section)
    const activeColumns = page.locator('[data-testid="swimlane"]:not([data-swimlane-name="Done"])');
    await expect(activeColumns.locator(`text=${title}`)).toHaveCount(0);
  });

  test('archive task with exited session from detail dialog', async () => {
    const title = `Remove Exited ${runId}`;
    await createTask(page, title, 'Exited session cleanup');

    // Drag to Running to spawn a session
    await dragTaskToColumn(title, 'Code Review');
    await waitForSession(title);

    // Kill the session via IPC so it becomes "(exited)"
    await page.evaluate(async (t) => {
      const tasks = await window.electronAPI.tasks.list();
      const task = tasks.find((tk: { title: string }) => tk.title === t);
      if (task?.session_id) {
        await window.electronAPI.sessions.kill(task.session_id);
      }
    }, title);
    // Poll until the session reflects exited status before opening the dialog.
    await expect.poll(async () => {
      return page.evaluate(async (t) => {
        const tasks = await window.electronAPI.tasks.list();
        const task = tasks.find((tk: { title: string }) => tk.title === t);
        if (!task?.session_id) return 'no-session';
        const sessions = await window.electronAPI.sessions.list();
        const session = sessions.find((s: { id: string }) => s.id === task.session_id);
        return session?.status ?? 'gone';
      }, title);
    }, { timeout: 5000 }).not.toBe('running');

    // Open the task detail dialog
    const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
    await card.click();

    // Open kebab menu and click Archive.
    // Use data-testid to target the task-detail content panel specifically -
    // the backdrop class .fixed.inset-0 is ambiguous when a confirm dialog
    // briefly coexists with the detail dialog (strict-mode violation on Linux).
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 3000 });
    await clickKebabAction(dialog, 'Archive');

    // Verify app is still alive
    await waitForBoard(page);

    // Verify task is gone from active columns (archived tasks appear in Done's "Completed" section)
    const activeColumns = page.locator('[data-testid="swimlane"]:not([data-swimlane-name="Done"])');
    await expect(activeColumns.locator(`text=${title}`)).toHaveCount(0, { timeout: 5000 });
  });

  test('delete task with queued session does not crash', async () => {
    const titleA = `QueueSlot ${runId}`;
    const titleB = `QueueWait ${runId}`;

    // Kill all existing sessions from previous tests before lowering concurrency
    await page.evaluate(async () => {
      const sessions = await window.electronAPI.sessions.list();
      for (const s of sessions) {
        if (s.status === 'running' || s.status === 'queued') {
          await window.electronAPI.sessions.kill(s.id);
        }
      }
    });
    // Poll until no session is in running/queued state, instead of a fixed wait.
    await expect.poll(async () => {
      return page.evaluate(async () => {
        const sessions = await window.electronAPI.sessions.list();
        return sessions.filter((s: { status: string }) => s.status === 'running' || s.status === 'queued').length;
      });
    }, { timeout: 5000 }).toBe(0);

    // Lower max concurrent to 1 so the second move queues
    await page.evaluate(async () => {
      const cfg = await window.electronAPI.config.get();
      cfg.agent.maxConcurrentSessions = 1;
      await window.electronAPI.config.set(cfg);
    });

    // Create two tasks
    await createTask(page, titleA, 'Occupies the only slot');
    await createTask(page, titleB, 'Should be queued');

    // Get swimlane IDs for Planning
    const { planningId, taskAId, taskBId } = await page.evaluate(async (titles) => {
      const lanes = await window.electronAPI.swimlanes.list();
      const planning = lanes.find((l: { name: string }) => l.name === 'Planning');
      const tasks = await window.electronAPI.tasks.list();
      const a = tasks.find((t: { title: string }) => t.title === titles.a);
      const b = tasks.find((t: { title: string }) => t.title === titles.b);
      return { planningId: planning.id, taskAId: a.id, taskBId: b.id };
    }, { a: titleA, b: titleB });

    // Move task A to Planning -- this one gets the running session
    await page.evaluate(async (args) => {
      await window.electronAPI.tasks.move({
        taskId: args.taskId,
        targetSwimlaneId: args.laneId,
        targetPosition: 0,
      });
    }, { taskId: taskAId, laneId: planningId });

    // Wait for task A to get a running session
    await waitForSession(titleA);

    // Move task B to Planning -- with maxConcurrent=1, this one gets queued
    await page.evaluate(async (args) => {
      await window.electronAPI.tasks.move({
        taskId: args.taskId,
        targetSwimlaneId: args.laneId,
        targetPosition: 1,
      });
    }, { taskId: taskBId, laneId: planningId });

    // Wait for the session entry to be created (queued or running)
    await page.waitForFunction(
      async (title) => {
        const tasks = await (window as { electronAPI: typeof window.electronAPI }).electronAPI.tasks.list();
        const task = tasks.find((t: { title: string }) => t.title === title);
        return task?.session_id != null;
      },
      titleB,
      { timeout: 10000 },
    );

    // Verify task B has a session_id
    const taskBSessionId = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const t = tasks.find((tk: { title: string }) => tk.title === title);
      return t?.session_id ?? null;
    }, titleB);
    expect(taskBSessionId).not.toBeNull();

    // Session B should be queued or running (queue promotion can be near-instant)
    const sessionBStatus = await page.evaluate(async (sid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((session: { id: string }) => session.id === sid);
      return s?.status ?? null;
    }, taskBSessionId);
    expect(['queued', 'running']).toContain(sessionBStatus);

    // Delete task B (the one with the queued session) via IPC
    await page.evaluate(async (id) => {
      await window.electronAPI.tasks.delete(id);
    }, taskBId);

    // Verify app is still alive
    await waitForBoard(page);

    // Verify task B is gone (poll the IPC instead of a fixed wait).
    await expect.poll(async () => {
      return page.evaluate(async (title) => {
        const tasks = await window.electronAPI.tasks.list();
        return tasks.some((t: { title: string }) => t.title === title);
      }, titleB);
    }, { timeout: 5000 }).toBe(false);

    // Verify the queued session is no longer queued (killed sessions stay in
    // the in-memory map but are marked exited, not removed entirely)
    const queuedSessionStatus = await page.evaluate(async (sid) => {
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((s: { id: string }) => s.id === sid);
      return s?.status ?? 'gone';
    }, taskBSessionId);
    expect(queuedSessionStatus).not.toBe('queued');

    // Verify task A's session is still running
    const taskASession = await page.evaluate(async (title) => {
      const tasks = await window.electronAPI.tasks.list();
      const t = tasks.find((tk: { title: string }) => tk.title === title);
      if (!t?.session_id) return null;
      const sessions = await window.electronAPI.sessions.list();
      const s = sessions.find((sess: { id: string }) => sess.id === t.session_id);
      return s?.status ?? null;
    }, titleA);
    expect(taskASession).toBe('running');

    // Clean up: restore maxConcurrentSessions and kill task A's session
    await page.evaluate(async (title) => {
      const cfg = await window.electronAPI.config.get();
      cfg.agent.maxConcurrentSessions = 5;
      await window.electronAPI.config.set(cfg);
      const tasks = await window.electronAPI.tasks.list();
      const t = tasks.find((tk: { title: string }) => tk.title === title);
      if (t?.session_id) {
        await window.electronAPI.sessions.kill(t.session_id);
      }
    }, titleA);
  });

  test('delete task without session from detail dialog', async () => {
    const title = `Remove NoSession ${runId}`;
    await createTask(page, title, 'No session');

    // Open detail dialog by clicking the card
    const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
    await card.click();

    // Dialog opens in edit mode for no-session tasks -- Delete is in the footer.
    // Use data-testid to target the task-detail content panel specifically -
    // the backdrop class .fixed.inset-0 is ambiguous when a confirm dialog
    // briefly coexists with the detail dialog (strict-mode violation on Linux).
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 3000 });
    await dialog.locator('button:has-text("Delete")').click();

    // Confirm deletion
    await page.locator('text=This action cannot be undone.').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('button:has-text("Delete")').click();

    // Verify app is still alive and task is gone from board
    await waitForBoard(page);
    const taskCards = page.locator('[data-testid="swimlane"]').locator(`text=${title}`);
    await expect(taskCards).toHaveCount(0, { timeout: 5000 });
  });
});
