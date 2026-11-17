import { chromium } from '@playwright/test';
import path from 'node:path';

/**
 * The Vite dev server's address, for the few UI specs that need the dev server itself.
 *
 * On CI the UI tier loads the app from a static bundle (scripts/build-ui-bundle.mjs), served on
 * PLAYWRIGHT_VITE_PORT, because the dev server's one request per source module was most of what a
 * test cost. A bundle has no source-path URLs and no HMR client, so a spec that does one of these
 * takes its URL from here instead of from PLAYWRIGHT_VITE_PORT:
 *
 * - stalls or fails a module by its source path (`page.route('**' + '/ChangesPanel.tsx*')`),
 * - imports a module by its source path in the page (`import('/src/renderer/...')`),
 * - drives the dev server's own client (the dev restart notice).
 *
 * In bundle mode playwright.config.ts starts the dev server on a second port. Without the flag
 * there is one server and the two ports are the same, so a spec here behaves as it always has.
 * tests/unit/ui-bundle.test.ts fails a spec that does one of the above from anywhere else, since
 * it would pass locally and fail on CI.
 *
 * Reach a module's exports through `window.__kangenticTestModules` or `window.__zustandStores`
 * (src/renderer/App.tsx) where one of them holds it. That works in both modes and keeps the spec
 * on the bundle.
 */
export const DEV_SERVER_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_DEV_PORT || process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/** Bundle mode: the dev server is a second server that only the specs here ever load. */
const DEV_SERVER_STANDS_ALONE = process.env.KANGENTIC_UI_BUNDLE === '1';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');

/** How long one cold boot may take. Measured at up to about 15 s on a loaded 4-vCPU CI runner. */
const COLD_BOOT_TIMEOUT_MS = 90_000;

/** What a hook or test that calls `warmDevServer` needs as its own budget: `test.setTimeout(DEV_SERVER_WARM_BUDGET_MS)`. */
export const DEV_SERVER_WARM_BUDGET_MS = 120_000;

/**
 * Boots the app once from the dev server and waits for it to mount, so the test after it meets a
 * server that has already transformed the module graph.
 *
 * Call it before the first boot in a spec that loads from DEV_SERVER_URL, from a `beforeAll` or
 * the test itself, after `test.setTimeout(DEV_SERVER_WARM_BUDGET_MS)`. It does nothing unless the
 * dev server stands alone.
 *
 * Why: when every UI spec loaded from the dev server, the first boots of a run paid its cold
 * start between them and the rest found it warm. In bundle mode nothing else loads from it, so
 * the first of these specs paid the whole cold start inside its own 15 s test budget.
 * stats-lazy-retry.spec.ts timed out that way and passed on its retry in two of four CI runs,
 * which --fail-on-flaky-tests reports as a failure. goto-vite-boot-retry.spec.ts depends on it
 * too: it counts on a healthy boot mounting inside gotoVite's 5 s grace, which a cold server
 * does not promise.
 */
export async function warmDevServer(): Promise<void> {
  if (!DEV_SERVER_STANDS_ALONE) return;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The mock, so the app mounts as it does in a spec and not into an error boundary.
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.goto(DEV_SERVER_URL, { waitUntil: 'load', timeout: COLD_BOOT_TIMEOUT_MS });
    await page.waitForSelector('#root > *', { state: 'attached', timeout: COLD_BOOT_TIMEOUT_MS });
  } finally {
    await browser.close();
  }
}
