import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';

/** Create a backlog task with labels and priority via the mock API directly. */
async function createBacklogTaskWithLabels(
  page: Page,
  title: string,
  labels: string[],
  priority: number,
): Promise<string> {
  return page.evaluate(
    ({ title, labels, priority }) => {
      return window.electronAPI.backlog.create({
        title,
        description: '',
        priority,
        labels,
      }).then((item: { id: string }) => item.id);
    },
    { title, labels, priority },
  );
}

/** Promote backlog tasks to the board via the mock API directly. */
async function promoteToBoard(page: Page, itemIds: string[], targetSwimlaneId: string): Promise<void> {
  await page.evaluate(
    ({ itemIds, targetSwimlaneId }) => {
      return window.electronAPI.backlog.promote({ backlogTaskIds: itemIds, targetSwimlaneId });
    },
    { itemIds, targetSwimlaneId },
  );
}

/** Get the first swimlane ID (To Do) from the mock. */
async function getFirstSwimlaneId(page: Page): Promise<string> {
  return page.evaluate(() => {
    return window.electronAPI.swimlanes.list().then((lanes: Array<{ id: string }>) => lanes[0].id);
  });
}

test.describe('Label and Priority Promotion', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('promoted backlog task carries labels and priority to board task', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, 'LabelTest');

      const swimlaneId = await getFirstSwimlaneId(page);
      const itemId = await createBacklogTaskWithLabels(page, 'Labeled task', ['bug', 'ui'], 3);
      await promoteToBoard(page, [itemId], swimlaneId);

      // Reload the board to pick up the new task
      await page.evaluate(() => window.electronAPI.tasks.list());

      // Verify the task has labels and priority via API
      const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
      const promotedTask = (tasks as Array<{ title: string; labels: string[]; priority: number }>)
        .find((task) => task.title === 'Labeled task');

      expect(promotedTask).toBeDefined();
      expect(promotedTask!.labels).toEqual(['bug', 'ui']);
      expect(promotedTask!.priority).toBe(3);
    } finally {
      await browser.close();
    }
  });

  test('demoted task preserves labels and priority on backlog task', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, 'DemoteTest');

      const swimlaneId = await getFirstSwimlaneId(page);
      const itemId = await createBacklogTaskWithLabels(page, 'Demote test', ['feature'], 2);
      await promoteToBoard(page, [itemId], swimlaneId);

      // Get the created task
      const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
      const task = (tasks as Array<{ id: string; title: string }>)
        .find((task) => task.title === 'Demote test');
      expect(task).toBeDefined();

      // Demote back to backlog (no explicit labels/priority - should use task values)
      await page.evaluate(
        (taskId: string) => window.electronAPI.backlog.demote({ taskId }),
        task!.id,
      );

      // Verify the backlog task has the original labels and priority
      const items = await page.evaluate(() => window.electronAPI.backlog.list());
      const demotedItem = (items as Array<{ title: string; labels: string[]; priority: number }>)
        .find((item) => item.title === 'Demote test');

      expect(demotedItem).toBeDefined();
      expect(demotedItem!.labels).toEqual(['feature']);
      expect(demotedItem!.priority).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('renameLabel updates both backlog tasks and board tasks', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, 'RenameTest');

      const swimlaneId = await getFirstSwimlaneId(page);

      // Create a backlog task and a promoted task, both with 'old-label'
      await createBacklogTaskWithLabels(page, 'Backlog task', ['old-label'], 0);
      const promoteItemId = await createBacklogTaskWithLabels(page, 'Board task', ['old-label'], 1);
      await promoteToBoard(page, [promoteItemId], swimlaneId);

      // Rename the label
      await page.evaluate(() => window.electronAPI.backlog.renameLabel('old-label', 'new-label'));

      // Verify backlog task was updated
      const items = await page.evaluate(() => window.electronAPI.backlog.list());
      const backlogTask = (items as Array<{ title: string; labels: string[] }>)
        .find((item) => item.title === 'Backlog task');
      expect(backlogTask!.labels).toEqual(['new-label']);

      // Verify board task was updated
      const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
      const boardTask = (tasks as Array<{ title: string; labels: string[] }>)
        .find((task) => task.title === 'Board task');
      expect(boardTask!.labels).toEqual(['new-label']);
    } finally {
      await browser.close();
    }
  });

  test('deleteLabel removes from both backlog tasks and board tasks', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, 'DeleteTest');

      const swimlaneId = await getFirstSwimlaneId(page);

      // Create items with the label to delete
      await createBacklogTaskWithLabels(page, 'Backlog task', ['keep', 'remove'], 0);
      const promoteItemId = await createBacklogTaskWithLabels(page, 'Board task', ['keep', 'remove'], 0);
      await promoteToBoard(page, [promoteItemId], swimlaneId);

      // Delete the label
      await page.evaluate(() => window.electronAPI.backlog.deleteLabel('remove'));

      // Verify backlog task only has 'keep'
      const items = await page.evaluate(() => window.electronAPI.backlog.list());
      const backlogTask = (items as Array<{ title: string; labels: string[] }>)
        .find((item) => item.title === 'Backlog task');
      expect(backlogTask!.labels).toEqual(['keep']);

      // Verify board task only has 'keep'
      const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
      const boardTask = (tasks as Array<{ title: string; labels: string[] }>)
        .find((task) => task.title === 'Board task');
      expect(boardTask!.labels).toEqual(['keep']);
    } finally {
      await browser.close();
    }
  });

  test('label pills render on board task cards', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, 'PillTest');
      await waitForBoard(page);

      // Create a task with labels directly via the tasks API and reload the board store
      const swimlaneId = await getFirstSwimlaneId(page);
      await page.evaluate(
        ({ swimlaneId }) => {
          return window.electronAPI.tasks.create({
            title: 'Pill display task',
            description: '',
            swimlane_id: swimlaneId,
            labels: ['bug', 'frontend'],
            priority: 2,
          }).then(() => {
            const stores = (window as any).__zustandStores;
            if (stores?.board) stores.board.getState().loadBoard();
          });
        },
        { swimlaneId },
      );

      // Wait for the board to re-render with the new task
      const taskCard = page.locator('text=Pill display task');
      await expect(taskCard).toBeVisible({ timeout: 5000 });

      // Label pills should be rendered within the card
      const cardContainer = taskCard.locator('..').locator('..');
      await expect(cardContainer.locator('text=bug')).toBeVisible();
      await expect(cardContainer.locator('text=frontend')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
