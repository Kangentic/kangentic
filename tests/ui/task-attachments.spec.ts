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

/**
 * Wait for all dialog backdrops (fixed inset-0 overlays) to fully unmount.
 * BaseDialog animates close over 150ms and only unmounts on `animationend`.
 * Without this wait, a backdrop from the prior test intercepts clicks on "Add
 * task" in the next test, causing deterministic timeouts in a shared-page suite.
 */
async function waitForNoBackdrop(): Promise<void> {
  await expect(page.locator('.fixed.inset-0')).toHaveCount(0, { timeout: 2000 });
}

/** Open the New Task dialog in the To Do column */
async function openNewTaskDialog() {
  // Ensure any dialog/backdrop from a prior test is fully gone before clicking.
  await waitForNoBackdrop();
  const column = page.locator('[data-swimlane-name="To Do"]');
  const addButton = column.locator('text=Add task');
  await addButton.click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

test.describe('New Task Dialog Layout', () => {
  test('dialog renders at wider width (840px)', async () => {
    await openNewTaskDialog();
    const dialog = page.locator('.w-\\[840px\\]');
    await expect(dialog).toBeVisible();
    // Form is clean - Escape closes directly (no ConfirmDialog) and animates out.
    await page.keyboard.press('Escape');
  });

  test('textarea container has a minimum height floor', async () => {
    await openNewTaskDialog();
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();
    // The editor body grows to fill a maximized dialog (flex-1) but keeps a
    // 280px floor when the dialog is windowed.
    const container = page.locator('.min-h-\\[280px\\]');
    await expect(container).toBeVisible();
    // Form is clean - Escape closes directly (no ConfirmDialog) and animates out.
    await page.keyboard.press('Escape');
  });

  test('shows visual placeholder with image drop hint', async () => {
    await openNewTaskDialog();
    await expect(page.locator('text=Describe the task for the agent...')).toBeVisible();
    await expect(page.locator('text=Paste or drop files here')).toBeVisible();
    // Placeholder disappears when user types
    const textarea = page.locator('textarea');
    await textarea.fill('hello');
    await expect(page.locator('text=Paste or drop files here')).not.toBeVisible();
    // Form is dirty (text typed) - Cancel shows "Discard unsaved changes?" confirm.
    // Dismiss via Discard so the dialog fully closes before the next test opens it.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
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
    await expect(page.locator('text=1 attachment')).toBeVisible();
    // Form is dirty (image attached) - Cancel shows "Discard unsaved changes?" confirm.
    // Dismiss via Discard so the dialog fully closes before the next describe block.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
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

    // Form is dirty (image attached) - Cancel shows "Discard unsaved changes?" confirm.
    // Dismiss via Discard so the dialog fully closes before the next test opens it.
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('button:has-text("Discard")').click();
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

    // After deleting the only attachment the form is clean (no title/description/
    // attachments) - Cancel closes directly without a ConfirmDialog.
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

    // Submit the form (type="submit" distinguishes from dev-only TestHarness buttons)
    const createButton = page.locator('button[type="submit"]:has-text("Create")');
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
    const dropOverlay = page.locator('text="Drop files here"');
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

    // Form is clean - Escape closes directly (no ConfirmDialog) and animates out.
    await page.keyboard.press('Escape');
  });
});

test.describe('Escape Key Protection', () => {
  test('escape on a dirty form prompts to discard; Keep editing stays, Discard closes', async () => {
    await openNewTaskDialog();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Some task title');

    // Escape on a dirty form shows a discard confirmation instead of closing.
    await page.keyboard.press('Escape');
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible();

    // "Keep editing" dismisses the confirm and leaves the form open.
    await page.locator('button:has-text("Keep editing")').click();
    await expect(confirmHeading).not.toBeVisible();
    await expect(titleInput).toBeVisible();

    // Escape again, then "Discard" closes the whole dialog.
    await page.keyboard.press('Escape');
    await expect(confirmHeading).toBeVisible();
    await page.locator('button:has-text("Discard")').click();
    await expect(titleInput).not.toBeVisible();
  });

  test('discard confirm traps focus: Tab stays within the confirm, not the background form', async () => {
    await openNewTaskDialog();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Focus trap task');

    await page.keyboard.press('Escape');
    await expect(page.locator('h3:has-text("Discard unsaved changes?")')).toBeVisible();

    // Reads whether focus is inside the confirm dialog and not on the background
    // title input. The confirm content is the nearest shadow-2xl ancestor of its
    // heading.
    const focusState = () => page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h3'))
        .find((h) => h.textContent?.includes('Discard unsaved changes?'));
      const container = heading?.closest('.shadow-2xl') ?? null;
      const active = document.activeElement;
      const onBackgroundTitle = active instanceof HTMLInputElement && active.placeholder === 'Task title';
      return { inConfirm: !!container && container.contains(active), onBackgroundTitle };
    });

    // Focus moved into the confirm on open.
    await expect.poll(async () => (await focusState()).inConfirm).toBe(true);

    // Tabbing repeatedly never escapes to the background form.
    for (let pressCount = 0; pressCount < 4; pressCount++) {
      await page.keyboard.press('Tab');
      const state = await focusState();
      expect(state.inConfirm).toBe(true);
      expect(state.onBackgroundTitle).toBe(false);
    }

    await page.locator('button:has-text("Discard")').click();
    await expect(titleInput).not.toBeVisible();
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

  test('backdrop click on dirty form routes through onCloseRequest and shows discard confirm (not close)', async () => {
    // BaseDialog.onCloseRequest precedence: backdrop click on a dirty dialog
    // must route through the consumer's guard, showing the discard confirm
    // instead of closing. This proves the backdrop path of onCloseRequest.
    await openNewTaskDialog();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Backdrop test task');

    // The dialog content box is the shadow-2xl ancestor of the title input.
    // Click outside the content box but inside the backdrop overlay to trigger
    // the backdrop handler.
    const contentBox = await titleInput.evaluate((el) => {
      const container = el.closest('.shadow-2xl');
      return container?.getBoundingClientRect() ?? null;
    });
    if (!contentBox) throw new Error('Content box not found');

    // Click well outside the content box (20px from the left edge of the viewport).
    await page.mouse.click(20, contentBox.top + contentBox.height / 2);

    // The discard confirm must appear because the form is dirty.
    const confirmHeading = page.locator('h3:has-text("Discard unsaved changes?")');
    await expect(confirmHeading).toBeVisible();

    // The backdrop click must NOT have closed the dialog.
    await expect(titleInput).toBeVisible();

    // Discard cleans up.
    await page.locator('button:has-text("Discard")').click();
    await expect(titleInput).not.toBeVisible();
  });

  test('backdrop click on a clean form closes it (no confirm shown)', async () => {
    // When the form is clean, onCloseRequest returns true, so the backdrop click
    // proceeds to close the dialog without a confirm.
    await openNewTaskDialog();
    const titleInput = page.locator('input[placeholder="Task title"]');

    // Form is clean - click the backdrop.
    const contentBox = await titleInput.evaluate((el) => {
      const container = el.closest('.shadow-2xl');
      return container?.getBoundingClientRect() ?? null;
    });
    if (!contentBox) throw new Error('Content box not found');

    await page.mouse.click(20, contentBox.top + contentBox.height / 2);

    // Dialog must close without a confirm.
    await expect(titleInput).not.toBeVisible();
    await expect(page.locator('h3:has-text("Discard unsaved changes?")')).not.toBeVisible();
  });
});

test.describe('Focus Trap - Shift+Tab Wrap', () => {
  test('Shift+Tab from the first focusable in the confirm wraps to the last; never reaches the background form', async () => {
    await openNewTaskDialog();
    const titleInput = page.locator('input[placeholder="Task title"]');
    await titleInput.fill('Shift-Tab focus wrap task');

    await page.keyboard.press('Escape');
    await expect(page.locator('h3:has-text("Discard unsaved changes?")')).toBeVisible();

    // Helper that probes whether focus is inside the confirm dialog and whether
    // it has escaped to the background title input.
    const focusState = () => page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h3'))
        .find((h) => h.textContent?.includes('Discard unsaved changes?'));
      const container = heading?.closest('.shadow-2xl') ?? null;
      const active = document.activeElement;
      const onBackgroundTitle =
        active instanceof HTMLInputElement && active.placeholder === 'Task title';
      return {
        inConfirm: !!container && container.contains(active),
        onBackgroundTitle,
        activeTagName: active?.tagName ?? null,
      };
    });

    // Focus should be inside the confirm on open.
    await expect.poll(async () => (await focusState()).inConfirm).toBe(true);

    // Tab forward once to move to a known position (e.g. the last button if
    // focus was on the first). Then Shift+Tab to probe the backward wrap.
    await page.keyboard.press('Tab');
    let state = await focusState();
    expect(state.inConfirm).toBe(true);
    expect(state.onBackgroundTitle).toBe(false);

    // Shift+Tab repeatedly - focus must stay in the confirm and never escape.
    for (let pressCount = 0; pressCount < 4; pressCount++) {
      await page.keyboard.press('Shift+Tab');
      state = await focusState();
      expect(state.inConfirm).toBe(true, `Shift+Tab press ${pressCount + 1} escaped the confirm`);
      expect(state.onBackgroundTitle).toBe(false, `Shift+Tab press ${pressCount + 1} landed on the background title input`);
    }

    // Confirm the "Discard" button by clicking to clean up.
    await page.locator('button:has-text("Discard")').click();
    await expect(titleInput).not.toBeVisible();
  });
});
