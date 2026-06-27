/**
 * UI tests for the opt-in `showTaskNumbers` board setting.
 *
 * Intent: when `showTaskNumbers` is on, every board task card renders its
 * `#N` (`display_id`) as a subtle, muted badge in the card header
 * (`data-testid="task-card-display-id"`). The setting is global and defaults
 * to OFF, so a fresh board shows no numbers until the user opts in via the
 * Layout settings tab.
 *
 * The card reads `useConfigStore(state => state.config.showTaskNumbers)`; the
 * Layout tab toggle writes the same key via `updateConfig({ showTaskNumbers })`.
 * These tests drive that exact write path through the dev-only config store
 * handle (`__zustandStores.config`) and assert the card read path, rather than
 * walking the settings UI, so they stay robust.
 *
 * Tests:
 *   1. Default OFF: the seeded card shows no `#N` badge.
 *   2. After enabling: the badge appears and its text matches the seeded
 *      `display_id` (the same number shown in the task detail header).
 *   3. Compact (archived) card branch: an archived task renders as compact={true}
 *      in DoneSwimlane's "Completed" section. Asserts {displayIdBadge} in THAT
 *      branch is also correctly gated - removing it from the compact branch only
 *      (while leaving the normal branch intact) makes this test go RED while
 *      keeping tests 1 and 2 green.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-display-id';
const TASK_ID = 'task-display-id';
const DISPLAY_ID = 42;
/** Seeded as an archived task so it renders via the compact={true} branch in DoneSwimlane. */
const COMPACT_TASK_ID = 'task-display-id-compact';
const COMPACT_DISPLAY_ID = 99;

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Display ID Test',
      path: '/mock/display-id-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-tcdi-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: ${DISPLAY_ID},
      title: 'Card Display ID Task',
      description: 'Task used to test the opt-in ticket-number badge',
      swimlane_id: laneIds['To Do'],
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // Seed an archived task so the DoneSwimlane renders it via compact={true}.
    // This is the only path through the compact branch that is reachable from
    // the board (BacklogView does not use compact). The archived task shows up
    // in DoneSwimlane's scrollable "Completed" preview list.
    state.archivedTasks.push({
      id: '${COMPACT_TASK_ID}',
      display_id: ${COMPACT_DISPLAY_ID},
      title: 'Compact Badge Task',
      description: null,
      swimlane_id: laneIds['Done'],
      position: 0,
      agent: null,
      session_id: null,
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      archived_at: ts,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

/** Flip the global showTaskNumbers config through the real write path the Layout toggle uses. */
async function setShowTaskNumbers(page: Page, value: boolean): Promise<void> {
  await page.evaluate((newValue) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { updateConfig: (partial: { showTaskNumbers: boolean }) => Promise<void> } } };
    }).__zustandStores;
    return stores?.config.getState().updateConfig({ showTaskNumbers: newValue });
  }, value);
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('showTaskNumbers: card ticket-number badge', () => {
  test('is hidden by default (opt-in)', async () => {
    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    await expect(card).toBeVisible();
    // Default is OFF, so the #N badge must not render.
    await expect(card.locator('[data-testid="task-card-display-id"]')).toHaveCount(0);
  });

  test('renders #N matching display_id once enabled', async () => {
    await setShowTaskNumbers(page, true);

    const card = page.locator(`[data-task-id="${TASK_ID}"]`);
    const badge = card.locator('[data-testid="task-card-display-id"]');
    await expect(badge).toBeVisible({ timeout: 5000 });
    await expect(badge).toHaveText(`#${DISPLAY_ID}`);

    // Turning it back off hides the badge again (read path is reactive).
    await setShowTaskNumbers(page, false);
    await expect(card.locator('[data-testid="task-card-display-id"]')).toHaveCount(0);
  });

  test('compact (archived) card badge is hidden by default and shown once enabled', async () => {
    // Coverage target: the `{displayIdBadge}` placed inside the `if (compact)` branch
    // of TaskCard.tsx (rendered for archived tasks in DoneSwimlane's "Completed" list).
    // Removing that single JSX expression from the compact branch -- while leaving the
    // normal-branch badge intact -- makes this assertion time out (RED) while tests 1
    // and 2 remain green. data-testid="compact-title" is only rendered by the compact
    // branch, confirming we are exercising that code path.
    const doneSwimlane = page.locator('[data-swimlane-name="Done"]');
    await expect(doneSwimlane).toBeVisible({ timeout: 10000 });

    const compactCard = page.locator(`[data-task-id="${COMPACT_TASK_ID}"]`);
    // Verify we are in the compact branch: compact-title is a unique testid on line 189
    // of TaskCard.tsx, present only inside `if (compact) { ... }`.
    await expect(compactCard.locator('[data-testid="compact-title"]')).toBeVisible({ timeout: 5000 });

    // Default is OFF: no badge.
    await expect(compactCard.locator('[data-testid="task-card-display-id"]')).toHaveCount(0);

    // Enable ticket numbers: compact badge appears with the correct display_id.
    await setShowTaskNumbers(page, true);
    const compactBadge = compactCard.locator('[data-testid="task-card-display-id"]');
    await expect(compactBadge).toBeVisible({ timeout: 5000 });
    await expect(compactBadge).toHaveText(`#${COMPACT_DISPLAY_ID}`);

    // Disable again: badge gone.
    await setShowTaskNumbers(page, false);
    await expect(compactCard.locator('[data-testid="task-card-display-id"]')).toHaveCount(0);
  });
});
