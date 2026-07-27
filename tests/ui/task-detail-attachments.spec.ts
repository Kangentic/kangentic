/**
 * UI tests for attachment chips inside the task-detail dialog.
 *
 * TaskDetailBody renders the shared <AttachmentChipStrip> read-only (no
 * `onRemove`, so no remove control) for the view-mode body; TaskDetailEditForm
 * renders the same component with `onRemove={attachments.removeAttachment}`
 * for the edit form. Neither wiring had UI coverage before this file - see
 * AttachmentChipStrip.tsx, TaskDetailBody.tsx, and TaskDetailEditForm.tsx.
 * Attachment creation via paste/drop is already covered by
 * task-attachments.spec.ts; this file is only about the view/edit chip
 * rendering and the remove-control wiring, so attachments here are seeded
 * directly through the attachments IPC.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `Task Detail Attachments Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Create a task via the UI and seed one saved attachment on it directly
 *  through the attachments IPC, returning the new task's id. */
async function createTaskWithAttachment(title: string, filename: string): Promise<string> {
  await createTask(page, title);

  const taskId = await page.evaluate(async (taskTitle) => {
    const tasks = await window.electronAPI.tasks.list();
    const task = tasks.find((candidate) => candidate.title === taskTitle);
    if (!task) throw new Error(`Task "${taskTitle}" not found`);
    return task.id;
  }, title);

  await page.evaluate(
    async ({ id, name }) => {
      await window.electronAPI.attachments.add({
        task_id: id,
        filename: name,
        data: 'aGVsbG8=',
        media_type: 'text/plain',
      });
    },
    { id: taskId, name: filename },
  );

  return taskId;
}

/** Open the task-detail dialog directly in VIEW mode (initialEdit: false),
 *  bypassing TaskCard's onClick - which opens a session-less task in EDIT
 *  mode by default (see task-detail-description-peek.spec.ts's
 *  "description-only view" test for the same pattern). */
async function openTaskDetailInViewMode(taskId: string): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { setDetailTaskId: (taskId: string | null) => void } } };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setDetailTaskId(id);
  }, taskId);
}

test.describe('Task detail attachment chips', () => {
  test('view mode renders an attachment chip with no remove control', async () => {
    const taskId = await createTaskWithAttachment('View Attachment Task', 'notes.txt');
    await openTaskDetailInViewMode(taskId);

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toBeVisible({ timeout: 5000 });
    await expect(chip).toContainText('notes.txt');
    await expect(chip.locator('[data-testid="attachment-remove"]')).toHaveCount(0);

    await dialog.locator('[data-testid="task-detail-close"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });

  test('entering edit mode surfaces a remove control, and clicking it removes the chip', async () => {
    const taskId = await createTaskWithAttachment('Edit Attachment Task', 'plan.txt');
    await openTaskDetailInViewMode(taskId);

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await expect(dialog.locator('[data-testid="attachment-chip"]')).toBeVisible({ timeout: 5000 });

    // Enter edit mode via the kebab menu's "Edit" item (TaskDetailHeader).
    await dialog.locator('[title="Actions"]').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    const editChip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(editChip).toBeVisible({ timeout: 5000 });
    const removeButton = editChip.locator('[data-testid="attachment-remove"]');
    await expect(removeButton).toBeVisible();

    await removeButton.click();
    await expect(dialog.locator('[data-testid="attachment-chip"]')).toHaveCount(0);

    // Attachment removal is its own immediate IPC call, not staged with the
    // rest of the edit form's fields, so Cancel here is safe - it only
    // reverts title/description/labels/priority/etc, none of which were
    // touched. Cancel returns to view mode rather than closing (this window
    // was opened with initialEdit: false at the window level).
    await page.locator('button:has-text("Cancel")').click();
    await dialog.locator('[data-testid="task-detail-close"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});
