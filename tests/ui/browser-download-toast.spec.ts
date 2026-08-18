/**
 * UI test for the Browser-pane download toast (useBrowserDownloadToast.ts).
 *
 * A pane's `<webview>` saves a triggered download straight to the OS Downloads
 * folder (the Chrome behavior, and the only thing that makes downloads work
 * at all for the human using the pane). Silently is the wrong default here:
 * an agent driving the pane can trigger a download the user never asked for,
 * so main pushes BROWSER_DOWNLOAD_DONE and this hook toasts it - a success
 * toast with a "Show in folder" action for a completed download, and a plain
 * warning naming the file for anything that didn't finish.
 *
 * The hook is mounted unconditionally in WindowLayer's BoardBridges (see
 * AppLayout.tsx: `<WindowLayer />` sits outside the `currentProject ?` branch),
 * so no project needs to be open for it to fire - this spec drives it straight
 * off a bare app boot via window.__mockBrowser.emitDownloadDone(), which
 * mock-electron-api.js exposes but nothing exercised before this file.
 *
 * See docs/embedded-browser.md decision 13 and
 * src/renderer/window-manager/bridge/useBrowserDownloadToast.ts.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage } from './helpers';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  ({ browser, page } = await launchPage());
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Browser pane download toast', () => {
  test('toasts a completed download with a working "Show in folder" action', async () => {
    await page.evaluate(() => {
      window.__mockBrowser?.emitDownloadDone({
        fileName: 'report.pdf',
        filePath: '/mock/downloads/report.pdf',
        state: 'completed',
      });
    });

    const downloadToast = page.locator('[data-testid="toast"]').filter({ hasText: 'Downloaded report.pdf' });
    await expect(downloadToast).toBeVisible({ timeout: 5000 });

    await downloadToast.getByText('Show in folder').click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __mockShowItemInFolderCalls?: string[] }).__mockShowItemInFolderCalls ?? []),
      { timeout: 5000 })
      .toContain('/mock/downloads/report.pdf');
  });

  test('toasts an interrupted download as a warning naming the file, with no action', async () => {
    await page.evaluate(() => {
      window.__mockBrowser?.emitDownloadDone({
        fileName: 'archive.zip',
        filePath: '/mock/downloads/archive.zip',
        state: 'interrupted',
      });
    });

    const warningToast = page.locator('[data-testid="toast"]')
      .filter({ hasText: 'Download did not finish: archive.zip' });
    await expect(warningToast).toBeVisible({ timeout: 5000 });
    await expect(warningToast.getByText('Show in folder')).toHaveCount(0);
  });

  test('a cancelled download also toasts as "did not finish"', async () => {
    // Same non-completed branch as 'interrupted' above (BrowserDownloadDone's
    // three-state union collapses to a binary completed/not-completed check
    // in the hook), but pinned separately since 'cancelled' is a real state
    // Electron reports and a future per-state branch should not silently
    // regress it back to the generic warning without a test noticing.
    await page.evaluate(() => {
      window.__mockBrowser?.emitDownloadDone({
        fileName: 'draft.docx',
        filePath: '/mock/downloads/draft.docx',
        state: 'cancelled',
      });
    });

    const warningToast = page.locator('[data-testid="toast"]')
      .filter({ hasText: 'Download did not finish: draft.docx' });
    await expect(warningToast).toBeVisible({ timeout: 5000 });
  });
});
