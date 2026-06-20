/**
 * UI tests for the shared PR link affordance (PrLink / PrStateBadge).
 *
 * Seeds a Code Review task with a linked, open PR and a running session (so the
 * detail dialog opens on TaskDetailHeader, not the edit form), then asserts both
 * surfaces that render the linked PR: the board card and the detail header. Each
 * must show the PR number, an `open` state badge (not inline text), a trailing
 * external-link icon, and an "Open PR #287 in browser" tooltip.
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

const PROJECT_ID = 'proj-pr-link';
const TASK_ID = 'task-pr-link';
const SESSION_ID = 'sess-pr-link';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'PR Link Test',
      path: '/mock/pr-link-test',
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

    // Running session so displayState.kind === 'running' -> the detail dialog
    // opens on TaskDetailHeader (with the PR pill), not the edit form.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pr-link-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'PR Link Task',
      description: 'Task used for the PR link badge/affordance test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/pr-link',
      branch_name: 'feature/pr-link',
      pr_number: 287,
      pr_url: 'https://github.com/owner/repo/pull/287',
      pr_state: 'open',
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchWithState(preConfig);
  browser = result.browser;
  page = result.page;
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('PR link: state badge and clickable affordance', () => {
  test('board card shows PR number, open badge, and external-open affordance', async () => {
    const prLink = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('[data-testid="task-card-pr-link"]');
    await expect(prLink).toBeVisible({ timeout: 10000 });

    // PR number renders as the link label.
    await expect(prLink).toContainText('PR #287');

    // State renders as a standalone badge, not inline text.
    await expect(prLink.locator('[data-testid="pr-state-badge"]')).toHaveText('open');

    // Trailing external-link icon signals it opens in the browser.
    await expect(prLink.locator('.lucide-external-link')).toBeVisible();

    // Tooltip names the action.
    await expect(prLink).toHaveAttribute('title', 'Open PR #287 in browser');
  });

  test('detail header shows the same PR badge and affordance', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Link Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const prPill = page.locator('[data-testid="pr-pill"]');
    await expect(prPill).toBeVisible();
    await expect(prPill).toContainText('PR #287');
    await expect(prPill.locator('[data-testid="pr-state-badge"]')).toHaveText('open');
    await expect(prPill.locator('.lucide-external-link')).toBeVisible();
    await expect(prPill).toHaveAttribute('title', 'Open PR #287 in browser');

    // Close the dialog so state does not leak to other tests.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});
