/**
 * UI tests for the New Backlog Task dialog UX:
 *   - Escape/discard-confirm guard in create mode and edit mode
 *   - Maximize toggle button and Ctrl+Shift+M hotkey
 *
 * Coverage gaps addressed (#2 from the branch audit):
 *   NewBacklogTaskDialog has the same dirty-changes guard as NewTaskDialog
 *   (covered in task-attachments.spec.ts) but had no equivalent coverage.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

// Each test spins up its own browser to avoid maximize-state leakage across
// tests (maximizedTasks is a Set keyed by the sentinel 'new-backlog-task-dialog'
// and persists in the store across dialog open/close within a single page session).

// Navigate to the backlog view with the create dialog button visible.
async function openBacklogView(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();
}

// Open the New Backlog Task dialog.
async function openNewBacklogDialog(page: Page): Promise<void> {
  await page.locator('[data-testid="new-backlog-task-btn"]').click();
  await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();
  await expect(page.locator('[data-testid="backlog-task-title"]')).toBeVisible();
}

// Create a single backlog item and wait for the dialog to close.
async function createBacklogItem(page: Page, title: string): Promise<void> {
  await page.locator('[data-testid="new-backlog-task-btn"]').click();
  await page.locator('[data-testid="backlog-task-title"]').fill(title);
  await page.locator('[data-testid="create-backlog-task-btn"]').click();
  await page.locator('[data-testid="new-backlog-task-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
}

// Restore the maximize state to windowed if it was left maximized, so
// subsequent tests in the same session start clean. Called before closing the
// dialog because the sentinel flag persists in the store.
async function restoreIfMaximized(page: Page): Promise<void> {
  const isMaximized = await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { maximizedTasks: Set<string> } } };
    }).__zustandStores;
    return stores?.session.getState().maximizedTasks.has('new-backlog-task-dialog') ?? false;
  });
  if (isMaximized) {
    await page.keyboard.press('Control+Shift+M');
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(dialog).not.toHaveClass(/w-full/, { timeout: 2000 });
  }
}

test.describe('New Backlog Task Dialog - Discard Confirm (create mode)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;
    await createProject(page, `backlog-discard-create-${Date.now()}`);
    await openBacklogView(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('escape on a dirty create form shows discard confirm; Keep editing returns to the form', async () => {
    await openNewBacklogDialog(page);

    await page.locator('[data-testid="backlog-task-title"]').fill('New backlog item');

    // Escape on a dirty form must show the discard confirm, not close.
    await page.keyboard.press('Escape');
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible();

    // "Keep editing" dismisses the confirm and leaves the dialog open.
    await page.locator('button:has-text("Keep editing")').click();
    await expect(confirmHeading).not.toBeVisible();
    await expect(page.locator('[data-testid="backlog-task-title"]')).toBeVisible();

    // Cancel the form to clean up (form is still dirty so we use Cancel, not Escape).
    await page.locator('button:has-text("Cancel")').click();
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).not.toBeVisible();
  });

  test('escape on dirty create form, then Discard, closes the dialog', async () => {
    await openNewBacklogDialog(page);

    await page.locator('[data-testid="backlog-task-title"]').fill('Another backlog item');

    await page.keyboard.press('Escape');
    await expect(page.locator('h3:has-text("Discard unsaved changes?")')).toBeVisible();

    await page.locator('button:has-text("Discard")').click();
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).not.toBeVisible();
  });

  test('escape closes immediately when the create form is clean (no input)', async () => {
    await openNewBacklogDialog(page);
    // No input - form is clean. Escape must close without a confirm.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).not.toBeVisible();
  });
});

test.describe('New Backlog Task Dialog - Discard Confirm (edit mode)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;
    await createProject(page, `backlog-discard-edit-${Date.now()}`);
    await openBacklogView(page);
    // Seed one item to edit.
    await createBacklogItem(page, 'Original title');
    await expect(page.locator('[data-testid="backlog-task-row"]')).toHaveCount(1);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('changing a field in edit mode makes the form dirty and Escape shows discard confirm', async () => {
    // Open the edit dialog.
    await page.locator('[data-testid="edit-item-btn"]').click();
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="backlog-task-title"]')).toHaveValue('Original title');

    // Change the title - form becomes dirty.
    await page.locator('[data-testid="backlog-task-title"]').fill('Changed title');

    await page.keyboard.press('Escape');
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible();

    // Keep editing returns to the form with the edit intact.
    await page.locator('button:has-text("Keep editing")').click();
    await expect(confirmHeading).not.toBeVisible();
    await expect(page.locator('[data-testid="backlog-task-title"]')).toHaveValue('Changed title');

    // Discard abandons the change and closes the dialog.
    await page.keyboard.press('Escape');
    await expect(confirmHeading).toBeVisible();
    await page.locator('button:has-text("Discard")').click();
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).not.toBeVisible();

    // The task must still have its original title (discard did not save).
    await expect(page.locator('text=Original title')).toBeVisible();
    await expect(page.locator('text=Changed title')).not.toBeVisible();
  });

  test('escape on an unchanged edit dialog closes immediately without a confirm', async () => {
    // Open the edit dialog but make NO changes.
    await page.locator('[data-testid="edit-item-btn"]').click();
    await expect(page.locator('[data-testid="backlog-task-title"]')).toHaveValue('Original title');

    // Form is clean (equal to the saved task) - Escape must close directly.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).not.toBeVisible();
    // No confirm should have appeared (it's already gone, but the task is still there).
    await expect(page.locator('text=Original title')).toBeVisible();
  });
});

test.describe('New Backlog Task Dialog - Maximize Toggle', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;
    await createProject(page, `backlog-maximize-${Date.now()}`);
    await openBacklogView(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('maximize button is present and clicking it maximizes the dialog; clicking again restores', async () => {
    await openNewBacklogDialog(page);

    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const maximizeButton = page.locator('[data-testid="dialog-maximize"]');

    await expect(maximizeButton).toBeVisible();

    // Windowed state: action is "Maximize", dialog has windowed class.
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize dialog');
    await expect(dialog).toHaveClass(/w-\[840px\]/);
    await expect(dialog).toHaveClass(/rounded-lg/);

    // Click maximize - content fills the area between title bar and status bar.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Restore dialog');
    await expect(dialog).toHaveClass(/w-full/);
    await expect(dialog).toHaveClass(/h-full/);
    await expect(dialog).toHaveClass(/rounded-none/);
    const backdropMaximized = await dialog.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropMaximized).toContain('top-10');
    expect(backdropMaximized).toContain('bottom-9');

    // Click restore - back to windowed size.
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize dialog');
    await expect(dialog).toHaveClass(/w-\[840px\]/);
    await expect(dialog).toHaveClass(/rounded-lg/);
    const backdropRestored = await dialog.evaluate((el) => el.parentElement?.className ?? '');
    expect(backdropRestored).toContain('inset-0');
    expect(backdropRestored).not.toContain('top-10');

    // Clean up: form is clean, Escape closes.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('Ctrl+Shift+M hotkey toggles maximize; restore before closing to avoid sentinel leakage', async () => {
    await openNewBacklogDialog(page);

    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');

    // Starts windowed.
    await expect(dialog).toHaveClass(/w-\[840px\]/);

    // Hotkey maximizes.
    await page.keyboard.press('Control+Shift+M');
    await expect(dialog).toHaveClass(/w-full/);
    await expect(dialog).toHaveClass(/rounded-none/);

    // Restore before closing so the sentinel flag does not leak into other tests.
    await page.keyboard.press('Control+Shift+M');
    await expect(dialog).toHaveClass(/w-\[840px\]/);
    await expect(dialog).not.toHaveClass(/w-full/);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});
