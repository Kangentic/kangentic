import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

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
  test('active project row shows accent left border and no inline action buttons', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();
    const row = sidebar.locator('[role="button"]:has-text("TestProject")').first();

    // Active row carries the accent left-border class
    await expect(row).toHaveClass(/border-accent/);

    // The "Quiet" redesign removed all per-row hover icons. All actions live
    // on the right-click context menu only.
    await expect(sidebar.locator('button[title="Open in file explorer"]')).toHaveCount(0);
    await expect(sidebar.locator('button[title="Project settings"]')).toHaveCount(0);
    await expect(sidebar.locator('button[title="Delete project"]')).toHaveCount(0);
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

  test('overflow button on the active project row has opacity-100 class (always visible)', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();
    // TestProject is the active project after creation. Its row carries border-accent.
    const activeRow = sidebar.locator('[role="button"]:has-text("TestProject")').first();
    await activeRow.waitFor({ state: 'visible', timeout: 5000 });

    // The active row must have border-accent to confirm it is actually selected
    await expect(activeRow).toHaveClass(/border-accent/);

    const overflowButton = activeRow.locator('[data-testid^="project-menu-"]');
    // Source: isActive ? 'opacity-100 ...' : 'opacity-0 group-hover:opacity-100 ...'
    // The active-row button carries opacity-100 explicitly in its className.
    await expect(overflowButton).toHaveClass(/opacity-100/);
    // And the inactive-row fallback opacity-0 class is NOT present
    await expect(overflowButton).not.toHaveClass(/opacity-0/);
  });

  test('overflow button on the active row opens the same context menu as right-click', async () => {
    const sidebar = page.locator('.bg-surface-raised').first();
    const row = sidebar.locator('[role="button"]:has-text("TestProject")').first();
    await row.waitFor({ state: 'visible', timeout: 5000 });

    // Click the overflow button (testid from active row)
    const overflowButton = row.locator('[data-testid^="project-menu-"]');
    await overflowButton.click();

    const contextMenu = page.locator('.fixed.bg-surface-raised');
    await expect(contextMenu).toBeVisible();

    // Same items as right-click context menu
    await expect(contextMenu.locator('text=Rename')).toBeVisible();
    await expect(contextMenu.locator('text=Open in Explorer')).toBeVisible();
    await expect(contextMenu.locator('text=Project Settings')).toBeVisible();
    await expect(contextMenu.locator('text=Delete')).toBeVisible();
  });
});

test.describe('Project Relocation', () => {
  test('settings General tab Move confirms and updates the project path', async () => {
    // The folder picker returns the destination PARENT (consume-once
    // override); the project folder keeps its name and moves into it.
    await page.evaluate(() => {
      (window as Record<string, unknown>).__mockFolderPath = '/mock/new-location';
    });

    // Relocation lives in Project Settings > General (the context-menu entry
    // was removed). Open it from the right-click menu.
    await page.locator('.truncate.font-medium:text("TestProject")').first().click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Project Settings').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByRole('button', { name: 'General', exact: true }).click();
    await page.getByTestId('project-location-move').click();

    // Confirm dialog shows both the old and the computed new path. Scope to the
    // dialog's From/To lines: the General tab behind it also renders the old
    // path, so a bare getByText would match two elements.
    await expect(page.getByRole('heading', { name: 'Move Project Folder' })).toBeVisible();
    await expect(page.locator('p', { hasText: 'From:' })).toContainText('/mock/projects/TestProject');
    await expect(page.locator('p', { hasText: 'To:' })).toContainText('/mock/new-location/TestProject');

    await page.getByRole('button', { name: 'Move Folder', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Move Project Folder' })).toBeHidden();

    // Sidebar search matches project.path: the project must now be found by
    // the new location and no longer by the old one.
    const searchInput = page.locator('[data-testid="project-sidebar-search"]');
    await searchInput.fill('new-location');
    await expect(page.locator('.truncate.font-medium:text("TestProject")').first()).toBeVisible();
    await searchInput.fill('/mock/projects/');
    await expect(page.locator('.truncate.font-medium:text("TestProject")')).toHaveCount(0);
  });

  test('settings General tab shows the location and a Move button', async () => {
    await page.locator('.truncate.font-medium:text("TestProject")').first().click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Project Settings').click();
    await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });

    await page.getByRole('button', { name: 'General', exact: true }).click();

    await expect(page.getByTestId('project-location-path')).toHaveText('/mock/projects/TestProject');
    await expect(page.getByTestId('project-location-move')).toBeVisible();
  });

  test('missing-path push shows the Project Folder Not Found dialog', async () => {
    await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      (window as unknown as {
        __mockFireProjectPathMissing?: (id: string) => void;
      }).__mockFireProjectPathMissing?.(projects[0].id);
    });

    await expect(page.getByRole('heading', { name: 'Project Folder Not Found' })).toBeVisible();
    await expect(page.getByTestId('project-path-missing-dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Locate Folder...' })).toBeVisible();

    // Cancel dismisses without changing anything
    await page.locator('button:has-text("Cancel")').click();
    await expect(page.getByRole('heading', { name: 'Project Folder Not Found' })).toBeHidden();
  });
});
