/**
 * Regression tests for clipboard-image compression. Asserts that:
 *   1. A large pasted PNG is shrunk to WebP under the Anthropic-budget target.
 *   2. A small pasted PNG (under MIN_COMPRESS_BYTES) passes through untouched.
 *
 * The mock IPC at tests/ui/mock-electron-api.js records the base64 character
 * length under `size_bytes`. Raw bytes ~= size_bytes * 0.75 (base64 expansion).
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `Image Compression ${Date.now()}`;
const TARGET_BASE64_BYTES = 2 * 1024 * 1024; // 2MB base64 ~= 1.5MB raw budget

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

async function openNewTaskDialog(): Promise<void> {
  const column = page.locator('[data-swimlane-name="To Do"]');
  await column.locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

interface AttachmentRecord {
  filename: string;
  media_type: string;
  size_bytes: number;
}

interface MockElectronApiSurface {
  tasks: { list: () => Promise<Array<{ id: string; title: string }>> };
  attachments: { list: (taskId: string) => Promise<AttachmentRecord[]> };
}

async function findAttachmentsByTaskTitle(taskTitle: string): Promise<AttachmentRecord[]> {
  return page.evaluate(async (title) => {
    const electronAPI = (window as unknown as { electronAPI: MockElectronApiSurface }).electronAPI;
    const tasks = await electronAPI.tasks.list();
    const task = tasks.find((t) => t.title === title);
    if (!task) return [];
    return electronAPI.attachments.list(task.id);
  }, taskTitle);
}

test.describe('Clipboard image compression', () => {
  test('large noise PNG paste compresses to WebP under budget', async () => {
    await openNewTaskDialog();

    const taskTitle = `Big screenshot ${Date.now()}`;
    await page.locator('input[placeholder="Task title"]').fill(taskTitle);

    // Build a 3000x2000 random-noise PNG (worst case for compression) and
    // dispatch a paste event at the description textarea.
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(3000, 2000);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const data = ctx.createImageData(3000, 2000);
      for (let index = 0; index < data.data.length; index += 4) {
        data.data[index + 0] = Math.floor(Math.random() * 256);
        data.data[index + 1] = Math.floor(Math.random() * 256);
        data.data[index + 2] = Math.floor(Math.random() * 256);
        data.data[index + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const file = new File([blob], 'big.png', { type: 'image/png' });

      const textarea = document.querySelector('textarea');
      if (!textarea) throw new Error('textarea not found');
      const dt = new DataTransfer();
      dt.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }));
    });

    // Wait for the compressed thumbnail to appear in the dialog.
    await expect(page.locator('[data-testid="attachment-chip"]')).toHaveCount(1, { timeout: 5000 });

    // Submit, then read the recorded attachment via the mock IPC.
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await expect(page.locator('input[placeholder="Task title"]')).not.toBeVisible();

    const attachments = await findAttachmentsByTaskTitle(taskTitle);
    expect(attachments).toHaveLength(1);
    const [attachment] = attachments;
    expect(attachment.media_type).toBe('image/webp');
    expect(attachment.filename).toBe('pasted-image-1.webp');
    expect(attachment.size_bytes).toBeGreaterThan(1000);
    expect(attachment.size_bytes).toBeLessThan(TARGET_BASE64_BYTES);
  });

  test('small PNG paste is left untouched', async () => {
    await openNewTaskDialog();

    const taskTitle = `Small icon ${Date.now()}`;
    await page.locator('input[placeholder="Task title"]').fill(taskTitle);

    await page.evaluate(() => {
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: 'image/png' });
      const file = new File([blob], 'tiny.png', { type: 'image/png' });

      const textarea = document.querySelector('textarea');
      if (!textarea) throw new Error('textarea not found');
      const dt = new DataTransfer();
      dt.items.add(file);
      textarea.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }));
    });

    await expect(page.locator('[data-testid="attachment-chip"]')).toHaveCount(1, { timeout: 5000 });

    await page.locator('button[type="submit"]:has-text("Create")').click();
    await expect(page.locator('input[placeholder="Task title"]')).not.toBeVisible();

    const attachments = await findAttachmentsByTaskTitle(taskTitle);
    expect(attachments).toHaveLength(1);
    const [attachment] = attachments;
    expect(attachment.media_type).toBe('image/png');
    expect(attachment.filename).toBe('pasted-image-1.png');
  });
});
