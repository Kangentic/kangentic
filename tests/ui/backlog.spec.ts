import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';

// Each describe is isolated per worker (separate process). Within a worker, tests either
// launch their own browser ('Backlog View') or reset shared store state between tests
// ('Backlog Search and Filter'), so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

test.describe('Backlog View', () => {
  test.beforeEach(async ({ }, testInfo) => {
    testInfo.setTimeout(30000);
  });

  test('view toggle shows Board and Backlog tabs', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    const boardTab = page.locator('[data-testid="view-toggle-board"]');
    const backlogTab = page.locator('[data-testid="view-toggle-backlog"]');
    await expect(boardTab).toBeVisible();
    await expect(backlogTab).toBeVisible();
    await expect(boardTab).toHaveText('Board');

    await browser.close();
  });

  test('clicking Backlog tab switches to backlog view', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    // Board view should be active by default
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();

    // Switch to backlog
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();

    // Board columns should not be visible
    await expect(page.locator('[data-swimlane-name="To Do"]')).not.toBeVisible();

    // Switch back to board
    await page.locator('[data-testid="view-toggle-board"]').click();
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();

    await browser.close();
  });

  test('backlog shows empty state when no items', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await expect(page.locator('text=Backlog is empty')).toBeVisible();

    await browser.close();
  });

  test('can create a backlog task', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-task-btn"]').click();

    // Dialog should open
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();

    // Fill in title
    await page.locator('[data-testid="backlog-task-title"]').fill('Test backlog task');

    // Fill in description
    await page.locator('[data-testid="backlog-task-description"]').fill('A test description');

    // Create
    await page.locator('[data-testid="create-backlog-task-btn"]').click();

    // Item should appear in the table
    await expect(page.locator('[data-testid="backlog-task-row"]')).toBeVisible();
    await expect(page.locator('text=Test backlog task')).toBeVisible();

    await browser.close();
  });

  test('backlog count badge updates in view toggle', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create two items
    for (const title of ['Item 1', 'Item 2']) {
      await page.locator('[data-testid="new-backlog-task-btn"]').click();
      await page.locator('[data-testid="backlog-task-title"]').fill(title);
      await page.locator('[data-testid="create-backlog-task-btn"]').click();
      await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    }

    // Count badge should show 2
    const backlogTab = page.locator('[data-testid="view-toggle-backlog"]');
    await expect(backlogTab).toContainText('2');

    await browser.close();
  });

  test('can search backlog tasks', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create two items
    for (const title of ['Fix login bug', 'Add dark mode']) {
      await page.locator('[data-testid="new-backlog-task-btn"]').click();
      await page.locator('[data-testid="backlog-task-title"]').fill(title);
      await page.locator('[data-testid="create-backlog-task-btn"]').click();
      await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    }

    // Search for "login"
    await page.locator('[data-testid="backlog-search"]').fill('login');

    // Only matching item should be visible
    await expect(page.locator('text=Fix login bug')).toBeVisible();
    await expect(page.locator('text=Add dark mode')).not.toBeVisible();

    // Clear search
    await page.locator('[data-testid="backlog-search"]').fill('');
    await expect(page.locator('text=Add dark mode')).toBeVisible();

    await browser.close();
  });

  test('can delete a backlog task', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create an item
    await page.locator('[data-testid="new-backlog-task-btn"]').click();
    await page.locator('[data-testid="backlog-task-title"]').fill('Delete me');
    await page.locator('[data-testid="create-backlog-task-btn"]').click();
    await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    await expect(page.locator('text=Delete me')).toBeVisible();

    // Click delete button on the row
    await page.locator('[data-testid="delete-item-btn"]').click();

    // Confirm deletion
    await page.locator('button:has-text("Delete")').last().click();

    // Item should be gone
    await expect(page.locator('text=Delete me')).not.toBeVisible();

    await browser.close();
  });

  test('can edit a backlog task', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create an item
    await page.locator('[data-testid="new-backlog-task-btn"]').click();
    await page.locator('[data-testid="backlog-task-title"]').fill('Original title');
    await page.locator('[data-testid="create-backlog-task-btn"]').click();
    await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Click edit button
    await page.locator('[data-testid="edit-item-btn"]').click();

    // Dialog should open with existing title
    await expect(page.locator('[data-testid="backlog-task-title"]')).toHaveValue('Original title');

    // Change title
    await page.locator('[data-testid="backlog-task-title"]').fill('Updated title');
    await page.locator('[data-testid="create-backlog-task-btn"]').click();

    // Updated title should appear
    await expect(page.locator('text=Updated title')).toBeVisible();
    await expect(page.locator('text=Original title')).not.toBeVisible();

    await browser.close();
  });

  test('toolbar shows Labels and Priorities buttons', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    await expect(page.locator('[data-testid="manage-labels-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="manage-priorities-btn"]')).toBeVisible();

    await browser.close();
  });

  test('filter button shows and works', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    const filterButton = page.locator('[data-testid="backlog-filter-btn"]');
    await expect(filterButton).toBeVisible();
    await expect(filterButton).toHaveText(/Filter/);

    // Click to open filter popover
    await filterButton.click();

    // Priority section should be visible
    await expect(page.locator('text=PRIORITY')).toBeVisible();

    await browser.close();
  });

  test('create backlog task with attachment passes pendingAttachments', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-attach-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-task-btn"]').click();

    // Fill in title
    await page.locator('[data-testid="backlog-task-title"]').fill('Item with image');

    // Paste an image into the description textarea
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="backlog-task-description"]');
      if (!textarea) return;
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'screenshot.png', { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer }));
    });

    // The toBeVisible assertion polls until the thumbnail renders after the
    // synchronous paste event is processed by React - no fixed wait needed.
    const thumbnails = page.locator('[data-testid="attachment-thumbnails"]');
    await expect(thumbnails).toBeVisible({ timeout: 2000 });
    await expect(page.locator('text=1 attachment')).toBeVisible();

    // Submit the form
    await page.locator('[data-testid="create-backlog-task-btn"]').click();
    await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Item should appear in the backlog table
    await expect(page.locator('text=Item with image')).toBeVisible();

    // Verify the mock received pendingAttachments by checking stored attachment_count
    const attachmentCount = await page.evaluate(() => {
      return window.electronAPI.backlog.list().then(
        (items: Array<{ title: string; attachment_count: number }>) =>
          items.find((item) => item.title === 'Item with image')?.attachment_count
      );
    });
    expect(attachmentCount).toBe(1);

    await browser.close();
  });

  test('edit backlog task with new attachment updates attachment_count', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-edit-attach-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create an item without attachments
    await page.locator('[data-testid="new-backlog-task-btn"]').click();
    await page.locator('[data-testid="backlog-task-title"]').fill('Edit me later');
    await page.locator('[data-testid="create-backlog-task-btn"]').click();
    await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Open edit dialog
    await page.locator('[data-testid="edit-item-btn"]').click();
    await expect(page.locator('[data-testid="backlog-task-title"]')).toHaveValue('Edit me later');

    // Paste an image
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="backlog-task-description"]');
      if (!textarea) return;
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'update.png', { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer }));
    });

    // The toBeVisible assertion polls until the thumbnail renders after the
    // synchronous paste event is processed by React - no fixed wait needed.
    await expect(page.locator('[data-testid="attachment-thumbnails"]')).toBeVisible({ timeout: 2000 });

    // Save
    await page.locator('[data-testid="create-backlog-task-btn"]').click();
    await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Verify attachment_count was incremented via mock
    const attachmentCount = await page.evaluate(() => {
      return window.electronAPI.backlog.list().then(
        (items: Array<{ title: string; attachment_count: number }>) =>
          items.find((item) => item.title === 'Edit me later')?.attachment_count
      );
    });
    expect(attachmentCount).toBe(1);

    await browser.close();
  });

  test('context menu on multi-selected items shows count and moves all', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-ctx-multi');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create three items
    for (const title of ['Task A', 'Task B', 'Task C']) {
      await page.locator('[data-testid="new-backlog-task-btn"]').click();
      await page.locator('[data-testid="backlog-task-title"]').fill(title);
      await page.locator('[data-testid="create-backlog-task-btn"]').click();
      await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    }

    const rows = page.locator('[data-testid="backlog-task-row"]');
    await expect(rows).toHaveCount(3);

    // Select first two items via checkboxes
    await rows.nth(0).locator('[data-testid="backlog-task-checkbox"]').check();
    await rows.nth(1).locator('[data-testid="backlog-task-checkbox"]').check();

    // Right-click the first selected item
    await rows.nth(0).click({ button: 'right' });

    // Context menu should show count in "Move to Board" header
    await expect(page.locator('text=Move 2 to Board')).toBeVisible();
    await expect(page.locator('text=Delete 2 items')).toBeVisible();

    // Click the first swimlane target to move both
    await page.locator('[data-testid="context-move-to-board"]').first().click();

    // Only one item should remain in the backlog
    await expect(rows).toHaveCount(1);
    await expect(page.locator('text=Task C')).toBeVisible();

    await browser.close();
  });

  test('bulk delete via context menu opens ConfirmDialog and removes both rows', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-bulk-delete');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create two items
    for (const title of ['Delete Alpha', 'Delete Beta']) {
      await page.locator('[data-testid="new-backlog-task-btn"]').click();
      await page.locator('[data-testid="backlog-task-title"]').fill(title);
      await page.locator('[data-testid="create-backlog-task-btn"]').click();
      await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    }

    const rows = page.locator('[data-testid="backlog-task-row"]');
    await expect(rows).toHaveCount(2);

    // Select both items via checkboxes
    await rows.nth(0).locator('[data-testid="backlog-task-checkbox"]').check();
    await rows.nth(1).locator('[data-testid="backlog-task-checkbox"]').check();

    // Right-click the first selected item to open context menu
    await rows.nth(0).click({ button: 'right' });

    // Context menu should show the multi-select delete label
    await expect(page.locator('[data-testid="context-delete-item"]')).toBeVisible();
    await expect(page.locator('[data-testid="context-delete-item"]')).toHaveText('Delete 2 items');

    // Click the bulk delete item - this sets pendingBulkDelete=true in the store
    await page.locator('[data-testid="context-delete-item"]').click();

    // ConfirmDialog should appear with the correct confirm label
    await expect(page.locator('button:has-text("Delete 2 items")')).toBeVisible();

    // Confirm the deletion
    await page.locator('button:has-text("Delete 2 items")').click();

    // Both rows should be gone
    await expect(rows).toHaveCount(0);
    await expect(page.locator('text=Delete Alpha')).not.toBeVisible();
    await expect(page.locator('text=Delete Beta')).not.toBeVisible();

    await browser.close();
  });

  test('dialog state survives BacklogView unmount when toggling to board and back', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-dialog-persist');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Set showNewDialog=true directly in the store without opening the dialog
    // via UI. This avoids the backdrop-over-view-toggle problem (the backdrop
    // is a fixed inset-0 overlay that intercepts clicks on the board toggle).
    // We want to prove that the store state survives unmount, not that the
    // toolbar button sets the state - that is already tested separately.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { backlog: { setState: (state: Record<string, unknown>) => void } };
      }).__zustandStores;
      stores.backlog.setState({ showNewDialog: true });
    });

    // Dialog should now be visible (rendered by BacklogDialogs from store state)
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();

    // Switch to Board view via the store directly. The dialog backdrop (fixed inset-0)
    // covers the view toggle button, so clicking it via UI would be intercepted by the
    // backdrop's onMouseUp and close the dialog instead of switching views.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { board: { setState: (state: Record<string, unknown>) => void } };
      }).__zustandStores;
      stores.board.setState({ activeView: 'board' });
    });

    // The dialog (and its entire subtree) is gone from the DOM because
    // BacklogDialogs only renders inside the backlog branch of AppLayout
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).not.toBeAttached();

    // Switch back to Backlog view via store - same reason as above
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores: { board: { setState: (state: Record<string, unknown>) => void } };
      }).__zustandStores;
      stores.board.setState({ activeView: 'backlog' });
    });

    // Dialog should be visible again because the store-lifted state survived unmount.
    // If someone adds a clearDialogState() call on BacklogView unmount, this breaks.
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();

    await browser.close();
  });

  test('context menu on unselected item resets selection', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-ctx-reset');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create two items
    for (const title of ['Item X', 'Item Y']) {
      await page.locator('[data-testid="new-backlog-task-btn"]').click();
      await page.locator('[data-testid="backlog-task-title"]').fill(title);
      await page.locator('[data-testid="create-backlog-task-btn"]').click();
      await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    }

    const rows = page.locator('[data-testid="backlog-task-row"]');

    // Select the first item
    await rows.nth(0).locator('[data-testid="backlog-task-checkbox"]').check();
    await expect(rows.nth(0).locator('[data-testid="backlog-task-checkbox"]')).toBeChecked();

    // Right-click the second (unselected) item
    await rows.nth(1).click({ button: 'right' });

    // First item should no longer be selected, second should be selected
    await expect(rows.nth(0).locator('[data-testid="backlog-task-checkbox"]')).not.toBeChecked();
    await expect(rows.nth(1).locator('[data-testid="backlog-task-checkbox"]')).toBeChecked();

    // Context menu should show single-item labels (not multi-select counts)
    await expect(page.locator('[data-testid="context-move-to-board"]').first()).toBeVisible();
    await expect(page.locator('text=Delete 2 items')).not.toBeVisible();
    await expect(page.locator('[data-testid="context-delete-item"]')).toHaveText('Delete');

    await browser.close();
  });
});

/**
 * Shared fixture for backlog search+filter tests (gaps 1-6).
 * Uses a beforeAll/afterAll pattern (mirrors board-filter.spec.ts) to avoid
 * spinning up a new browser per test - all tests here need the same seed data.
 *
 * Seed layout:
 *   Item A - "Fix login bug"         description "auth service broken"  labels:['bug','auth']  priority:3 (High)
 *   Item B - "Add dark mode"         description "theme switcher"       labels:['feature']     priority:2 (Medium)
 *   Item C - "Refactor API routes"   description "clean up endpoints"   labels:['refactor']    priority:1 (Low)
 *   Board task D - "Board task only" labels:['board-only']  (board task, NOT in backlog)
 */
test.describe('Backlog Search and Filter', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;

    await createProject(page, `backlog-filter-test-${Date.now()}`);
    await waitForBoard(page);

    // Create a board task with a board-only label for gap 6.
    // Done before switching to backlog so the task lands in the To Do swimlane.
    await page.evaluate(async () => {
      const api = (window as Record<string, unknown>).electronAPI as {
        tasks: {
          list: () => Promise<Array<{ id: string; title: string }>>;
          create: (input: { title: string; description: string; swimlane_id: string; labels: string[] }) => Promise<{ id: string }>;
        };
        swimlanes: { list: () => Promise<Array<{ id: string; name: string }>> };
      };
      const swimlanes = await api.swimlanes.list();
      const todoLane = swimlanes.find((swimlane) => swimlane.name === 'To Do');
      if (!todoLane) throw new Error('To Do lane not found');
      await api.tasks.create({
        title: 'Board task only',
        description: '',
        swimlane_id: todoLane.id,
        labels: ['board-only'],
      });
    });

    // Switch to backlog view
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();

    // Set up label colors so the labels render in the filter popover
    await page.evaluate(async () => {
      const api = (window as Record<string, unknown>).electronAPI as {
        config: { set: (partial: Record<string, unknown>) => Promise<void> };
      };
      await api.config.set({
        backlog: {
          labelColors: {
            bug: '#ef4444',
            auth: '#f97316',
            feature: '#3b82f6',
            refactor: '#8b5cf6',
            'board-only': '#06b6d4',
          },
        },
      });
    });

    // Create three backlog items via UI
    type BacklogItemInput = { title: string; description: string };
    const backlogItems: BacklogItemInput[] = [
      { title: 'Fix login bug', description: 'auth service broken' },
      { title: 'Add dark mode', description: 'theme switcher' },
      { title: 'Refactor API routes', description: 'clean up endpoints' },
    ];

    for (const item of backlogItems) {
      await page.locator('[data-testid="new-backlog-task-btn"]').click();
      await page.locator('[data-testid="backlog-task-title"]').fill(item.title);
      await page.locator('[data-testid="backlog-task-description"]').fill(item.description);
      await page.locator('[data-testid="create-backlog-task-btn"]').click();
      await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    }

    // Verify all three rows are present before proceeding
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(3, { timeout: 5000 });

    // Set labels and priorities via the IPC mock directly (avoids UI label-picker flow)
    await page.evaluate(async () => {
      const api = (window as Record<string, unknown>).electronAPI as {
        backlog: {
          list: () => Promise<Array<{ id: string; title: string }>>;
          update: (input: { id: string; labels?: string[]; priority?: number }) => Promise<void>;
        };
      };
      const items = await api.backlog.list();
      const findItem = (title: string) => items.find((item) => item.title === title);

      const fixLoginBug = findItem('Fix login bug');
      const addDarkMode = findItem('Add dark mode');
      const refactorApi = findItem('Refactor API routes');

      if (fixLoginBug) await api.backlog.update({ id: fixLoginBug.id, labels: ['bug', 'auth'], priority: 3 });
      if (addDarkMode) await api.backlog.update({ id: addDarkMode.id, labels: ['feature'], priority: 2 });
      if (refactorApi) await api.backlog.update({ id: refactorApi.id, labels: ['refactor'], priority: 1 });
    });

    // Reload the backlog store to pick up the updated metadata
    await page.evaluate(async () => {
      const stores = (window as Record<string, unknown>).__zustandStores as {
        backlog: { getState: () => { loadBacklog: () => Promise<void> } };
        config: { getState: () => { loadConfig: () => Promise<void> } };
      };
      await stores.backlog.getState().loadBacklog();
      await stores.config.getState().loadConfig();
    });

    // Wait for the data to stabilize (config reload is async)
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(3, { timeout: 5000 });
  });

  test.afterAll(async () => {
    // Clear any leftover filter/search state so one test doesn't bleed into another
    await page?.evaluate(() => {
      const stores = (window as Record<string, unknown>).__zustandStores as {
        backlog: {
          setState: (state: Record<string, unknown>) => void;
        };
      };
      stores.backlog.setState({
        backlogSearchQuery: '',
        backlogPriorityFilters: new Set<number>(),
        backlogLabelFilters: new Set<string>(),
      });
    });
    await browser?.close();
  });

  // After each test, reset search and filters so tests are independent.
  test.afterEach(async () => {
    await page.evaluate(() => {
      const stores = (window as Record<string, unknown>).__zustandStores as {
        backlog: {
          setState: (state: Record<string, unknown>) => void;
        };
      };
      stores.backlog.setState({
        backlogSearchQuery: '',
        backlogPriorityFilters: new Set<number>(),
        backlogLabelFilters: new Set<string>(),
      });
    });
    // Close the filter popover if it was left open. The popover is rendered
    // inside the container that wraps the filter button (via ToolbarSearchFilter),
    // so scope the check to avoid matching the column header in the data table.
    const filterContainer = page.locator('[data-testid="backlog-filter-btn"]').locator('..');
    const priorityInPopover = filterContainer.locator('text=Priority').first();
    if (await priorityInPopover.isVisible()) {
      await page.locator('text=Kangentic').first().click();
      // Intentional fixed wait (negative assertion budget): give React time to
      // process the outside-click and close the popover.
      await page.waitForTimeout(100);
    }
    // Also ensure the search input is cleared in the DOM (the store setState above
    // drives the controlled input, but give React one tick to re-render).
    await expect(page.locator('[data-testid="backlog-search"]')).toHaveValue('', { timeout: 2000 });
  });

  // ---------- Gap 1: search matches DESCRIPTION ---------------------------

  test('backlog search matches description text and clear restores all rows', async () => {
    // "auth service broken" is Item A's description; no title contains "auth service"
    await page.locator('[data-testid="backlog-search"]').fill('auth service');

    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(1);
    await expect(page.locator('text=Fix login bug')).toBeVisible();
    await expect(page.locator('text=Add dark mode')).not.toBeVisible();
    await expect(page.locator('text=Refactor API routes')).not.toBeVisible();

    // Filling with empty string clears via the onChange handler
    await page.locator('[data-testid="backlog-search"]').fill('');
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(3);
  });

  // ---------- Gap 2: PRIORITY filter filters rows -------------------------

  test('backlog priority filter shows matching rows and un-toggle restores all', async () => {
    // filterContainer wraps the filter button and the popover; scope all popover
    // locators to it so they don't match the Priority column in the data table.
    const filterContainer = page.locator('[data-testid="backlog-filter-btn"]').locator('..');
    const filterButton = page.locator('[data-testid="backlog-filter-btn"]');
    await filterButton.click();
    await expect(filterContainer.locator('text=Priority').first()).toBeVisible();

    // Priority index 3 = "High" in the mock config (None=0, Low=1, Medium=2, High=3)
    const highPill = filterContainer.locator('text=High');
    await highPill.click();

    // Only Item A has priority 3 (High)
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(1);
    await expect(page.locator('text=Fix login bug')).toBeVisible();
    await expect(page.locator('text=Add dark mode')).not.toBeVisible();
    await expect(page.locator('text=Refactor API routes')).not.toBeVisible();

    // Un-toggle High - all rows restored
    await highPill.click();
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(3);

    // Close the popover
    await page.locator('text=Kangentic').first().click();
    await page.waitForTimeout(100);
  });

  // ---------- Gap 3: LABEL filter filters rows ----------------------------

  test('backlog label filter shows matching rows and un-toggle restores all', async () => {
    const filterContainer = page.locator('[data-testid="backlog-filter-btn"]').locator('..');
    const filterButton = page.locator('[data-testid="backlog-filter-btn"]');
    await filterButton.click();
    await expect(filterContainer.locator('text=Priority').first()).toBeVisible();

    // "auth" label is on Item A (Fix login bug) only
    const authPill = filterContainer.locator('text=auth');
    await authPill.click();

    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(1);
    await expect(page.locator('text=Fix login bug')).toBeVisible();
    await expect(page.locator('text=Add dark mode')).not.toBeVisible();
    await expect(page.locator('text=Refactor API routes')).not.toBeVisible();

    // Un-toggle auth - all rows restored
    await authPill.click();
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(3);

    // Close the popover
    await page.locator('text=Kangentic').first().click();
    await page.waitForTimeout(100);
  });

  // ---------- Gap 4: search + priority AND-compose ------------------------

  test('backlog search and priority filter compose with AND logic', async () => {
    const filterContainer = page.locator('[data-testid="backlog-filter-btn"]').locator('..');
    const filterButton = page.locator('[data-testid="backlog-filter-btn"]');
    await filterButton.click();
    await expect(filterContainer.locator('text=Priority').first()).toBeVisible();

    const highPill = filterContainer.locator('text=High');
    await highPill.click();

    // Close the popover before typing so it does not overlap the search input
    await page.locator('text=Kangentic').first().click();
    // Intentional fixed wait (negative assertion budget): give React time to
    // process the outside-click and close the popover before typing.
    await page.waitForTimeout(100);

    // "refactor" matches Item C by title, but Item C is NOT High priority - must be hidden
    await page.locator('[data-testid="backlog-search"]').fill('refactor');
    await expect(page.locator('text=Refactor API routes')).not.toBeVisible();
    await expect(page.locator('text=Fix login bug')).not.toBeVisible();

    // "auth" matches Item A by label+description and Item A IS High - must be visible
    await page.locator('[data-testid="backlog-search"]').fill('auth');
    await expect(page.locator('text=Fix login bug')).toBeVisible();
    await expect(page.locator('text=Refactor API routes')).not.toBeVisible();

    // Clean up: clear search, then un-toggle High via the popover
    await page.locator('[data-testid="backlog-search"]').fill('');
    await filterButton.click();
    await highPill.click();
    await page.locator('text=Kangentic').first().click();
    await page.waitForTimeout(100);
  });

  // ---------- Gap 5: backlog-search-clear button --------------------------

  test('backlog-search-clear button clears the input and restores all rows', async () => {
    await page.locator('[data-testid="backlog-search"]').fill('auth');

    // Filter is active: only 1 row visible
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(1);

    // Click the clear button (NOT fill(''))
    await page.locator('[data-testid="backlog-search-clear"]').click();

    // Input must be cleared
    await expect(page.locator('[data-testid="backlog-search"]')).toHaveValue('');

    // All three rows must be restored
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(3);
  });

  // ---------- Gap 6: backlogLabels includes board-task labels -------------

  test('board-task label appears in backlog filter popover', async () => {
    // The 'board-only' label exists ONLY on the board task created in beforeAll,
    // not on any backlog item. ViewToggle builds backlogLabels from
    // backlogItems + boardTasks, so 'board-only' must appear in the popover.
    //
    // First reload the board store so the board task's labels are in memory.
    await page.evaluate(async () => {
      const stores = (window as Record<string, unknown>).__zustandStores as {
        board: { getState: () => { loadBoard: () => Promise<void> } };
      };
      await stores.board.getState().loadBoard();
    });

    const filterContainer = page.locator('[data-testid="backlog-filter-btn"]').locator('..');
    const filterButton = page.locator('[data-testid="backlog-filter-btn"]');
    await filterButton.click();
    await expect(filterContainer.locator('text=Priority').first()).toBeVisible();

    // The board-only label must appear as a toggleable pill in the label section
    const boardOnlyPill = filterContainer.locator('text=board-only');
    await expect(boardOnlyPill).toBeVisible({ timeout: 3000 });

    // Toggling it should filter to 0 backlog rows (no backlog item has 'board-only')
    await boardOnlyPill.click();
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(0);

    // Un-toggle restores all rows
    await boardOnlyPill.click();
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(3);

    // Close the popover
    await page.locator('text=Kangentic').first().click();
    await page.waitForTimeout(100);
  });
});
