/**
 * UI test for the attachment "add" failure toast.
 *
 * useAttachments.ts's addFile used to catch a rejected attachments.add and only
 * console.error it - the attachment silently never appeared, with nothing on
 * screen to say why. Same bug class as the config-write guard this task
 * belongs to (src/main/db/repositories/attachment-repository.ts is marked
 * `// sync-write-ok:` precisely because the renderer is supposed to catch and
 * toast this rejection). This spec drives that failure path by overriding the
 * mock's attachments.add (the app.spec.ts:64 override idiom, also used by
 * attachment-open-failure.spec.ts) and asserts a warning toast names the file.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `Attachment Add Failure Test ${Date.now()}`;
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

/** Create a To Do task via the UI and click its card, which opens straight
 *  into edit mode for a no-session task (TaskCard.tsx: `initialEdit:
 *  displayState.kind === 'none'`), returning the open task-detail dialog. */
async function openTaskInEditMode(title: string) {
  await createTask(page, title);
  await page.locator(`text=${title}`).first().click();

  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  return dialog;
}

/** Paste a 1x1 PNG onto the description textarea, matching the New Task
 *  dialog's paste helper in task-attachments.spec.ts. A pasted file arrives
 *  with no usable name, so useAttachments.ts's handleAttachmentPaste assigns
 *  it `pasted-image-1.png` (the first paste onto a task with no existing
 *  attachments) rather than keeping whatever name the source File carried. */
async function pasteImage(testId: string) {
  await page.evaluate((selector) => {
    const textarea = document.querySelector(`[data-testid="${selector}"]`);
    if (!textarea) throw new Error(`textarea not found: ${selector}`);
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const file = new File([blob], 'clipboard-image.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, testId);
}

test.describe('Attachment remove failure', () => {
  test('a rejected attachments.remove surfaces the "Couldn\'t remove" warning toast, and the chip stays', async () => {
    // Add succeeds normally (attachments.add is untouched here), then remove is
    // overridden to reject - mirrors the add-failure test's override idiom, but
    // for useAttachments.ts's removeAttachment catch branch instead of addFile's.
    const dialog = await openTaskInEditMode('Attachment Remove Failure Task');
    await pasteImage('task-description');

    const chip = dialog.locator('[data-testid="attachment-chip"]');
    await expect(chip).toHaveCount(1, { timeout: 5000 });

    await page.evaluate(() => {
      window.electronAPI.attachments.remove = async () => { throw new Error('EBADF: bad file descriptor, unlink'); };
    });

    await dialog.locator('[data-testid="attachment-remove"]').click();

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: "Couldn't remove the attachment" });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText('bad file descriptor');

    // The rejected remove must not drop the chip.
    await expect(chip).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});

test.describe('Attachment add failure', () => {
  test('a rejected attachments.add surfaces a warning toast naming the file, and adds no chip', async () => {
    await page.evaluate(() => {
      window.electronAPI.attachments.add = async () => { throw new Error('EBADF: bad file descriptor, write'); };
    });

    const dialog = await openTaskInEditMode('Attachment Add Failure Task');
    await pasteImage('task-description');

    const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'pasted-image-1.png' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText("Couldn't add");
    await expect(toast).toContainText('bad file descriptor');

    // The rejected add must not leave a phantom chip behind.
    await expect(dialog.locator('[data-testid="attachment-chip"]')).toHaveCount(0);

    // Form is dirty (title set by createTask, no other edits) - Cancel closes
    // directly since nothing here was changed beyond the seeded title.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});
