/**
 * A column whose role is outside the SwimlaneRole union must not crash the Board Manager.
 *
 * Sentry DESKTOP-D: `swimlanes.role` is plain TEXT with no CHECK constraint, and roles
 * that left the union ('planning', 'running') are still on disk wherever the one-shot
 * migrations that cleared them had already run. Every role icon comes from a two-key
 * `Record<SwimlaneRole, IconComponent>`, so `ROLE_DEFAULTS[draft.role]` returned undefined
 * and the Icon field rendered `<undefined />` - React error #130, caught by the root
 * ErrorBoundary, which blanks the whole board.
 *
 * The main process now narrows the role on read, so this cannot reach a real renderer.
 * That is exactly why the coverage belongs here: the UI tier mocks `window.electronAPI`
 * wholesale, so `mapRow` never runs and this spec pins the renderer's own guard
 * independently of the DB fix. Delete the guard in BoardManagerDialog and this goes red.
 *
 * Tier: UI (headless Chromium). Each test owns its own browser, so a failure cannot
 * cascade into the next test.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-legacy-role';
const PROJECT_PATH = '/mock/projects/legacy-role';

/**
 * Seed the seven default columns, with two of them stripped of their custom icon so the
 * Icon field actually reaches the role branch: `draft.icon` is resolved FIRST, so a lane
 * that keeps its seeded icon ('map' on Planning, 'layers' on To Do) never touches
 * ROLE_DEFAULTS at all and would pass vacuously.
 *
 * Planning carries the out-of-union role. To Do keeps a valid one, so the pair covers
 * both directions: the bad role must not throw, and the good role must still resolve.
 *
 * Pushing into `state.swimlanes` makes it non-empty, which skips the mock's lazy default
 * seeding in `projects.open` - so all seven have to be seeded here.
 */
const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Legacy Role Test',
      path: '${PROJECT_PATH}',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      var seeded = Object.assign({}, lane, {
        id: 'lane-lr-' + lane.name.toLowerCase().replace(/\\s+/g, '-'),
        position: index,
        created_at: ts,
      });
      if (lane.name === 'Planning') {
        // The legacy value from the pre-union era, still on disk in real installs.
        seeded.role = 'planning';
        seeded.icon = null;
      }
      if (lane.name === 'To Do') {
        seeded.icon = null;
      }
      state.swimlanes.push(seeded);
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchSeededPage(): Promise<{
  browser: Browser;
  page: Page;
  getPageErrors: () => string[];
}> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  // Registered before navigation so the very first render's throw is captured.
  const getPageErrors = collectPageErrors(page);
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page, getPageErrors };
}

/** Open the Board Manager the way the crashing user did: click the column header. */
async function openManagerByHeader(page: Page, columnName: string): Promise<void> {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
}

test.describe('BoardManagerDialog - out-of-union column role', () => {
  let browser: Browser;
  let page: Page;
  let getPageErrors: () => string[];

  test.beforeEach(async () => {
    ({ browser, page, getPageErrors } = await launchSeededPage());
  });

  test.afterEach(async () => {
    await browser?.close();
  });

  test('opens on a column whose role is outside the union without throwing', async () => {
    await openManagerByHeader(page, 'Planning');

    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const iconButton = page.locator('[data-testid="board-manager-icon"]');
    await expect(iconButton).toBeVisible();
    // The unresolvable role falls through to the color-dot fallback rather than
    // rendering `<undefined />`. The dot is the only rounded-full div in the button.
    await expect(iconButton.locator('div.rounded-full')).toHaveCount(1);

    // The ErrorBoundary fallback is a bare heading with no testid, so a throw would
    // otherwise be indistinguishable from an unrelated timeout above.
    await expect(page.locator('h1', { hasText: 'Something went wrong' })).toHaveCount(0);
    expect(getPageErrors()).toHaveLength(0);
  });

  test('still resolves the role default icon for a column with a valid role', async () => {
    await openManagerByHeader(page, 'To Do');

    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const iconButton = page.locator('[data-testid="board-manager-icon"]');
    await expect(iconButton).toBeVisible();
    // 'todo' resolves, so the role icon renders and the dot fallback must NOT appear.
    // This is what stops the crash being "fixed" by dropping the role branch entirely.
    await expect(iconButton.locator('div.rounded-full')).toHaveCount(0);
    await expect(iconButton).toContainText('Default (todo)');

    expect(getPageErrors()).toHaveLength(0);
  });
});
