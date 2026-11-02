import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

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
