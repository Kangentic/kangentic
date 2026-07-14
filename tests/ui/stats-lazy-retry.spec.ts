/**
 * UI tests for the code-split usage-stats dashboard (LazyStatsDashboard).
 *
 * The recharts-bearing StatsDashboardBody is a lazy chunk behind a scoped
 * PanelErrorBoundary, mirroring the Changes panel split. Two behaviors are
 * locked here:
 *
 * 1. A chunk-load failure stays scoped to the dashboard body (the stats
 *    overlay chrome and the rest of the app survive) and offers Reload
 *    (a failed module URL is poisoned in the document's module map, so a
 *    remount can never heal it); after healing the network, reload recovers.
 * 2. A genuinely cold open (chunk not yet resolved) paints the layout
 *    skeleton, which is replaced by the real dashboard when the chunk
 *    arrives - the acceptance shape for "no bare spinner on cold open".
 *
 * Each test launches its own page: the module map (and the idle warm fired
 * from AppLayout mount) is per-document state, so sharing a page would let
 * an earlier test's successful load mask a later test's cold-open path.
 *
 * Note: the first test deliberately breaks the network, so an aborted module
 * fetch surfaces a console resource error and a React error-boundary
 * console.error. Those are expected and handled by the boundary, so
 * `collectPageErrors` is intentionally NOT used here.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-stats-lazy';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Stats Lazy Test',
      path: '/mock/stats-lazy-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchPage(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  return { browser, page };
}

test.describe('usage stats: lazy-import failure is scoped and recoverable', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('a chunk failure shows a dashboard-scoped error, not a root crash, and reload recovers', async () => {
    ({ browser, page } = await launchPage());

    // Abort the StatsDashboardBody module fetch BEFORE navigation: this also
    // poisons the idle warm AppLayout fires shortly after mount, which is the
    // realistic failure (the warm and the open share one module map). The
    // trailing `*` matches Vite's optional `?t=` invalidation query.
    await page.route('**/StatsDashboardBody.tsx*', (route) => route.abort());

    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });

    await page.locator('[data-testid="usage-stats-button"]').click();
    await page.locator('[data-testid="stats-page"]').waitFor({ state: 'visible', timeout: 5000 });

    // The lazy import fails and the SCOPED boundary catches it.
    const boundary = page.locator('[data-testid="panel-error-boundary"]');
    await expect(boundary).toBeVisible({ timeout: 10000 });

    // Blast radius stayed scoped to the dashboard body: no root "Something
    // went wrong" page, and the stats overlay chrome (header + close button)
    // is still alive around the boundary.
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();
    await expect(page.locator('[data-testid="stats-close"]')).toBeVisible();

    // A chunk-load failure cannot be healed by a remount (the module URL is
    // poisoned in the module map), so the boundary offers Reload, not Retry.
    const action = page.locator('[data-testid="panel-error-retry"]');
    await expect(action).toHaveText(/Reload/);

    // Heal the network, then reload. A fresh document has a fresh module map.
    await page.unroute('**/StatsDashboardBody.tsx*');
    await action.click();

    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await expect(page.locator('text=Something went wrong')).not.toBeVisible();

    // Reopen stats: the dashboard body (filter row lives inside the lazy
    // module) now loads and the boundary is gone.
    await page.locator('[data-testid="usage-stats-button"]').click();
    await expect(page.locator('[data-testid="stats-filter-row"]')).toBeVisible({ timeout: 10000 });
    await expect(boundary).not.toBeVisible();
  });
});

test.describe('usage stats: cold open paints the layout skeleton, then the dashboard', () => {
  let browser: Browser;
  let page: Page;

  test.afterEach(async () => {
    await browser?.close();
  });

  test('the skeleton shows while the chunk is in flight and is replaced when it resolves', async () => {
    ({ browser, page } = await launchPage());

    // Hold (do not fail) the chunk fetch until this test releases it, so the
    // open below is deterministically cold no matter how fast the idle warm
    // fires. No timers: the release is an explicit gate.
    let releaseChunk = () => {};
    const chunkHeld = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    await page.route('**/StatsDashboardBody.tsx*', async (route) => {
      await chunkHeld;
      await route.continue();
    });

    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });

    await page.locator('[data-testid="usage-stats-button"]').click();
    await page.locator('[data-testid="stats-page"]').waitFor({ state: 'visible', timeout: 5000 });

    // Cold open: the overlay chrome is up, the body shows the layout skeleton
    // (not a bare spinner, not a blank pane).
    await expect(page.locator('[data-testid="stats-dashboard-skeleton"]')).toBeVisible({ timeout: 5000 });

    // Release the chunk: the real dashboard replaces the skeleton in place.
    releaseChunk();
    await expect(page.locator('[data-testid="stats-filter-row"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="stats-dashboard-skeleton"]')).not.toBeVisible();
  });
});
