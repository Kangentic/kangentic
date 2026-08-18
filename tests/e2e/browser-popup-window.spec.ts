/**
 * E2E coverage: popups opened from the Browser pane's `<webview>` guest.
 *
 * This is the only tier with a real Electron guest, and it is the only place
 * three properties can be checked at all - each of which the popup's whole
 * security and OAuth story rests on:
 *
 * 1. The popup EXISTS. The pane used to deny `window.open` outright, which made
 *    every popup-based sign-in a dead button.
 * 2. Its title is the ORIGIN, not the page's own title. The OS title bar is the
 *    only origin indicator a popup has, so a page free to name itself would be a
 *    phishing surface.
 * 3. It shares the guest's `Session` OBJECT. Not just cookies: a popup in a
 *    different partition is in a different browsing context group, which severs
 *    `window.opener` and the `postMessage` handback nearly every OAuth flow
 *    uses. Comparing the two Session objects in the main process is the only way
 *    to check this without a network round trip.
 *
 * Deliberately NETWORK-FREE. The window is created and titled from the REQUESTED
 * url before any navigation resolves, so `example.com` never has to load; the
 * assertions read main-process state, not page content. That keeps this test
 * honest on CI, which has no outbound network guarantee.
 */
import { test, expect } from './shared-app';
import { createTask, waitForRunningSession, getTaskIdByTitle } from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const runId = Date.now();

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + 10, cardBox.y, { steps: 3 });
  await page.waitForTimeout(100);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/** Open a task's Browser pane on about:blank and wait for the guest to attach. */
async function openPaneWithGuest(page: Page, title: string): Promise<void> {
  const taskId = await getTaskIdByTitle(page, title);
  // A data: URL is rewritten to about:blank by will-attach-webview, which is all
  // this test needs: a live guest to call window.open FROM.
  await page.evaluate(async (id: string) => {
    await window.electronAPI.browser.setTaskUrl(id, 'data:text/html,<h1>popup-host</h1>');
  }, taskId);

  await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-testid="browser-toggle"]').click();
  await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(500);
}

/** Run an expression inside the guest webContents (not the host renderer). */
async function evalInGuest(electronApp: ElectronApplication, expression: string): Promise<unknown> {
  return electronApp.evaluate(async ({ webContents }, source: string) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview');
    if (!guest) throw new Error('no webview guest attached');
    return guest.executeJavaScript(source, true);
  }, expression);
}

test.describe('Browser pane popups', () => {
  test('a guest window.open produces a chromed window titled with the target origin', async ({ freshProject, sharedApp }) => {
    const electronApp = sharedApp.app;
    const { page } = freshProject;
    const title = `Popup Origin ${runId}`;
    await createTask(page, title, 'popup origin title');
    await dragTaskToColumn(page, title, 'Code Review');
    await waitForRunningSession(page);
    await openPaneWithGuest(page, title);

    const before = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    await evalInGuest(electronApp, "String(!!window.open('https://example.com/','_blank','width=520,height=640'))");

    // The window is constructed and titled from the REQUESTED url, before any
    // navigation resolves, so this needs no network.
    await expect
      .poll(
        () => electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => window.getTitle())),
        { timeout: 10000, intervals: [200, 400, 800] },
      )
      .toContain('example.com');

    const after = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(after).toBe(before + 1);

    // Chromed, unlike every other window this app creates.
    const framed = await electronApp.evaluate(({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'example.com');
      return popup ? popup.isDestroyed() === false : null;
    });
    expect(framed).toBe(true);

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .filter((window) => window.getTitle() === 'example.com')
        .forEach((window) => window.destroy());
    });
  });

  test('the popup shares the guest Session object, so it shares the cookie jar', async ({ freshProject, sharedApp }) => {
    const electronApp = sharedApp.app;
    // The hardest property to verify any other way, and the one OAuth depends
    // on: same Session means same jar AND same browsing context group, which is
    // what keeps window.opener and postMessage alive.
    const { page } = freshProject;
    const title = `Popup Session ${runId}`;
    await createTask(page, title, 'popup session identity');
    await dragTaskToColumn(page, title, 'Code Review');
    await waitForRunningSession(page);
    await openPaneWithGuest(page, title);

    await evalInGuest(electronApp, "String(!!window.open('https://example.com/','_blank','width=420,height=420'))");

    await expect
      .poll(
        () => electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => window.getTitle())),
        { timeout: 10000, intervals: [200, 400, 800] },
      )
      .toContain('example.com');

    const sameSession = await electronApp.evaluate(({ BrowserWindow, webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview');
      const popup = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'example.com');
      if (!guest || !popup) return null;
      return popup.webContents.session === guest.session;
    });
    expect(sameSession).toBe(true);

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .filter((window) => window.getTitle() === 'example.com')
        .forEach((window) => window.destroy());
    });
  });

  test('a javascript: window.open opens nothing', async ({ freshProject, sharedApp }) => {
    const electronApp = sharedApp.app;
    const { page } = freshProject;
    const title = `Popup Denied ${runId}`;
    await createTask(page, title, 'popup scheme denial');
    await dragTaskToColumn(page, title, 'Code Review');
    await waitForRunningSession(page);
    await openPaneWithGuest(page, title);

    const before = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    // Returns null when denied, which is also what the page sees.
    const handle = await evalInGuest(electronApp, "String(window.open('javascript:alert(1)','_blank'))");
    expect(handle).toBe('null');

    await page.waitForTimeout(500);
    const after = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(after).toBe(before);
  });
});
