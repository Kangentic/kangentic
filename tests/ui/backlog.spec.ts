import { test, expect } from '@playwright/test';
import { launchPage, createProject, waitForBoard } from './helpers';

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

    // Wait for thumbnail to appear
    await page.waitForTimeout(500);
    const thumbnails = page.locator('[data-testid="attachment-thumbnails"]');
    await expect(thumbnails).toBeVisible();
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

    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="attachment-thumbnails"]')).toBeVisible();

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
