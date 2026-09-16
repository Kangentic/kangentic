/**
 * UI coverage for the `config:writeFailed` push (DESKTOP-14/DESKTOP-13).
 *
 * A failed synchronous config write (data directory unwritable) used to throw
 * out of ConfigManager.save(): from a timer (uncaught exception, DESKTOP-14) or
 * from the config:set IPC handler (unhandled rejection the renderer never
 * caught, DESKTOP-13). It now degrades and reports through the source-keyed
 * latch in write-failure-notice.ts, which pushes this channel once per failing
 * source. This spec covers the push half - main composes the message and the
 * renderer toasts it verbatim, the same shape as task:spawnBlocked.
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const WRITE_FAILED_MESSAGE =
  "Kangentic could not write to its data folder. Changes apply to this session but will not persist.";

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

function fireConfigWriteFailed(page: Page, message: string) {
  return page.evaluate((text) => {
    (window as unknown as {
      __mockFireConfigWriteFailed: (message: string) => void;
    }).__mockFireConfigWriteFailed(text);
  }, message);
}

test.describe('config:writeFailed push', () => {
  test('toasts the message verbatim as an error-variant toast', async () => {
    const { browser, page } = await launch();
    try {
      await fireConfigWriteFailed(page, WRITE_FAILED_MESSAGE);

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'could not write to its data folder' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      // ToastItem.tsx keys its border/accent classes off toast.variant; App.tsx
      // pushes this one with variant: 'error', which renders as
      // border-red-500/50 (see variantStyles in ToastItem.tsx). There is no
      // data-variant attribute, so the class is the only observable marker.
      await expect(toast).toHaveClass(/border-red-500/);
    } finally {
      await browser.close();
    }
  });

  test('still appears when a project is open (the push is not project-filtered)', async () => {
    const { browser, page } = await launch();
    try {
      await createProject(page, `config-write-failed-project-${Date.now()}`);

      await fireConfigWriteFailed(page, WRITE_FAILED_MESSAGE);

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'could not write to its data folder' });
      await expect(toast).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a second push renders as its own toast (the latch policy lives in main, not the renderer)', async () => {
    const { browser, page } = await launch();
    try {
      // The renderer has no cooldown of its own - it toasts whatever main
      // sends. write-failure-notice.ts's per-source latch is what keeps main
      // from re-sending on every failure of an already-failing source; this
      // spec only proves the renderer does not ALSO suppress on its side.
      await fireConfigWriteFailed(page, WRITE_FAILED_MESSAGE);
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(1, { timeout: 5000 });

      await fireConfigWriteFailed(page, WRITE_FAILED_MESSAGE);
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(2, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
