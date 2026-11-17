import { test, expect, type Page } from '@playwright/test';
import { launchPage } from './helpers';
import { DEV_SERVER_URL, DEV_SERVER_WARM_BUDGET_MS, warmDevServer } from './dev-server';

/**
 * gotoVite's boot retry. A page whose load event fired but whose #root stayed empty is a boot that
 * died, and gotoVite reloads it once. The failure it covers was seen once in a full local UI run,
 * so this spec stages it: the first request for the app's root component is aborted, which leaves
 * the entry's module graph unrun and the root empty, the same blank page that run captured.
 *
 * It loads from the dev server (DEV_SERVER_URL) on purpose: the failure is a dev-server module
 * request, and a bundle has no App.tsx request to abort.
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

// Both tests count on a healthy boot mounting inside gotoVite's 5 s grace, which only a warm dev
// server promises. In bundle mode nothing else has loaded from it (tests/ui/dev-server.ts).
test.beforeAll(async () => {
  test.setTimeout(DEV_SERVER_WARM_BUDGET_MS);
  await warmDevServer();
});

test.describe('gotoVite boot retry', () => {
  // The staged dead boot waits out the mount grace before its reload, which the default 15 s
  // budget does not leave room for alongside a browser launch.
  test.describe.configure({ timeout: 30_000 });

  test('a boot that loads but never mounts the app is reloaded once and comes up', async () => {
    let appModuleRequests: () => number = () => 0;
    const { browser } = await launchPage({
      url: DEV_SERVER_URL,
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
      url: DEV_SERVER_URL,
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
