/**
 * UI tests for the New Backlog Task dialog UX:
 *   - Escape/discard-confirm guard in create mode and edit mode
 *   - Maximize toggle button and Ctrl+Shift+M hotkey
 *   - Header (Pencil/Plus icon, source link, priority badge), the read-only
 *     meta row, and the footer Delete affordance added to bring this dialog
 *     up to the board task-detail's visual treatment
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

    // Windowed state: action is "Maximize", dialog has windowed class. The
    // windowed class now carries a definite height (h-[80vh]) so the
    // description editor's flex-1 chain has something to fill against
    // instead of being inert - see NewBacklogTaskDialog.tsx's maximizedDialogLayout call.
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize dialog');
    await expect(dialog).toHaveClass(/w-\[840px\]/);
    await expect(dialog).toHaveClass(/h-\[80vh\]/);
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

// Seed the edit dialog directly through the backlog store, mirroring
// attachment-open-failure.spec.ts's openBacklogEditDialog helper. Bypasses the
// row-click UI so fields no create/edit flow can currently write (assignee,
// external_source/url) can still be exercised.
async function seedBacklogEditItem(
  page: Page,
  title: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();

  await page.evaluate(({ taskTitle, taskOverrides }) => {
    const stores = (window as unknown as {
      __zustandStores?: { backlog?: { getState: () => { setEditingItem: (task: unknown) => void } } };
    }).__zustandStores;
    if (!stores?.backlog) throw new Error('backlog store not exposed on __zustandStores');
    const now = new Date().toISOString();
    stores.backlog.getState().setEditingItem(Object.assign({
      id: `backlog-header-test-${Date.now()}`,
      title: taskTitle,
      description: '',
      priority: 0,
      labels: [],
      position: 0,
      assignee: null,
      due_date: null,
      item_type: null,
      external_id: null,
      external_source: null,
      external_url: null,
      sync_status: null,
      external_metadata: null,
      attachment_count: 0,
      created_at: now,
      updated_at: now,
    }, taskOverrides));
  }, { taskTitle: title, taskOverrides: overrides });

  await expect(page.locator('[data-testid="new-backlog-task-dialog"]')).toBeVisible();
}

test.describe('New Backlog Task Dialog - Header, Delete, Meta', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchPage();
    browser = result.browser;
    page = result.page;
    await createProject(page, `backlog-header-delete-${Date.now()}`);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('header shows the Plus icon in create mode and the Pencil icon in edit mode', async () => {
    await openBacklogView(page);
    await openNewBacklogDialog(page);
    const createDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(createDialog.locator('svg.lucide-plus')).toBeVisible();
    await expect(createDialog.locator('svg.lucide-pencil')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(createDialog).not.toBeVisible();

    await seedBacklogEditItem(page, 'Icon check item');
    const editDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(editDialog.locator('svg.lucide-pencil')).toBeVisible();
    await expect(editDialog.locator('svg.lucide-plus')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(editDialog).not.toBeVisible();
  });

  test('header priority badge tracks the live Priority select and hides at None', async () => {
    await openBacklogView(page);
    await openNewBacklogDialog(page);
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const headerTitle = dialog.locator('h3');

    // No priority selected yet - the badge self-hides (PriorityBadge returns
    // null at priority 0 with no showLabel), so the header carries only the
    // dialog title.
    await expect(headerTitle).toHaveText('New Backlog Task');

    await dialog.locator('[data-testid="backlog-task-priority"]').selectOption({ label: 'Medium' });
    await expect(headerTitle).toContainText('Medium');

    await dialog.locator('[data-testid="backlog-task-priority"]').selectOption({ label: 'None' });
    await expect(headerTitle).toHaveText('New Backlog Task');

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('header shows a source link only when external_source and external_url are set, and opens it', async () => {
    await seedBacklogEditItem(page, 'No source item');
    const plainDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(plainDialog.locator('[data-testid="backlog-task-external-link"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(plainDialog).not.toBeVisible();

    await seedBacklogEditItem(page, 'Imported item', {
      external_source: 'github_issues',
      external_url: 'https://github.com/kangentic/kangentic/issues/42',
    });
    const importedDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const link = importedDialog.locator('[data-testid="backlog-task-external-link"]');
    await expect(link).toBeVisible();
    await link.click();
    const openedUrls = await page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []);
    expect(openedUrls).toContain('https://github.com/kangentic/kangentic/issues/42');

    await page.keyboard.press('Escape');
    await expect(importedDialog).not.toBeVisible();
  });

  test('meta row is edit-mode only, always shows Created and updated as one sentence, and the assignee chip only when set', async () => {
    await openBacklogView(page);
    await openNewBacklogDialog(page);
    const createDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(createDialog.locator('[data-testid="backlog-task-meta"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(createDialog).not.toBeVisible();

    // Both times always show, joined as one sentence ("Created X, updated Y")
    // rather than two adjacent capitalized spans - the latter read as a
    // stutter, especially right after creating an item when both times are
    // seconds apart.
    await seedBacklogEditItem(page, 'Edited item', {
      created_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });
    const editedDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const editedMeta = editedDialog.locator('[data-testid="backlog-task-meta"]');
    await expect(editedMeta).toBeVisible();
    await expect(editedMeta).toContainText('Created');
    await expect(editedMeta).toContainText('updated');
    await expect(editedMeta).not.toContainText('@');
    await page.keyboard.press('Escape');
    await expect(editedDialog).not.toBeVisible();

    await seedBacklogEditItem(page, 'Assigned item', { assignee: 'octocat' });
    const assignedDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const assignedMeta = assignedDialog.locator('[data-testid="backlog-task-meta"]');
    await expect(assignedMeta).toContainText('@octocat');
    await page.keyboard.press('Escape');
    await expect(assignedDialog).not.toBeVisible();
  });

  test('Delete is absent in create mode and present in edit mode; confirming deletes the item and closes', async () => {
    await openBacklogView(page);
    await openNewBacklogDialog(page);
    const createDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(createDialog.locator('[data-testid="delete-backlog-task-btn"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(createDialog).not.toBeVisible();

    await createBacklogItem(page, 'Delete me from the dialog');
    await expect(page.locator('text=Delete me from the dialog')).toBeVisible();
    await page.locator('[data-testid="edit-item-btn"]').click();
    const editDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(editDialog).toBeVisible();

    const deleteButton = editDialog.locator('[data-testid="delete-backlog-task-btn"]');
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    const confirmHeading = page.locator('h3:has-text("Delete backlog task")');
    await expect(confirmHeading).toBeVisible();
    await page.locator('button:has-text("Delete")').last().click();

    await expect(editDialog).not.toBeVisible();
    await expect(page.locator('text=Delete me from the dialog')).not.toBeVisible();
  });

  test('Delete with skipDeleteConfirm set deletes immediately with no confirm dialog', async () => {
    await openBacklogView(page);
    await createBacklogItem(page, 'Delete me without asking');
    await expect(page.locator('text=Delete me without asking')).toBeVisible();

    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config?: { getState: () => { updateConfig: (partial: Record<string, unknown>) => Promise<void> } } };
      }).__zustandStores;
      void stores?.config?.getState().updateConfig({ skipDeleteConfirm: true });
    });

    await page.locator('[data-testid="edit-item-btn"]').click();
    const editDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(editDialog).toBeVisible();

    await editDialog.locator('[data-testid="delete-backlog-task-btn"]').click();
    await expect(editDialog).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=Delete me without asking')).not.toBeVisible();

    // Restore the shared page's config for any later test in this describe.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config?: { getState: () => { updateConfig: (partial: Record<string, unknown>) => Promise<void> } } };
      }).__zustandStores;
      void stores?.config?.getState().updateConfig({ skipDeleteConfirm: false });
    });
  });

  // Red-green for the isDirty defect: edit-mode isDirty used to end with
  // `attachments.length > 0`, but the load effect pushes SAVED attachments
  // into that same array - so opening an item that already has an attachment
  // reported dirty on arrival and Escape popped the discard confirm with zero
  // user edits. Fails before the `hasPendingAttachments` fix.
  test('opening an edit item with a saved attachment and Escape closes immediately, no false discard confirm', async () => {
    await page.evaluate(() => {
      window.electronAPI.backlogAttachments.list = async () => [{
        id: 'ba-dirty-regression',
        backlog_task_id: 'unused',
        filename: 'spec.pdf',
        file_path: '/mock/spec.pdf',
        media_type: 'application/pdf',
        size_bytes: 10,
        created_at: new Date().toISOString(),
      }];
    });

    await seedBacklogEditItem(page, 'Has a saved attachment');
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(dialog.locator('[data-testid="attachment-chip"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('h3:has-text("Discard unsaved changes?")')).not.toBeVisible();

    // Restore the default (empty) mock for any later test in this describe.
    await page.evaluate(() => {
      window.electronAPI.backlogAttachments.list = async () => [];
    });
  });

  // Red-green for the delete-failure ordering fix: performDelete used to
  // persist "don't ask again" BEFORE calling onDelete, so a delete that
  // failed still armed the global skip-confirm bypass while the user was
  // staring straight at the error. It now persists only after onDelete
  // resolves; on rejection the catch path toasts an error, leaves both the
  // confirm and the edit dialog open, and does not touch skipDeleteConfirm.
  test('a rejected delete keeps the dialog open, toasts an error, and does not persist "don\'t ask again"', async () => {
    await openBacklogView(page);
    await createBacklogItem(page, 'Delete failure item');
    await expect(page.locator('text=Delete failure item')).toBeVisible();

    await page.evaluate(() => {
      const api = window as unknown as { __originalBacklogDelete?: typeof window.electronAPI.backlog.delete };
      api.__originalBacklogDelete = window.electronAPI.backlog.delete;
      window.electronAPI.backlog.delete = async () => {
        throw new Error('mock delete failure');
      };
    });

    await page.locator('[data-testid="edit-item-btn"]').click();
    const editDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(editDialog).toBeVisible();

    await editDialog.locator('[data-testid="delete-backlog-task-btn"]').click();
    const confirmHeading = page.locator('h3:has-text("Delete backlog task")');
    await expect(confirmHeading).toBeVisible();

    const dontAskAgainCheckbox = page.locator('label', { hasText: "Don't ask again" }).locator('input[type="checkbox"]');
    await dontAskAgainCheckbox.check();
    await page.locator('button:has-text("Delete")').last().click();

    // The delete failed: an error toast appears, and both the confirm and the
    // edit dialog stay open - performDelete's catch never calls
    // setConfirmDelete(false) or onClose().
    await expect(page.locator('[data-testid="toast"]')).toContainText('Failed to delete backlog task');
    await expect(confirmHeading).toBeVisible();
    await expect(editDialog).toBeVisible();

    // The global bypass must not have been persisted on a failed delete.
    const skipDeleteConfirm = await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config?: { getState: () => { config: { skipDeleteConfirm: boolean } } } };
      }).__zustandStores;
      return stores?.config?.getState().config.skipDeleteConfirm ?? null;
    });
    expect(skipDeleteConfirm).toBe(false);

    // The item was never removed.
    await expect(page.locator('text=Delete failure item')).toBeVisible();

    // Clean up: dismiss the confirm, close the (still clean) edit dialog,
    // restore the real backlog.delete mock, then remove the item through the
    // store so the describe's single-row invariant holds for later tests.
    // .last() picks the confirm's own Cancel button - the edit dialog's
    // footer Cancel button is still in the DOM underneath (same ambiguity as
    // the existing "Delete" button locator further down in this file).
    await page.locator('button:has-text("Cancel")').last().click();
    await expect(confirmHeading).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editDialog).not.toBeVisible();

    await page.evaluate(async () => {
      const api = window as unknown as { __originalBacklogDelete?: typeof window.electronAPI.backlog.delete };
      if (api.__originalBacklogDelete) window.electronAPI.backlog.delete = api.__originalBacklogDelete;
      const stores = (window as unknown as {
        __zustandStores?: {
          backlog?: {
            getState: () => {
              items: { id: string; title: string }[];
              deleteItem: (id: string) => Promise<void>;
            };
          };
        };
      }).__zustandStores;
      const target = stores?.backlog?.getState().items.find((item) => item.title === 'Delete failure item');
      if (target) await stores?.backlog?.getState().deleteItem(target.id);
    });
    await expect(page.locator('text=Delete failure item')).not.toBeVisible();
  });

  // "Don't ask again" on a SUCCESSFUL delete persists skipDeleteConfirm - the
  // failure test above only proves it stays false on rejection.
  test('checking "don\'t ask again" on a successful delete persists skipDeleteConfirm', async () => {
    await openBacklogView(page);
    await createBacklogItem(page, 'Delete with dont ask again');
    await expect(page.locator('text=Delete with dont ask again')).toBeVisible();

    await page.locator('[data-testid="edit-item-btn"]').click();
    const editDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(editDialog).toBeVisible();

    await editDialog.locator('[data-testid="delete-backlog-task-btn"]').click();
    const confirmHeading = page.locator('h3:has-text("Delete backlog task")');
    await expect(confirmHeading).toBeVisible();

    const dontAskAgainCheckbox = page.locator('label', { hasText: "Don't ask again" }).locator('input[type="checkbox"]');
    await dontAskAgainCheckbox.check();
    await page.locator('button:has-text("Delete")').last().click();

    await expect(editDialog).not.toBeVisible();
    await expect(page.locator('text=Delete with dont ask again')).not.toBeVisible();

    const skipDeleteConfirm = await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config?: { getState: () => { config: { skipDeleteConfirm: boolean } } } };
      }).__zustandStores;
      return stores?.config?.getState().config.skipDeleteConfirm ?? null;
    });
    expect(skipDeleteConfirm).toBe(true);

    // Restore for any later test in this describe.
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config?: { getState: () => { updateConfig: (partial: Record<string, unknown>) => Promise<void> } } };
      }).__zustandStores;
      void stores?.config?.getState().updateConfig({ skipDeleteConfirm: false });
    });
  });

  // Coverage gap: NameFromPromptButton sits beside the title input but only
  // renders once `description` is non-empty, and no existing test in this
  // file ever fills the description - so the whole wiring was unverified.
  test('Name from prompt button appears once the description is filled and updates the title', async () => {
    await openBacklogView(page);
    await openNewBacklogDialog(page);
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');

    await expect(dialog.locator('[data-testid="name-from-prompt-button"]')).toHaveCount(0);

    await dialog.locator('[data-testid="backlog-task-description"]').fill('rename a backlog item whose title is fix bug');
    const nameFromPromptButton = dialog.locator('[data-testid="name-from-prompt-button"]');
    await expect(nameFromPromptButton).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __mockAgentSummarize: (input: { prompt: string }) => unknown }).__mockAgentSummarize =
        (input) => ({ ok: true, title: `Suggested: ${(input as { prompt: string }).prompt.slice(0, 20)}` });
    });

    await nameFromPromptButton.click();
    await expect(dialog.locator('[data-testid="backlog-task-title"]')).toHaveValue(/^Suggested:/);

    // Restore the default summarize mock and discard the now-dirty form.
    await page.evaluate(() => {
      delete (window as unknown as { __mockAgentSummarize?: unknown }).__mockAgentSummarize;
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('h3:has-text("Discard unsaved changes?")')).toBeVisible();
    await page.locator('button:has-text("Discard")').click();
    await expect(dialog).not.toBeVisible();
  });

  test('header uses a plain external-link icon and "Open in <source>" title for a non-GitHub source', async () => {
    await seedBacklogEditItem(page, 'Jira item', {
      external_source: 'jira',
      external_url: 'https://example.atlassian.net/browse/ISSUE-1',
    });
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const link = dialog.locator('[data-testid="backlog-task-external-link"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('title', 'Open in jira');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // The GitHub case, for contrast - the title differs.
    await seedBacklogEditItem(page, 'GitHub title check item', {
      external_source: 'github_issues',
      external_url: 'https://github.com/kangentic/kangentic/issues/7',
    });
    const githubDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const githubLink = githubDialog.locator('[data-testid="backlog-task-external-link"]');
    await expect(githubLink).toHaveAttribute('title', 'Open in GitHub');
    await page.keyboard.press('Escape');
    await expect(githubDialog).not.toBeVisible();
  });

  // The header link guards on `external_source && external_url`. Only
  // both-null and both-set were covered, so a regression from `&&` to `||`
  // would still pass every existing test.
  test('header hides the source link when external_source is set but external_url is null', async () => {
    await seedBacklogEditItem(page, 'Source with no url item', {
      external_source: 'jira',
      external_url: null,
    });
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(dialog.locator('[data-testid="backlog-task-external-link"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  // Positive direction of the isDirty fix above: a PENDING attachment (one
  // the user just added, not loaded from disk) must still make the edit form
  // dirty, so Escape shows the discard confirm.
  test('adding a pending attachment in edit mode makes the form dirty and Escape shows the discard confirm', async () => {
    await seedBacklogEditItem(page, 'Has a pending attachment');
    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');

    // Simulate pasting an image into the description textarea - mirrors the
    // paste simulation in task-attachments.spec.ts.
    await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="backlog-task-description"]');
      if (!textarea) return;
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'pending.png', { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer });
      textarea.dispatchEvent(pasteEvent);
    });

    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toBeVisible();

    // panel.close defaults to Mod+Shift+W, not Escape (see
    // src/shared/keybindings.ts), so Escape here is handled solely by
    // BaseDialog's own document-level listener, which is re-registered by a
    // plain (post-paint) useEffect whenever handleCloseAttempt's identity
    // changes - which it just did, since isDirty flipped true in the same
    // commit that added this chip. The chip is visible the instant that
    // commit lands, but the listener swap has not necessarily run yet, so an
    // Escape thrown immediately can still hit the stale (isDirty=false)
    // closure and close the dialog with no confirm. Hovering the chip forces
    // Playwright's actionability "stable across frames" wait, which settles
    // on a real render/paint boundary rather than a fixed sleep, giving the
    // effect a chance to flush before Escape is sent.
    await chip.hover();

    await page.keyboard.press('Escape');
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible();

    await page.locator('button:has-text("Discard")').click();
    await expect(dialog).not.toBeVisible();
  });

  // Red-green for the confirmDelete/confirmDiscard early-return in
  // handleSubmit: the delete confirm uses variant="danger", which disables
  // ConfirmDialog's own Enter-to-confirm handler (see ConfirmDialog.tsx), so
  // nothing upstream prevents a stray Enter keypress from reaching the
  // form's native submit while the confirm sits on top. Without the guard,
  // a title input that still (or again) has focus would submit the edited
  // title over the pending delete and silently close everything out from
  // under the confirmation the user is looking at.
  test('Enter while the delete confirm is open does not submit the edit form over it', async () => {
    await openBacklogView(page);
    await createBacklogItem(page, 'Enter guard item');
    await expect(page.locator('text=Enter guard item')).toBeVisible();

    await page.locator('[data-testid="edit-item-btn"]').click();
    const editDialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    await expect(editDialog).toBeVisible();

    const titleInput = editDialog.locator('[data-testid="backlog-task-title"]');
    await titleInput.fill('Enter guard item CHANGED');

    await editDialog.locator('[data-testid="delete-backlog-task-btn"]').click();
    const confirmHeading = page.locator('h3:has-text("Delete backlog task")');
    await expect(confirmHeading).toBeVisible();

    // Re-focus the title input (trapFocus only intercepts Tab, not an
    // explicit .focus() call) to reproduce the exact scenario the guard
    // defends against, then press Enter.
    await titleInput.focus();
    await titleInput.press('Enter');

    // Nothing must have happened: a submit would call onUpdate, which
    // resolves and closes the whole dialog tree (including this confirm,
    // since it is a sibling unmounted along with the rest on onClose). Both
    // stay open and the title is untouched.
    await expect(confirmHeading).toBeVisible();
    await expect(editDialog).toBeVisible();
    await expect(titleInput).toHaveValue('Enter guard item CHANGED');

    // Clean up: cancel the confirm, then discard the still-dirty edit.
    await page.locator('button:has-text("Cancel")').last().click();
    await expect(confirmHeading).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('h3:has-text("Discard unsaved changes?")')).toBeVisible();
    await page.locator('button:has-text("Discard")').click();
    await expect(editDialog).not.toBeVisible();
    await expect(page.locator('text=Enter guard item CHANGED')).not.toBeVisible();
    await expect(page.locator('text=Enter guard item')).toBeVisible();
  });
});
