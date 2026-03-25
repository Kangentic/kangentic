import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

/**
 * Helper to update a task's labels and priority via the mock API,
 * then reload the board store so the UI reflects the changes.
 */
async function setTaskMetadata(
  targetPage: Page,
  title: string,
  metadata: { labels?: string[]; priority?: number },
): Promise<void> {
  await targetPage.evaluate(
    async ({ title: taskTitle, metadata: updates }) => {
      const api = (window as any).electronAPI;
      const tasks = await api.tasks.list();
      const task = tasks.find((t: any) => t.title === taskTitle);
      if (!task) throw new Error(`Task not found: ${taskTitle}`);
      await api.tasks.update({ id: task.id, ...updates });
    },
    { title, metadata },
  );
}

/** Reload the board and config stores to pick up mock API changes. */
async function reloadStores(targetPage: Page): Promise<void> {
  await targetPage.evaluate(async () => {
    const stores = (window as any).__zustandStores;
    if (stores?.board) await stores.board.getState().loadBoard();
    if (stores?.config) await stores.config.getState().loadConfig();
  });
  await targetPage.waitForTimeout(200);
}

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;

  await createProject(page, `filter-test-${Date.now()}`);
  await waitForBoard(page);

  // Create tasks with distinct titles
  await createTask(page, 'Auth bug fix', 'Fix authentication flow');
  await createTask(page, 'Dashboard feature', 'New chart component');
  await createTask(page, 'API refactor', 'Clean up endpoints');
  await createTask(page, 'Docs update', 'Refresh README');

  // Set labels and priorities via mock API
  await setTaskMetadata(page, 'Auth bug fix', { labels: ['bug', 'auth'], priority: 3 });
  await setTaskMetadata(page, 'Dashboard feature', { labels: ['feature'], priority: 2 });
  await setTaskMetadata(page, 'API refactor', { labels: ['refactor', 'auth'], priority: 1 });
  await setTaskMetadata(page, 'Docs update', { labels: ['docs'], priority: 0 });

  // Also set label colors in config so they show up
  await page.evaluate(async () => {
    const api = (window as any).electronAPI;
    await api.config.set({
      backlog: {
        labelColors: {
          bug: '#ef4444',
          feature: '#3b82f6',
          auth: '#f97316',
          refactor: '#8b5cf6',
          docs: '#6b7280',
        },
      },
    });
  });

  await reloadStores(page);
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Board Filters', () => {
  test('filter button is visible in search bar', async () => {
    // Ensure search bar is visible
    const searchBar = page.locator('[data-testid="board-search-bar"]');
    if (!await searchBar.isVisible()) {
      await page.keyboard.press('Control+f');
      await expect(searchBar).toBeVisible();
    }

    await expect(page.locator('[data-testid="board-filter-btn"]')).toBeVisible();
  });

  test('filter popover opens on click', async () => {
    const filterButton = page.locator('[data-testid="board-filter-btn"]');
    await filterButton.click();

    // Popover should show priority and label sections
    await expect(page.locator('text=Priority').first()).toBeVisible();
    await expect(page.locator('text=None').first()).toBeVisible();
  });

  test('priority toggle filters tasks', async () => {
    // Popover should be open from previous test
    // Click "High" priority pill (index 3)
    const highPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=High');
    await highPill.click();

    // Only the High priority task should be visible
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Docs update')).not.toBeVisible();

    // Untoggle High
    await highPill.click();

    // All tasks should be visible again
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).toBeVisible();
  });

  test('label toggle filters tasks', async () => {
    // Click "auth" label pill
    const authPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=auth');
    await authPill.click();

    // Tasks with "auth" label: Auth bug fix, API refactor
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Docs update')).not.toBeVisible();

    // Untoggle auth
    await authPill.click();
  });

  test('combined priority + label filter uses AND logic', async () => {
    // Select High priority AND auth label
    const highPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=High');
    const authPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=auth');

    await highPill.click();
    await authPill.click();

    // Only Auth bug fix has both High priority AND auth label
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).not.toBeVisible();

    // Clean up
    await highPill.click();
    await authPill.click();
  });

  test('CountBadge shows correct active filter count', async () => {
    // Select two filters
    const highPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=High');
    const bugPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=bug');

    await highPill.click();
    await bugPill.click();

    // CountBadge should show 2
    const badge = page.locator('[data-testid="board-filter-btn"]').locator('..');
    await expect(badge.locator('text=2')).toBeVisible();

    // Clean up
    await highPill.click();
    await bugPill.click();
  });

  test('clear all resets filters', async () => {
    // Select some filters
    const highPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=High');
    await highPill.click();

    // Verify filter is active
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();

    // Click clear all
    const clearButton = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=Clear all filters');
    await clearButton.click();

    // All tasks should be visible
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Docs update')).toBeVisible();

    // Close the popover by clicking outside
    await page.locator('[data-testid="board-search-input"]').click();
  });

  test('filter + search query uses AND logic', async () => {
    // First open filter popover and select "High" priority
    const filterButton = page.locator('[data-testid="board-filter-btn"]');
    await filterButton.click();
    await expect(page.locator('text=Priority').first()).toBeVisible();

    const highPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=High');
    await highPill.click();

    // With only High filter, "Auth bug fix" should be visible (it has priority 3 = High)
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();

    // Now also type "Dashboard" in search - should match nothing (search="Dashboard" AND priority=High)
    const searchInput = page.locator('[data-testid="board-search-input"]');
    await searchInput.fill('Dashboard');

    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();

    // Clean up - clear search and untoggle High
    await searchInput.fill('');
    await highPill.click();
    // Close popover
    await searchInput.click();
  });

  test('click outside closes popover', async () => {
    // Open popover
    const filterButton = page.locator('[data-testid="board-filter-btn"]');
    await filterButton.click();
    await expect(page.locator('text=Priority').first()).toBeVisible();

    // Click outside the popover
    await page.locator('[data-testid="board-search-input"]').click();

    // Verify popover closed by checking Priority header is no longer visible
    // (the only "Priority" text on page should be in the popover)
    await page.waitForTimeout(100);
    const priorityHeaders = page.locator('text=Priority');
    await expect(priorityHeaders).not.toBeVisible();
  });
});
