import { test, expect, type Browser, type Page } from '@playwright/test';
import { launchSharedBrowser, resetPage, waitForBoard, createProject } from './helpers';

// File-level parallel + per-describe default makes each top-level describe its own
// shardable test group while keeping the tests inside it in order on one worker.
test.describe.configure({ mode: 'parallel' });

/** Add a ghost swimlane to the mock board, then reload the board store. */
async function addGhostColumn(page: Page, name: string): Promise<void> {
  await page.evaluate((laneName: string) => {
    const api = (window as unknown as {
      electronAPI: {
        swimlanes: {
          create: (input: {
            name: string;
            color: string;
            is_ghost: boolean;
            auto_spawn: boolean;
          }) => Promise<unknown>;
        };
      };
    }).electronAPI;
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { loadBoard: () => void } } };
    }).__zustandStores;
    api.swimlanes.create({
      name: laneName,
      color: '#888888',
      is_ghost: true,
      auto_spawn: false,
    }).then(() => {
      stores?.board.getState().loadBoard();
    });
  }, name);
}

test.describe('Ghost Columns', () => {
  test.describe.configure({ mode: 'default' });

  let browser: Browser;
  let page: Page;

  // One browser for the describe instead of one per test; page.goto() in beforeEach
  // rebuilds the mock state so each test still starts clean.
  test.beforeAll(async () => {
    ({ browser, page } = await launchSharedBrowser());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetPage(page);
  });

  test('ghost column renders with dimmed style and tooltip', async () => {
    await createProject(page, 'ghost-test');
    await waitForBoard(page);

    // Add a ghost column to the mock swimlanes after project setup, then reload board
    await addGhostColumn(page, 'Deprecated Review');

    const ghostColumn = page.locator('[data-swimlane-name="Deprecated Review"]');
    await expect(ghostColumn).toBeVisible();

    // Verify dimmed styling (opacity-50 class)
    await expect(ghostColumn).toHaveClass(/opacity-50/);

    // Verify dashed border
    await expect(ghostColumn).toHaveClass(/border-dashed/);

    // Verify tooltip
    await expect(ghostColumn).toHaveAttribute('title', 'Removed from team config. Move tasks to continue.');
  });

  test('ghost column has no add task button', async () => {
    await createProject(page, 'ghost-no-add');
    await waitForBoard(page);

    // Add a ghost column after project setup
    await addGhostColumn(page, 'Old Column');

    const ghostColumn = page.locator('[data-swimlane-name="Old Column"]');
    await expect(ghostColumn).toBeVisible();

    // "Add task" button should not exist inside ghost column
    const addButton = ghostColumn.locator('text=Add task');
    await expect(addButton).toHaveCount(0);

    // "Removed from team config" text should be present
    const removedText = ghostColumn.locator('text=Removed from team config');
    await expect(removedText).toBeVisible();
  });
});

test.describe('Config Warning Banner', () => {
  test.describe.configure({ mode: 'default' });

  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchSharedBrowser());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await resetPage(page);
  });

  test('warning banner shows and can be dismissed', async () => {
    await createProject(page, 'warning-test');
    await waitForBoard(page);

    // Inject config warnings into the board store
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: {
          board: { getState: () => { setConfigWarnings: (warnings: string[]) => void } };
        };
      }).__zustandStores;
      if (stores?.board) {
        stores.board.getState().setConfigWarnings([
          'kangentic.json has a syntax error. Board loaded from local database.',
        ]);
      }
    });

    // Banner should appear with the warning text
    const banner = page.locator('text=kangentic.json has a syntax error');
    await expect(banner).toBeVisible();

    // Click dismiss button
    const dismissButton = page.locator('button[aria-label="Dismiss warning"]');
    await dismissButton.click();

    // Banner should be gone
    await expect(banner).not.toBeVisible();
  });
});
