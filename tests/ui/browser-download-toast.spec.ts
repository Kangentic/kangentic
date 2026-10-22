/**
 * UI test for the Browser-pane download toast (useBrowserDownloadToast.ts).
 *
 * A pane's `<webview>` saves a triggered download straight to the OS Downloads
 * folder (the Chrome behavior, and the only thing that makes downloads work
 * at all for the human using the pane). Silently is the wrong default here:
 * an agent driving the pane can trigger a download the user never asked for,
 * so main pushes BROWSER_DOWNLOAD_DONE and this hook toasts it - a success
 * toast whose card shows the file in its folder on a click for a completed
 * download, and a plain warning naming the file for anything that didn't
 * finish.
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
  test('toasts a completed download, and a click on the card shows it in its folder', async () => {
    await page.evaluate(() => {
      window.__mockBrowser?.emitDownloadDone({
        fileName: 'report.pdf',
        filePath: '/mock/downloads/report.pdf',
        state: 'completed',
      });
    });

    const downloadToast = page.locator('[data-testid="toast"]').filter({ hasText: 'report.pdf' });
    await expect(downloadToast).toBeVisible({ timeout: 5000 });
    await expect(downloadToast.getByTestId('toast-title')).toHaveText('Downloaded');
    await expect(downloadToast.getByTestId('toast-body')).toHaveText('report.pdf');
    await expect(downloadToast).toHaveAttribute('data-variant', 'success');

    // A timed toast has no button: the card itself opens the folder.
    await downloadToast.click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __mockShowItemInFolderCalls?: string[] }).__mockShowItemInFolderCalls ?? []),
      { timeout: 5000 })
      .toContain('/mock/downloads/report.pdf');
  });

  test('toasts an interrupted download as a warning naming the file, with nothing to open', async () => {
    await page.evaluate(() => {
      window.__mockBrowser?.emitDownloadDone({
        fileName: 'archive.zip',
        filePath: '/mock/downloads/archive.zip',
        state: 'interrupted',
      });
    });

    const warningToast = page.locator('[data-testid="toast"]').filter({ hasText: 'archive.zip' });
    await expect(warningToast).toBeVisible({ timeout: 5000 });
    await expect(warningToast.getByTestId('toast-title')).toHaveText("Download didn't finish");
    await expect(warningToast.getByTestId('toast-body')).toHaveText('archive.zip');
    await expect(warningToast).toHaveAttribute('data-variant', 'warning');
    // A partial file has no folder to show, so the card opens nothing: it lets
    // clicks through to what is under it rather than taking them.
    await expect(warningToast).toHaveCSS('pointer-events', 'none');
    // One-shot count, not toHaveCount(0) - see toastCountRightNow in ./helpers.
    // The trap reaches a CHILD too: if a button were wrongly rendered, the
    // whole toast would auto-dismiss inside the retry window and the child count
    // would reach 0 on its own.
    expect(await warningToast.getByTestId('toast-action').count()).toBe(0);
  });

  test('a cancelled download also toasts as "didn\'t finish"', async () => {
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

    const warningToast = page.locator('[data-testid="toast"]').filter({ hasText: 'draft.docx' });
    await expect(warningToast).toBeVisible({ timeout: 5000 });
    await expect(warningToast.getByTestId('toast-title')).toHaveText("Download didn't finish");
    await expect(warningToast).toHaveAttribute('data-variant', 'warning');
  });
});
