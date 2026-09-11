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

// Extra fixtures for the pushed_branch / pr_number anchor coverage at the
// bottom of this file: pushed_branch is now a first-class PR anchor for a
// task with no worktree, so a task can carry it (or a bare pr_number) alone,
// with branch_name and worktree_path both null.
const TASK_ID_PUSHED_BRANCH = 'task-pr-link-toast-pushed-branch';
const SESSION_ID_PUSHED_BRANCH = 'sess-pr-link-toast-pushed-branch';
const PUSHED_BRANCH_NAME = 'maint/foo';
const TASK_ID_PR_NUMBER = 'task-pr-link-toast-pr-number';
const SESSION_ID_PR_NUMBER = 'sess-pr-link-toast-pr-number';
const TASK_ID_NO_ANCHOR = 'task-pr-link-toast-no-anchor';
const SESSION_ID_NO_ANCHOR = 'sess-pr-link-toast-no-anchor';

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

    // Pushed-branch-only anchor: no worktree, no branch_name, only an
    // ephemeral pushed branch recorded. Needs its own running session for the
    // same reason as the task above (the detail dialog must open on the
    // header, not the edit form).
    state.sessions.push({
      id: '${SESSION_ID_PUSHED_BRANCH}',
      taskId: '${TASK_ID_PUSHED_BRANCH}',
      projectId: '${PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pr-link-toast-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID_PUSHED_BRANCH}',
      // Deliberately NOT prefixed "PR Link Toast Task": the existing tests
      // above locate their card with the unquoted text=PR Link Toast Task
      // selector, which Playwright matches as a case-insensitive substring.
      // A title containing that substring would make their .first() pick
      // ambiguous once this task is on the board too.
      title: 'Pushed Branch Anchor Task',
      description: 'No worktree, no branch_name - only pushed_branch is set',
      swimlane_id: laneIds['Code Review'],
      position: 1,
      agent: 'claude',
      session_id: '${SESSION_ID_PUSHED_BRANCH}',
      worktree_path: null,
      branch_name: null,
      pushed_branch: '${PUSHED_BRANCH_NAME}',
      pr_number: null,
      pr_url: null,
      pr_state: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // pr_number-only anchor: no worktree, no branch_name, no pushed_branch -
    // only a recorded PR number.
    state.sessions.push({
      id: '${SESSION_ID_PR_NUMBER}',
      taskId: '${TASK_ID_PR_NUMBER}',
      projectId: '${PROJECT_ID}',
      pid: 9997,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pr-link-toast-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID_PR_NUMBER}',
      title: 'PR Number Anchor Task',
      description: 'No worktree, no branch_name, no pushed_branch - only pr_number is set',
      swimlane_id: laneIds['Code Review'],
      position: 2,
      agent: 'claude',
      session_id: '${SESSION_ID_PR_NUMBER}',
      worktree_path: null,
      branch_name: null,
      pushed_branch: null,
      pr_number: 42,
      pr_url: null,
      pr_state: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // No anchor at all - guards the other direction: the Link/Refresh PR item
    // must stay hidden when none of the four anchors is set.
    state.sessions.push({
      id: '${SESSION_ID_NO_ANCHOR}',
      taskId: '${TASK_ID_NO_ANCHOR}',
      projectId: '${PROJECT_ID}',
      pid: 9996,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pr-link-toast-test',
      startedAt: ts,
      exitCode: null,
    });
    state.tasks.push({
      id: '${TASK_ID_NO_ANCHOR}',
      title: 'No Anchor Task',
      description: 'No worktree, branch_name, pushed_branch, or pr_number',
      swimlane_id: laneIds['Code Review'],
      position: 3,
      agent: 'claude',
      session_id: '${SESSION_ID_NO_ANCHOR}',
      worktree_path: null,
      branch_name: null,
      pushed_branch: null,
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

  // `no-anchor` means nothing was searched: the task has no branch, commit,
  // or PR number recorded. It used to fall into the not-found branch and toast
  // "No PR found", which reads as "the PR does not exist" when it may well
  // exist and the task simply had nothing to search by.
  test('no-anchor toasts "nothing to search by", not "no PR found"', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Link Toast Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await page.evaluate(() => {
      window.__mockResolvePrResult = () => Promise.resolve({ task: null, linked: false, reason: 'no-anchor' });
    });

    await clickLinkPr();

    const toast = page.getByTestId('toast').filter({ hasText: 'Nothing to search by' });
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).not.toContainText('No PR found');

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

  // The success toast speaks the same word the card's chip shows, so a refresh
  // that changed only the merge verdict still reports a visible result rather
  // than a second "open".
  test('the success toast names the merge verdict when the PR is open and judged', async () => {
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
          reason: 'linked',
          linked: true,
          task: {
            id: 'task-pr-link-toast',
            pr_number: 42,
            pr_url: 'https://github.com/owner/repo/pull/42',
            pr_state: 'open',
            pr_merge_readiness: 'blocked',
          },
        });
    });

    await clickLinkPr();

    const toast = page.getByTestId('toast').filter({ hasText: 'Linked PR #42 (blocked)' });
    await expect(toast).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // A NULL pr_state (linked before merge-readiness tracking existed, or a host
  // that never reports it) has no chip label, so the toast falls back to the
  // word "open" rather than showing nothing. This pins the `|| 'open'` fallback
  // in the handler, distinct from the "blocked" test above which exercises the
  // chip-label branch, not the fallback.
  test('the success toast falls back to "open" when the PR has no reported state', async () => {
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
          reason: 'linked',
          linked: true,
          task: {
            id: 'task-pr-link-toast',
            pr_number: 43,
            pr_url: 'https://github.com/owner/repo/pull/43',
            pr_state: null,
            pr_merge_readiness: null,
          },
        });
    });

    await clickLinkPr();

    const toast = page.getByTestId('toast').filter({ hasText: 'Linked PR #43 (open)' });
    await expect(toast).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // Pins that the toast's word comes from prStatePresentation's chip label
  // ("conflicts"), not the raw PRMergeReadiness enum value ("conflicting"). A
  // future regression that inlines the enum instead of calling
  // prStatePresentation would pass the "blocked" test above (the words happen
  // to match) but fail this one.
  test('the success toast names the chip word for a conflicting verdict, not the raw enum', async () => {
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
          reason: 'linked',
          linked: true,
          task: {
            id: 'task-pr-link-toast',
            pr_number: 44,
            pr_url: 'https://github.com/owner/repo/pull/44',
            pr_state: 'open',
            pr_merge_readiness: 'conflicting',
          },
        });
    });

    await clickLinkPr();

    const toast = page.getByTestId('toast').filter({ hasText: 'Linked PR #44 (conflicts)' });
    await expect(toast).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});

test.describe('Link/Refresh PR kebab item: pushed_branch and pr_number anchors', () => {
  // THE FIX under test (TaskDetailHeader.tsx, TaskDetailKebabItems):
  //   1. The item's visibility widened from
  //      (task.branch_name || task.worktree_path) to also include
  //      task.pushed_branch and task.pr_number != null, so a no-worktree task
  //      whose push was recorded, or that names its PR only by number, now
  //      gets the control too.
  //   2. The "no PR found" toast's searched-branch fallback widened from
  //      task.branch_name only to task.branch_name ?? task.pushed_branch, so
  //      a task with no branch_name but a recorded pushed_branch names that
  //      branch in the toast instead of dropping to the generic message.
  // The sibling `no-anchor` test above exercises a task with none of
  // branch_name, worktree_path, pushed_branch, or pr_number - it does not
  // cover a task that has pushed_branch or pr_number ALONE, which is the gap
  // these three tests close.

  test('shows Link PR and toasts the pushed branch for a no-worktree task with only pushed_branch set', async () => {
    const card = page.locator(`[data-task-id="${TASK_ID_PUSHED_BRANCH}"]`);
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await dialog.locator('[title="Actions"]').click();
    const linkPrItem = page.getByRole('button', { name: 'Link PR', exact: true });
    await expect(linkPrItem).toBeVisible();

    await page.evaluate(() => {
      window.__mockResolvePrResult = () => Promise.resolve({ task: null, linked: false, reason: 'not-found' });
    });

    await linkPrItem.click();

    const toast = page.getByTestId('toast').filter({
      hasText: `No PR found for branch "${PUSHED_BRANCH_NAME}"`,
    });
    await expect(toast).toBeVisible({ timeout: 5000 });
    // Before the fix, a task with branch_name null fell straight to the
    // generic message even with pushed_branch set.
    await expect(toast).not.toContainText('No PR found for this task');

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  test('shows Link PR for a no-worktree task with only pr_number set', async () => {
    const card = page.locator(`[data-task-id="${TASK_ID_PR_NUMBER}"]`);
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await dialog.locator('[title="Actions"]').click();
    const linkPrItem = page.getByRole('button', { name: 'Link PR', exact: true });
    await expect(linkPrItem).toBeVisible();

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });

  // Guards the other direction: with none of the four anchors set, the item
  // must stay hidden rather than opening onto a resolver call with nothing
  // to search by.
  test('hides Link/Refresh PR entirely when none of the four anchors is set', async () => {
    const card = page.locator(`[data-task-id="${TASK_ID_NO_ANCHOR}"]`);
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await dialog.locator('[title="Actions"]').click();
    // Positive anchor first: "View conversation" always renders in this menu
    // (only its disabled state varies), so this proves the kebab actually
    // opened before the absence check below is trusted. Without it, a broken
    // Actions trigger would make the count-0 assertion pass vacuously.
    await expect(page.getByTestId('view-conversation-btn')).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Link PR|Refresh PR)$/ })).toHaveCount(0);

    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
