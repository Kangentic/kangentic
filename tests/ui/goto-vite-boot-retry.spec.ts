import { test, expect, type Page } from '@playwright/test';
import { launchPage } from './helpers';

/**
 * gotoVite's boot retry. A page whose load event fired but whose #root stayed empty is a boot that
 * died, and gotoVite reloads it once. The failure it covers was seen once in a full local UI run,
 * so this spec stages it: the first request for the app's root component is aborted, which leaves
 * the entry's module graph unrun and the root empty, the same blank page that run captured.
 */

const APP_MODULE = '**/src/renderer/App.tsx*';

/** Counts requests for the app's root component, aborting the first `abortFirst` of them. */
async function countAppModuleRequests(page: Page, abortFirst: number): Promise<() => number> {
  let requests = 0;
  await page.route(APP_MODULE, async (route) => {
    requests += 1;
    if (requests <= abortFirst) await route.abort();
    else await route.continue();
  });
  return () => requests;
}

test.describe('gotoVite boot retry', () => {
  // The staged dead boot waits out the mount grace before its reload, which the default 15 s
  // budget does not leave room for alongside a browser launch.
  test.describe.configure({ timeout: 30_000 });

  test('a boot that loads but never mounts the app is reloaded once and comes up', async () => {
    let appModuleRequests: () => number = () => 0;
    const { browser } = await launchPage({
      beforeLoad: async (page) => {
        appModuleRequests = await countAppModuleRequests(page, 1);
      },
    });
    try {
      expect(appModuleRequests()).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('a boot that mounts is not reloaded', async () => {
    let appModuleRequests: () => number = () => 0;
    const { browser } = await launchPage({
      beforeLoad: async (page) => {
        appModuleRequests = await countAppModuleRequests(page, 0);
      },
    });
    try {
      expect(appModuleRequests()).toBe(1);
    } finally {
      await browser.close();
    }
  });
});
