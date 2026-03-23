import { test, expect, type Page } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';

let page: Page;

test.beforeEach(async () => {
  const launched = await launchPage();
  page = launched.page;
  await createProject(page, 'TestProject');
});

test.afterEach(async () => {
  await page.context().browser()?.close();
});

test.describe('Project Sidebar Actions', () => {
  test('action buttons are visible on selected project', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();

    // Project is active (selected after creation) - buttons should be visible
    await expect(sidebar.locator('button[title="Open in file explorer"]')).toBeVisible();
    await expect(sidebar.locator('button[title="Project settings"]')).toBeVisible();
    await expect(sidebar.locator('button[title="Delete project"]')).toBeVisible();
  });

  test('context menu shows core actions without groups', async () => {
    // Right-click project (no groups exist)
    await page.locator('.truncate.font-medium:text("TestProject")').first().click({ button: 'right' });

    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await expect(contextMenu).toBeVisible();

    // Core actions should be present
    await expect(contextMenu.locator('text=Rename')).toBeVisible();
    await expect(contextMenu.locator('text=Open in Explorer')).toBeVisible();
    await expect(contextMenu.locator('text=Project Settings')).toBeVisible();
    await expect(contextMenu.locator('text=Delete')).toBeVisible();

    // Group actions should NOT be present (no groups)
    await expect(contextMenu.locator('text=Move to')).toBeHidden();
  });

  test('context menu Rename triggers inline editing', async () => {
    // Right-click and select Rename
    await page.locator('.truncate.font-medium:text("TestProject")').first().click({ button: 'right' });
    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await contextMenu.locator('text=Rename').click();

    // Context menu should close
    await expect(contextMenu).toBeHidden();

    // Inline rename input should appear with current name
    const sidebar = page.locator('.bg-surface-raised').first();
    const renameInput = sidebar.locator('input.border-accent');
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveValue('TestProject');
  });

  test('inline rename saves on Enter', async () => {
    // Trigger rename
    await page.locator('.truncate.font-medium:text("TestProject")').first().click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Rename').click();

    const sidebar = page.locator('.bg-surface-raised').first();
    const renameInput = sidebar.locator('input.border-accent');
    await renameInput.fill('RenamedProject');
    await renameInput.press('Enter');

    // Input should be gone, new name should be visible
    await expect(renameInput).toBeHidden();
    await expect(sidebar.locator('.truncate.font-medium:text("RenamedProject")')).toBeVisible();
  });

  test('inline rename cancels on Escape', async () => {
    // Trigger rename
    await page.locator('.truncate.font-medium:text("TestProject")').first().click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Rename').click();

    const sidebar = page.locator('.bg-surface-raised').first();
    const renameInput = sidebar.locator('input.border-accent');
    await renameInput.fill('ShouldNotSave');
    await renameInput.press('Escape');

    // Input should be gone, original name should remain
    await expect(renameInput).toBeHidden();
    await expect(sidebar.locator('.truncate.font-medium:text("TestProject")')).toBeVisible();
  });

  test('context menu Delete opens confirmation dialog', async () => {
    await page.locator('.truncate.font-medium:text("TestProject")').first().click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Delete').click();

    await expect(page.getByRole('heading', { name: 'Delete Project' })).toBeVisible();

    // Cancel to preserve the project
    await page.locator('button:has-text("Cancel")').click();
    await expect(page.locator('.truncate.font-medium:text("TestProject")').first()).toBeVisible();
  });
});
