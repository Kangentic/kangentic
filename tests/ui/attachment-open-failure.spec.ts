/**
 * UI test for the attachment "Open" failure toast.
 *
 * ATTACHMENT_OPEN (src/main/ipc/handlers/board.ts) returns a resolved error
 * string when shell.openPath can't open the file - it never rejects. Before
 * this change, useAttachments.ts's handleOpenExternal fired the invoke and
 * discarded the result, so a failed open produced no feedback at all. This
 * spec drives that failure path by overriding the mock's attachments.open
 * to resolve a non-empty error string (the app.spec.ts:64 override idiom)
 * and asserts a warning toast names the file.
 *
 * The second describe block below covers the same failure contract for the
 * backlog dialog's own IPC namespace (NewBacklogTaskDialog.tsx's
 * handleOpenAttachment -> backlogAttachments.open), which shares the
 * openAttachmentWithToast helper but is a separate call site with its own
 * image-preview short-circuit that never touches IPC at all.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject, createTask, waitForBoard } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `Attachment Open Failure Test ${Date.now()}`;
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

/** Create a task via the UI and seed one saved, non-image attachment on it
 *  directly through the attachments IPC, returning the new task's id. */
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
        media_type: 'application/octet-stream',
      });
    },
    { id: taskId, name: filename },
  );

  return taskId;
}

async function openTaskDetailInViewMode(taskId: string): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { setDetailTaskId: (taskId: string | null) => void } } };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setDetailTaskId(id);
  }, taskId);
}

test.describe('Attachment open failure', () => {
  test('a non-empty error string from attachments.open surfaces a warning toast naming the file', async () => {
    await page.evaluate(() => {
      window.electronAPI.attachments.open = async () => 'No application is registered for this file type';
    });

    const taskId = await createTaskWithAttachment('Open Failure Task', 'archive.bin');
    await openTaskDetailInViewMode(taskId);

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toBeVisible({ timeout: 5000 });
    await chip.locator('[data-testid="attachment-open"]').click();

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'archive.bin' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText("Couldn't open");
    await expect(toast).toContainText('No application is registered for this file type');

    await dialog.locator('[data-testid="task-detail-close"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });

  test('a thrown error from attachments.open surfaces a warning toast with no reveal-fallback claim', async () => {
    await page.evaluate(() => {
      window.electronAPI.attachments.open = async () => { throw new Error('Attachment not found'); };
    });

    const taskId = await createTaskWithAttachment('Open Throw Task', 'notes.bin');
    await openTaskDetailInViewMode(taskId);

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toBeVisible({ timeout: 5000 });
    await chip.locator('[data-testid="attachment-open"]').click();

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'notes.bin' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText('Attachment not found');
    await expect(toast).not.toContainText('file manager');

    await dialog.locator('[data-testid="task-detail-close"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});

/**
 * Open NewBacklogTaskDialog in edit mode against a synthetic backlog task,
 * bypassing the row-click UI entirely. The dialog's saved-attachment list
 * comes from `window.electronAPI.backlogAttachments.list`, which the caller
 * overrides before calling this helper, so the object's id only needs to be
 * unique enough to identify the dialog instance - the mock ignores it.
 *
 * BacklogDialogs only mounts alongside BacklogView (AppLayout.tsx), which
 * itself only renders while the board's activeView is 'backlog', so a real
 * board (not backlog) view switch is a required setup step before driving
 * the store - setting editingItem while the board view is active sets state
 * nothing is rendering.
 */
async function openBacklogEditDialog(taskTitle: string): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="backlog-view"]').waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((title) => {
    const stores = (window as unknown as {
      __zustandStores?: { backlog?: { getState: () => { setEditingItem: (task: unknown) => void } } };
    }).__zustandStores;
    if (!stores?.backlog) throw new Error('backlog store not exposed on __zustandStores');
    stores.backlog.getState().setEditingItem({
      id: `backlog-attachment-open-${Date.now()}`,
      title,
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
      attachment_count: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }, taskTitle);

  const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close NewBacklogTaskDialog by driving the backlog store's editingItem
 * slot directly (the same function BaseDialog's own X button calls), rather
 * than clicking a close gesture. A saved attachment makes the edit form
 * report dirty (NewBacklogTaskDialog.tsx's isDirty includes
 * `attachments.length > 0` in edit mode), which would otherwise route any
 * close gesture through the discard-changes ConfirmDialog.
 *
 * Also switches back to the board view, so a later test in this shared-page
 * file (e.g. the task-detail describe above, which needs the "To Do" swimlane
 * visible to create a task) never inherits the backlog view left active here.
 */
async function closeBacklogEditDialog(): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { backlog?: { getState: () => { setEditingItem: (task: unknown) => void } } };
    }).__zustandStores;
    stores?.backlog?.getState().setEditingItem(null);
  });
  const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
  await expect(dialog).not.toBeVisible({ timeout: 5000 });

  await page.locator('[data-testid="view-toggle-board"]').click();
  await waitForBoard(page);
}

test.describe('Backlog attachment open failure', () => {
  test('a non-empty error string from backlogAttachments.open surfaces a warning toast naming the file', async () => {
    await page.evaluate(() => {
      window.electronAPI.backlogAttachments.list = async () => [{
        id: 'ba-open-error',
        backlog_task_id: 'unused',
        filename: 'design-spec.bin',
        file_path: '/mock/design-spec.bin',
        media_type: 'application/octet-stream',
        size_bytes: 10,
        created_at: new Date().toISOString(),
      }];
      window.electronAPI.backlogAttachments.open = async () => 'No application is registered for this file type';
    });

    await openBacklogEditDialog('Backlog Open Failure Task');

    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toBeVisible({ timeout: 5000 });
    await chip.locator('[data-testid="attachment-open"]').click();

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'design-spec.bin' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText("Couldn't open");
    await expect(toast).toContainText('No application is registered for this file type');
    await expect(toast).toContainText('Showing it in the file manager instead.');

    await closeBacklogEditDialog();
  });

  test('a thrown error from backlogAttachments.open surfaces a warning toast with no reveal-fallback claim', async () => {
    await page.evaluate(() => {
      window.electronAPI.backlogAttachments.list = async () => [{
        id: 'ba-open-throw',
        backlog_task_id: 'unused',
        filename: 'notes-backlog.bin',
        file_path: '/mock/notes-backlog.bin',
        media_type: 'application/octet-stream',
        size_bytes: 10,
        created_at: new Date().toISOString(),
      }];
      window.electronAPI.backlogAttachments.open = async () => { throw new Error('Attachment not found'); };
    });

    await openBacklogEditDialog('Backlog Open Throw Task');

    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toBeVisible({ timeout: 5000 });
    await chip.locator('[data-testid="attachment-open"]').click();

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'notes-backlog.bin' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText('Attachment not found');
    await expect(toast).not.toContainText('file manager');

    await closeBacklogEditDialog();
  });

  test('clicking an image attachment chip opens the preview and never calls backlogAttachments.open', async () => {
    await page.evaluate(() => {
      (window as unknown as { __backlogAttachmentOpenCalls: number }).__backlogAttachmentOpenCalls = 0;
      window.electronAPI.backlogAttachments.list = async () => [{
        id: 'ba-image-preview',
        backlog_task_id: 'unused',
        filename: 'diagram-preview.png',
        file_path: '/mock/diagram-preview.png',
        media_type: 'image/png',
        size_bytes: 10,
        created_at: new Date().toISOString(),
      }];
      window.electronAPI.backlogAttachments.open = async () => {
        (window as unknown as { __backlogAttachmentOpenCalls: number }).__backlogAttachmentOpenCalls += 1;
        return '';
      };
    });

    await openBacklogEditDialog('Backlog Image Preview Task');

    const dialog = page.locator('[data-testid="new-backlog-task-dialog"]');
    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toBeVisible({ timeout: 5000 });
    await chip.locator('[data-testid="attachment-open"]').click();

    // The preview overlay renders as a sibling of the dialog content, not a
    // descendant of the testid'd dialog node, so it is located from the page.
    const previewOverlay = page.locator('[data-testid="attachment-preview-overlay"]');
    await expect(previewOverlay).toBeVisible({ timeout: 5000 });
    await expect(previewOverlay).toContainText('diagram-preview.png');

    const openCalls = await page.evaluate(
      () => (window as unknown as { __backlogAttachmentOpenCalls: number }).__backlogAttachmentOpenCalls,
    );
    expect(openCalls).toBe(0);

    await closeBacklogEditDialog();
  });
});
