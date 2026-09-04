/**
 * UI test for the "Link PR" kebab action's degrade toast in TaskDetailHeader.
 *
 * THE FIX under test: the toast used to show hardcoded GitHub copy
 * ("GitHub CLI not found - install gh and run gh auth login to link PRs" /
 * "Could not reach GitHub - try again in a moment") for BOTH the
 * resolver-unavailable and transient-error reasons. It now prefers
 * `result.message` - the resolver's own, provider-specific reason - and
 * falls back to a generic, non-gh-branded message only when no message is
 * supplied. Before this fix, an Azure DevOps user whose `az` CLI was missing
 * was told to run `gh auth login`, which does nothing for Azure DevOps.
 *
 * Seeds a task with no linked PR (kebab label is "Link PR", not "Refresh
 * PR") and a running session, so the detail dialog opens on TaskDetailHeader
 * rather than the edit form (mirrors pr-link-badge.spec.ts's seeding).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-pr-link-toast';
const TASK_ID = 'task-pr-link-toast';
const SESSION_ID = 'sess-pr-link-toast';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'PR Link Toast Test',
      path: '/mock/pr-link-toast-test',
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
    // opens on TaskDetailHeader (with the kebab "Link PR" action), not the
    // edit form.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pr-link-toast-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'PR Link Toast Task',
      description: 'Task used for the Link PR degrade-toast test',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: null,
      branch_name: 'feature/pr-link-toast',
      pr_number: null,
      pr_url: null,
      pr_state: null,
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
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });
});

test.afterAll(async () => {
  await browser?.close();
});

/** Open the task detail dialog's kebab menu and click the "Link PR" entry. */
async function clickLinkPr(): Promise<void> {
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.locator('[title="Actions"]').click();
  // exact: true is load-bearing: the task's own description text ("...the
  // Link PR degrade-toast test") makes the board card's aggregated
  // accessible name a SUBSTRING match for a non-exact "Link PR" query too.
  const linkPrItem = page.getByRole('button', { name: 'Link PR', exact: true });
  await expect(linkPrItem).toBeVisible();
  await linkPrItem.click();
}

test.describe('Link PR kebab action: degrade toast uses the resolver message', () => {
  test('shows the resolver-unavailable message, not the hardcoded gh CLI copy', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Link Toast Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await page.evaluate(() => {
      window.__mockResolvePrResult = () =>
        Promise.resolve({
          reason: 'resolver-unavailable',
          message: 'Azure CLI unavailable for PR lookup. Check: az login, az extension add --name azure-devops',
        });
    });

    await clickLinkPr();

    const toast = page.getByTestId('toast').filter({
      hasText: 'Azure CLI unavailable for PR lookup. Check: az login, az extension add --name azure-devops',
    });
    await expect(toast).toBeVisible({ timeout: 5000 });
    // The bug this fix guards: an Azure DevOps user must never be told to run
    // the GitHub CLI's auth command.
    await expect(toast).not.toContainText('gh auth login');

    // Close the dialog so state does not leak to the next test on this
    // shared page. Control+Shift+W (capture-phase), not Escape: this task
    // has a running session, so a bubble-phase Escape can be intercepted by
    // the focused xterm (see the light-dismiss / arrival-focus rules).
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('falls back to a generic, non-gh-branded message when the resolver supplies none', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Link Toast Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await page.evaluate(() => {
      window.__mockResolvePrResult = () => Promise.resolve({ reason: 'resolver-unavailable' });
    });

    await clickLinkPr();

    const toast = page.getByTestId('toast').filter({ hasText: 'No PR resolver available for this repository' });
    await expect(toast).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // The transient-error branch is a SEPARATE `result.message ?? '<fallback>'`
  // in the handler, not shared code with the resolver-unavailable branch
  // above - it needs its own coverage or a future regression there (e.g.
  // reintroducing the old "Could not reach GitHub - try again in a moment"
  // hardcode) would pass this suite unnoticed.
  test('transient-error also shows the resolver message, not hardcoded GitHub copy', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Link Toast Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await page.evaluate(() => {
      window.__mockResolvePrResult = () =>
        Promise.resolve({
          reason: 'transient-error',
          message: 'Temporary Azure DevOps error - try again.',
        });
    });

    await clickLinkPr();

    const toast = page.getByTestId('toast').filter({ hasText: 'Temporary Azure DevOps error - try again.' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).not.toContainText('GitHub');

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
