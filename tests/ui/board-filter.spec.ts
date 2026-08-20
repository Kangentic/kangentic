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
  test('filter button is visible at top of board', async () => {
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

    // Close the popover by toggling the filter button.
    await page.locator('[data-testid="board-filter-btn"]').click();
  });

  test('click outside closes popover', async () => {
    // Open popover
    const filterButton = page.locator('[data-testid="board-filter-btn"]');
    await filterButton.click();
    await expect(page.locator('text=Priority').first()).toBeVisible();

    // Click outside the popover. The board's title bar drag region has no
    // click handler, so it's a safe outside-click target that won't open
    // any modal or trigger a context menu.
    await page.locator('text=Kangentic').first().click();

    // Intentional fixed wait (negative assertion budget): we cannot poll for
    // "Priority is gone" because the poll would return true immediately if the
    // popover has not yet animated open. The 100ms budget gives any pending
    // React state update time to fire before we assert non-visibility.
    await page.waitForTimeout(100);
    const priorityHeaders = page.locator('text=Priority');
    await expect(priorityHeaders).not.toBeVisible();
  });
});

test.describe('Board Search', () => {
  test('search input is visible on the board view', async () => {
    await expect(page.locator('[data-testid="board-search"]')).toBeVisible();
  });

  test('title match filters to matching task only', async () => {
    await page.locator('[data-testid="board-search"]').fill('auth');
    // "Auth bug fix" title contains "auth"; the other three do not
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Docs update')).not.toBeVisible();
    // Reset for subsequent tests
    await page.locator('[data-testid="board-search"]').fill('');
  });

  test('description match filters to matching task only', async () => {
    // "New chart component" is the description of "Dashboard feature";
    // no task title contains "chart".
    await page.locator('[data-testid="board-search"]').fill('chart');
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).not.toBeVisible();
    // Reset for subsequent tests
    await page.locator('[data-testid="board-search"]').fill('');
  });

  test('clear button resets input and restores all tasks', async () => {
    await page.locator('[data-testid="board-search"]').fill('auth');
    // Confirm the filter is active
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();

    // Click the clear button
    await page.locator('[data-testid="board-search-clear"]').click();

    // Input must be cleared
    await expect(page.locator('[data-testid="board-search"]')).toHaveValue('');

    // All four tasks must be visible again
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Docs update')).toBeVisible();
  });

  test('#<number> filters to the task with that ticket number', async () => {
    // Ticket number = display_id, assigned monotonically by the mock, so read
    // the real ids at runtime rather than hardcoding.
    const ids = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          electronAPI: { tasks: { list(): Promise<Array<{ title: string; display_id: number }>> } };
        }
      ).electronAPI;
      const tasks = await api.tasks.list();
      const byTitle = (title: string) =>
        tasks.find((task) => task.title === title)?.display_id as number;
      return {
        dashboard: byTitle('Dashboard feature'),
        max: Math.max(...tasks.map((task) => task.display_id)),
      };
    });

    // Full id isolates one task (the four ids are consecutive, so the exact
    // string is a prefix of only its own id).
    await page.locator('[data-testid="board-search"]').fill(`#${ids.dashboard}`);
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Docs update')).not.toBeVisible();

    // A ticket number no task has hides everything.
    await page.locator('[data-testid="board-search"]').fill(`#${ids.max + 999}`);
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).not.toBeVisible();

    // Reset for subsequent tests.
    await page.locator('[data-testid="board-search"]').fill('');
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Dashboard feature')).toBeVisible();
  });

  test('search and priority filter compose with AND logic', async () => {
    // Open the filter popover and activate "High" priority
    const filterButton = page.locator('[data-testid="board-filter-btn"]');
    await filterButton.click();
    await expect(page.locator('text=Priority').first()).toBeVisible();
    const highPill = page.locator('[data-testid="board-filter-btn"]').locator('..').locator('text=High');
    await highPill.click();

    // Close the popover before typing so it does not overlap the search input
    await page.locator('text=Kangentic').first().click();
    // Intentional fixed wait (negative assertion budget): give React time to
    // process the outside-click and close the popover before we type.
    await page.waitForTimeout(100);

    // "API refactor" matches "refactor" but is not High; "Auth bug fix" is High
    // but does not match "refactor" - so nothing should be visible.
    await page.locator('[data-testid="board-search"]').fill('refactor');
    await expect(page.locator('[data-testid="swimlane"]').locator('text=API refactor')).not.toBeVisible();
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).not.toBeVisible();

    // "auth" matches "Auth bug fix" which is also High - it should appear.
    await page.locator('[data-testid="board-search"]').fill('auth');
    await expect(page.locator('[data-testid="swimlane"]').locator('text=Auth bug fix')).toBeVisible();

    // Clean up: clear search, then un-toggle High via the popover
    await page.locator('[data-testid="board-search"]').fill('');
    await filterButton.click();
    await highPill.click();
    // Close the popover
    await page.locator('text=Kangentic').first().click();
    await page.waitForTimeout(100);
  });
});
