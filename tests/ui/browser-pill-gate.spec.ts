/**
 * UI tests for the Browser pill gate in TaskDetailHeader.
 *
 * Verifies:
 * - The pill is shown when browser.enabled !== false and a live session
 *   exists.
 * - The pill is hidden when browser.enabled === false.
 * - Browser and Changes pills are mutually exclusive (toggling one closes
 *   the other -- both panes share the same screen real estate inside the
 *   task detail body).
 *
 * Performance: two shared browsers (one per browser.enabled flag value).
 * page.goto() in beforeEach resets mock state between tests so the mutual-
 * exclusion test does not bleed pill state into the enabled/hidden test. The
 * two describe blocks own independent browsers and share no mutable state, so
 * parallel mode overlaps their launches on CI.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';

// The two describe blocks each own their browser+page with no cross-describe
// state, so CI workers can run them concurrently.
test.describe.configure({ mode: 'parallel' });
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-browser-pill';
const TASK_ID = 'task-browser-pill';
const SESSION_ID = 'sess-browser-pill';

function preConfigScript(browserEnabled: boolean): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Browser Pill Test',
        path: '/mock/browser-pill-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.projectConfigs['/mock/browser-pill-test'] = {
        browser: { enabled: ${browserEnabled ? 'true' : 'false'} },
      };

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/browser-pill-test',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Pill Gate Task',
        description: 'Used to drive the Browser pill visibility gate',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: '/mock/worktrees/pill-gate',
        branch_name: 'feature/pill-gate',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function openTaskDialog(page: Page) {
  const card = page.locator('[data-swimlane-name="Code Review"]').locator('text=Pill Gate Task').first();
  await card.click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
}

// ─── browser.enabled = true ────────────────────────────────────────────────

test.describe('Browser pill gate (browser.enabled = true)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();

    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfigScript(true));
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test('pill is visible when browser.enabled is true', async () => {
    await openTaskDialog(page);
    await expect(page.locator('[data-testid="browser-toggle"]')).toBeVisible();
  });

  test('Browser and Changes are mutually exclusive', async () => {
    // Pre-seed a task URL so BrowserPane mounts the active branch
    // (data-testid="browser-pane"); without it we'd hit the empty state
    // (data-testid="browser-empty-state") and the assertions below would
    // need a different selector.
    await page.evaluate(() => {
      window.__mockBrowser?.seedTaskUrl('task-browser-pill', 'http://localhost:5173');
    });

    await openTaskDialog(page);

    const browserPill = page.locator('[data-testid="browser-toggle"]');
    const changesPill = page.locator('[data-testid="changes-toggle"]');

    await expect(browserPill).toBeVisible();
    await expect(changesPill).toBeVisible();

    // Open Changes first. The expand control is present only while the
    // Changes panel is open (split mode), so it doubles as the open signal.
    await changesPill.click();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible();

    // Now open Browser -- closes Changes (mutual exclusion).
    await browserPill.click();
    await expect(page.locator('[data-testid="browser-pane"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeHidden();

    // Re-open Changes -- closes Browser.
    await changesPill.click();
    await expect(page.locator('[data-testid="changes-expand"]')).toBeVisible();
    await expect(page.locator('[data-testid="browser-pane"]')).toBeHidden();
  });
});

// ─── browser.enabled = false ───────────────────────────────────────────────

test.describe('Browser pill gate (browser.enabled = false)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();

    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfigScript(false));
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
  });

  test('pill is hidden when browser.enabled is false', async () => {
    await openTaskDialog(page);
    // Both the Changes and Browser pills can render; we only assert Browser
    // is gone. Wait until the dialog has settled before checking absence.
    await expect(page.locator('[data-testid="changes-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="browser-toggle"]')).toBeHidden();
  });
});
