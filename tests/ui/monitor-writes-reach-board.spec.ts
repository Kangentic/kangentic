/**
 * UI tests for task writes made from the Agent Monitor reaching the board.
 *
 * Intent:
 * - The monitor's row menu and the task details it hosts write straight to the
 *   project-stamped IPC, so the board store never sees those writes. A Move to,
 *   Archive, Backlog or Delete on a row of the OPEN project must still show on the
 *   board under the overlay, with no manual reload. Before this, the board kept
 *   the card where it was until something else reloaded it.
 * - Backlog sends the task to the backlog. It used to call `tasks.delete`, which
 *   destroyed the task instead.
 * - Delete and Backlog ask first with the board card's own dialogs, under the same
 *   Don't ask again switch, and Escape on that dialog closes the dialog, not the
 *   monitor behind it.
 * - A row of ANOTHER project writes with that project's id.
 * - The detached monitor's writes reach the main window through main's quiet
 *   `task:changedInOtherWindow` push, whose renderer half is driven here through
 *   the mock. The UI tier cannot open a second window, so main's half is pinned
 *   in tests/unit/task-write-announce.test.ts.
 *
 * The confirm branches (Don't ask again, Cancel), the write that fails after it
 * committed, and the project id on a monitor-hosted or board-hosted detail's
 * Send to Backlog are in monitor-confirm-and-detail-writes.spec.ts. The seed and
 * page helpers both specs share are in monitor-writes-seed.ts.
 *
 * Assertions read state (DOM membership, the mock's call logs), never pixel
 * geometry (.claude/rules/cross-platform-parity.md). Every test launches its own
 * browser, so there is no cross-test state.
 */
import { test, expect } from '@playwright/test';
import {
  PROJECT_ID,
  OTHER_PROJECT_ID,
  sessionIdOf,
  launch,
  byTestId,
  boardCard,
  cardInLane,
  openMonitor,
  closeMonitor,
  openRowMenu,
  deleteCallCount,
  backlogTitles,
  moveProjectIds,
} from './monitor-writes-seed';

test.describe.configure({ mode: 'parallel' });

test.describe('Agent Monitor row menu writes reach the board', () => {
  test('Move to on a row of the open project moves the card on the board', async () => {
    const taskId = 'task-mw-move';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 41, title: 'Moved from the monitor', lane: 'To Do' }] });
    try {
      await expect(cardInLane(page, 'To Do', taskId)).toBeVisible();
      await openMonitor(page);

      const menu = await openRowMenu(page, taskId);
      await menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'Executing' }).click();
      await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);
      expect(await moveProjectIds(page)).toEqual([PROJECT_ID]);

      // The board under the overlay follows the write, before the monitor closes.
      await expect(cardInLane(page, 'Executing', taskId)).toHaveCount(1);
      await closeMonitor(page);
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await expect(cardInLane(page, 'To Do', taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Archive on a row of the open project moves the card into Done', async () => {
    const taskId = 'task-mw-archive';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 42, title: 'Archived from the monitor', lane: 'Executing' }] });
    try {
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await openMonitor(page);

      const menu = await openRowMenu(page, taskId);
      await menu.getByTestId('context-archive-task').click();
      await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);

      // The Done lane shows archived cards, so the archived task is there now.
      await closeMonitor(page);
      await expect(cardInLane(page, 'Done', taskId)).toBeVisible();
      await expect(cardInLane(page, 'Executing', taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Delete asks with the board\'s dialog: Cancel keeps the task, Delete removes it from the board', async () => {
    const taskId = 'task-mw-delete';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 43, title: 'Deleted from the monitor', lane: 'Executing' }] });
    try {
      await openMonitor(page);

      await (await openRowMenu(page, taskId)).getByTestId('context-delete-task').click();
      const dialog = byTestId(page, 'delete-task-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Deleted from the monitor');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      expect(await deleteCallCount(page, taskId)).toBe(0);

      await (await openRowMenu(page, taskId)).getByTestId('context-delete-task').click();
      await byTestId(page, 'delete-task-dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(byTestId(page, 'delete-task-dialog')).toHaveCount(0);
      await expect.poll(() => deleteCallCount(page, taskId)).toBe(1);

      await closeMonitor(page);
      await expect(boardCard(page, taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Delete with Don\'t ask again already set deletes without asking', async () => {
    const taskId = 'task-mw-delete-skip';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 44, title: 'Deleted without a question', lane: 'Executing' }],
      skipDeleteConfirm: true,
    });
    try {
      await openMonitor(page);
      await (await openRowMenu(page, taskId)).getByTestId('context-delete-task').click();
      await expect.poll(() => deleteCallCount(page, taskId)).toBe(1);
      await expect(byTestId(page, 'delete-task-dialog')).toHaveCount(0);

      await closeMonitor(page);
      await expect(boardCard(page, taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Escape on the Delete dialog closes the dialog and leaves the monitor open', async () => {
    const taskId = 'task-mw-escape';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 45, title: 'Kept by Escape', lane: 'Executing' }] });
    try {
      await openMonitor(page);
      await (await openRowMenu(page, taskId)).getByTestId('context-delete-task').click();
      await expect(byTestId(page, 'delete-task-dialog')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(byTestId(page, 'delete-task-dialog')).toHaveCount(0);
      // One Escape undoes one thing: the monitor behind the dialog stays.
      await expect(byTestId(page, 'monitor-page')).toBeVisible();
      expect(await deleteCallCount(page, taskId)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('Backlog asks for a task with a worktree, then sends it to the backlog instead of deleting it', async () => {
    const taskId = 'task-mw-backlog';
    const title = 'Sent to the backlog from the monitor';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 46, title, lane: 'Executing', worktree: true }] });
    try {
      await openMonitor(page);
      await (await openRowMenu(page, taskId)).getByTestId('context-send-to-backlog').click();
      const dialog = byTestId(page, 'send-to-backlog-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Send to Backlog' }).click();
      await expect(dialog).toHaveCount(0);

      await expect.poll(() => backlogTitles(page)).toContain(title);
      expect(await deleteCallCount(page, taskId)).toBe(0);

      await closeMonitor(page);
      await expect(boardCard(page, taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Backlog on a task with no session or worktree sends it without asking', async () => {
    const taskId = 'task-mw-backlog-plain';
    const title = 'Plain task sent to the backlog';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 47, title, lane: 'To Do' }] });
    try {
      await openMonitor(page);
      await (await openRowMenu(page, taskId)).getByTestId('context-send-to-backlog').click();
      await expect(byTestId(page, 'monitor-row-menu')).toHaveCount(0);
      await expect(byTestId(page, 'send-to-backlog-dialog')).toHaveCount(0);

      await expect.poll(() => backlogTitles(page)).toContain(title);
      await closeMonitor(page);
      await expect(boardCard(page, taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('Move to on a row of another project writes with that project\'s id', async () => {
    const taskId = 'task-mw-other';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 48, title: 'Task on the other board', lane: 'To Do', otherProject: true }],
    });
    try {
      // The open board never lists the other project's task.
      await expect(boardCard(page, taskId)).toHaveCount(0);
      await openMonitor(page);

      const menu = await openRowMenu(page, taskId);
      await menu.locator('[data-testid="context-move-to"]').filter({ hasText: 'Executing' }).click();
      await expect.poll(() => moveProjectIds(page)).toEqual([OTHER_PROJECT_ID]);

      await closeMonitor(page);
      await expect(boardCard(page, taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('a task detail hosted by the Agent Monitor reaches the board', () => {
  test('Archive from the monitor-hosted detail moves the card into Done', async () => {
    const taskId = 'task-mw-detail-archive';
    const { browser, page } = await launch({
      tasks: [{ id: taskId, displayId: 49, title: 'Archived from a monitor detail', lane: 'Executing', session: true }],
    });
    try {
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await openMonitor(page);

      await page.locator(`[data-session-id="${sessionIdOf(taskId)}"] [data-testid="monitor-card-title"]`).click();
      const detail = page.locator('#monitor-detail-layer-root [data-testid^="window-frame-"]');
      await expect(detail).toHaveCount(1);
      await detail.getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menu').getByText('Archive', { exact: true }).click();
      await expect(detail).toHaveCount(0);

      await closeMonitor(page);
      await expect(cardInLane(page, 'Done', taskId)).toBeVisible();
      await expect(cardInLane(page, 'Executing', taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});

test.describe('the main window hears about a write from the detached monitor', () => {
  test('task:changedInOtherWindow for the open project reloads the board', async () => {
    const taskId = 'task-mw-push';
    const { browser, page } = await launch({ tasks: [{ id: taskId, displayId: 50, title: 'Moved in the other window', lane: 'To Do' }] });
    try {
      await expect(cardInLane(page, 'To Do', taskId)).toBeVisible();

      // The detached monitor's write: it lands in main's store, and this window's
      // board store never sees the call.
      await page.evaluate(async (id) => {
        const api = (window as unknown as {
          electronAPI: { tasks: { move: (input: Record<string, unknown>, projectId: string) => Promise<void> } };
        }).electronAPI;
        await api.tasks.move({ taskId: id, targetSwimlaneId: 'lane-mw-2', targetPosition: 0 }, 'proj-monitor-writes');
      }, taskId);
      await expect(cardInLane(page, 'To Do', taskId)).toBeVisible();

      // Main's push after that write.
      await page.evaluate((projectId) => {
        (window as unknown as { __mockFireTaskChangedInOtherWindow: (id: string) => void })
          .__mockFireTaskChangedInOtherWindow(projectId);
      }, PROJECT_ID);
      await expect(cardInLane(page, 'Executing', taskId)).toBeVisible();
      await expect(cardInLane(page, 'To Do', taskId)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
