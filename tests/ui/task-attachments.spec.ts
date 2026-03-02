import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `Attachment Test ${Date.now()}`;
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

/** Open the New Task dialog in the Backlog column */
async function openNewTaskDialog() {
  const column = page.locator('[data-swimlane-name="Backlog"]');
  const addButton = column.locator('text=+ Add task');
  await addButton.click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

test.describe('New Task Dialog Layout', () => {
  test('dialog renders at wider width (640px)', async () => {
    await openNewTaskDialog();
    const dialog = page.locator('.w-\\[640px\\]');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('textarea is resizable and has larger min height', async () => {
    await openNewTaskDialog();
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();
    // Check it has the resize-y class (min-h-[160px])
    const classes = await textarea.getAttribute('class');
    expect(classes).toContain('resize-y');
    expect(classes).toContain('min-h-');
    await page.keyboard.press('Escape');
  });

  test('shows visual placeholder with image drop hint', async () => {
    await openNewTaskDialog();
    await expect(page.locator('text=Describe the task for the agent...')).toBeVisible();
    await expect(page.locator('text=Paste or drop images here')).toBeVisible();
    // Placeholder disappears when user types
    const textarea = page.locator('textarea');
    await textarea.fill('hello');
    await expect(page.locator('text=Paste or drop images here')).not.toBeVisible();
    // Form is dirty (title filled) — Escape is blocked, use Cancel button
    await page.locator('button:has-text("Cancel")').click();
  });

  test('shows image count next to thumbnails', async () => {
    await openNewTaskDialog();

    // Paste an image to trigger the count label
    await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return;
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'test.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    });

    await page.waitForTimeout(500);
    await expect(page.locator('text=1 image')).toBeVisible();
    // Form is dirty (image attached) — Escape is blocked, use Cancel button
    await page.locator('button:has-text("Cancel")').click();
  });
});

test.describe('Image Attachments', () => {
  test('paste image adds thumbnail', async () => {
    await openNewTaskDialog();

    // Simulate pasting an image by dispatching a paste event with a data transfer
    // containing an image blob
    await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return;

      // Create a 1x1 red PNG as a Blob
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'test.png', { type: 'image/png' });

      const dt = new DataTransfer();
      dt.items.add(file);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      textarea.dispatchEvent(pasteEvent);
    });

    // Wait for the thumbnail to appear
    await page.waitForTimeout(500);
    const thumbnails = page.locator('[data-testid="attachment-thumbnails"]');
    await expect(thumbnails).toBeVisible();
    const images = thumbnails.locator('img');
    expect(await images.count()).toBeGreaterThanOrEqual(1);

    // Form is dirty (image attached) — Escape is blocked, use Cancel button
    await page.locator('button:has-text("Cancel")').click();
  });

  test('delete thumbnail removes it', async () => {
    await openNewTaskDialog();

    // Paste an image first
    await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return;

      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'test.png', { type: 'image/png' });

      const dt = new DataTransfer();
      dt.items.add(file);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      textarea.dispatchEvent(pasteEvent);
    });

    await page.waitForTimeout(500);
    const thumbnails = page.locator('[data-testid="attachment-thumbnails"]');
    await expect(thumbnails).toBeVisible();

    // Hover over the thumbnail and click the X button
    const thumb = thumbnails.locator('.group').first();
    await thumb.hover();
    const deleteBtn = thumb.locator('button');
    await deleteBtn.click();

    // Thumbnails container should disappear (no attachments)
    await expect(thumbnails).not.toBeVisible();

    // After deleting the only attachment the form is clean — but use Cancel for safety
    await page.locator('button:has-text("Cancel")').click();
  });

  test('create task with attachments passes pendingAttachments', async () => {
    await openNewTaskDialog();

    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Task with image');

    // Paste an image
    await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return;

      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'test.png', { type: 'image/png' });

      const dt = new DataTransfer();
      dt.items.add(file);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      textarea.dispatchEvent(pasteEvent);
    });

    await page.waitForTimeout(500);

    // Submit the form
    const createButton = page.locator('button:has-text("Create")');
    await createButton.click();
    await page.waitForTimeout(300);

    // Verify the task was created
    const taskCard = page.locator('[data-testid="swimlane"]').locator('text=Task with image').first();
    await expect(taskCard).toBeVisible();
  });

  test('drop zone highlights on drag over', async () => {
    await openNewTaskDialog();

    // Simulate dragover on the form container
    await page.evaluate(() => {
      const container = document.querySelector('.space-y-3.relative');
      if (!container) return;
      const dragEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      });
      container.dispatchEvent(dragEvent);
    });

    // The drop overlay should appear (exact match to avoid hitting the placeholder)
    const dropOverlay = page.locator('text="Drop images here"');
    await expect(dropOverlay).toBeVisible();

    // Simulate dragleave
    await page.evaluate(() => {
      const container = document.querySelector('.space-y-3.relative');
      if (!container) return;
      const leaveEvent = new DragEvent('dragleave', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      });
      container.dispatchEvent(leaveEvent);
    });

    await expect(dropOverlay).not.toBeVisible();

    await page.keyboard.press('Escape');
  });
});

test.describe('Escape Key Protection', () => {
  test('escape does not close dialog when form is dirty', async () => {
    await openNewTaskDialog();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Some task title');

    // Escape should NOT close the dialog because the form is dirty
    await page.keyboard.press('Escape');
    await expect(titleInput).toBeVisible();

    // Clean up via Cancel button
    await page.locator('button:has-text("Cancel")').click();
  });

  test('escape closes dialog when form is clean', async () => {
    await openNewTaskDialog();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await expect(titleInput).toBeVisible();

    // Escape should close the dialog because the form is clean
    await page.keyboard.press('Escape');
    await expect(titleInput).not.toBeVisible();
  });

  test('escape closes dialog when description is whitespace-only', async () => {
    await openNewTaskDialog();
    const textarea = page.locator('textarea');
    await textarea.fill('   ');

    // Whitespace-only description is not dirty (isDirty uses trim())
    await page.keyboard.press('Escape');
    await expect(textarea).not.toBeVisible();
  });
});
