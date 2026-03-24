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

  test('can create a backlog item', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-item-btn"]').click();

    // Dialog should open
    await expect(page.locator('[data-testid="new-backlog-item-dialog"]')).toBeVisible();

    // Fill in title
    await page.locator('[data-testid="backlog-item-title"]').fill('Test backlog item');

    // Fill in description
    await page.locator('[data-testid="backlog-item-description"]').fill('A test description');

    // Create
    await page.locator('[data-testid="create-backlog-item-btn"]').click();

    // Item should appear in the table
    await expect(page.locator('[data-testid="backlog-item-row"]')).toBeVisible();
    await expect(page.locator('text=Test backlog item')).toBeVisible();

    await browser.close();
  });

  test('backlog count badge updates in view toggle', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create two items
    for (const title of ['Item 1', 'Item 2']) {
      await page.locator('[data-testid="new-backlog-item-btn"]').click();
      await page.locator('[data-testid="backlog-item-title"]').fill(title);
      await page.locator('[data-testid="create-backlog-item-btn"]').click();
      await page.locator('[data-testid="new-backlog-item-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
    }

    // Count badge should show 2
    const backlogTab = page.locator('[data-testid="view-toggle-backlog"]');
    await expect(backlogTab).toContainText('2');

    await browser.close();
  });

  test('can search backlog items', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create two items
    for (const title of ['Fix login bug', 'Add dark mode']) {
      await page.locator('[data-testid="new-backlog-item-btn"]').click();
      await page.locator('[data-testid="backlog-item-title"]').fill(title);
      await page.locator('[data-testid="create-backlog-item-btn"]').click();
      await page.locator('[data-testid="new-backlog-item-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
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

  test('can delete a backlog item', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create an item
    await page.locator('[data-testid="new-backlog-item-btn"]').click();
    await page.locator('[data-testid="backlog-item-title"]').fill('Delete me');
    await page.locator('[data-testid="create-backlog-item-btn"]').click();
    await page.locator('[data-testid="new-backlog-item-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    await expect(page.locator('text=Delete me')).toBeVisible();

    // Click delete button on the row
    await page.locator('[data-testid="delete-item-btn"]').click();

    // Confirm deletion
    await page.locator('button:has-text("Delete")').last().click();

    // Item should be gone
    await expect(page.locator('text=Delete me')).not.toBeVisible();

    await browser.close();
  });

  test('can edit a backlog item', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'backlog-test');

    await page.locator('[data-testid="view-toggle-backlog"]').click();

    // Create an item
    await page.locator('[data-testid="new-backlog-item-btn"]').click();
    await page.locator('[data-testid="backlog-item-title"]').fill('Original title');
    await page.locator('[data-testid="create-backlog-item-btn"]').click();
    await page.locator('[data-testid="new-backlog-item-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Click edit button
    await page.locator('[data-testid="edit-item-btn"]').click();

    // Dialog should open with existing title
    await expect(page.locator('[data-testid="backlog-item-title"]')).toHaveValue('Original title');

    // Change title
    await page.locator('[data-testid="backlog-item-title"]').fill('Updated title');
    await page.locator('[data-testid="create-backlog-item-btn"]').click();

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
});
