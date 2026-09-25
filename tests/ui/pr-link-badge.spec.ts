/**
 * UI tests for the shared PR link affordance (PrLink / PrStateBadge) and its
 * detail-header counterpart (the "View PR #N" kebab entry).
 *
 * Seeds a Code Review task with a linked, open PR and a running session (so the
 * detail dialog opens on TaskDetailHeader, not the edit form), then asserts the
 * two surfaces that let a user open the linked PR: the board card's PrLink badge
 * (PR number, an `open` state badge, a trailing external-link icon, and an "Open
 * PR #287 in browser" tooltip) and the detail header's `...` kebab "View PR #287"
 * entry (which opens the same URL). The header's compact icon bar itself has no
 * PR pill - that affordance is intentionally only on the card and in the kebab.
 *
 * The second describe seeds five more linked tasks into the Testing lane to pin
 * how merge readiness folds into the SAME chip: `ready` keeps the open hue,
 * `blocked` is amber, `conflicts` is orange (never closed's red), a pending
 * `unknown` keeps plain `open`, and a stale verdict on a merged PR never shows.
 * Each is scoped by `data-task-id`, since the first test locates the Code
 * Review card's pill with no `.first()`.
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
      // Never judged: pins that a null verdict still reads as plain "open".
      pr_merge_readiness: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    // Merge-readiness matrix, one card per verdict, in a lane the first test
    // never scopes into. The ready task is linked by PR NUMBER ONLY (no
    // branch, no worktree) and carries a running session, so its detail opens
    // on the header and the kebab test below can prove "Refresh PR" is offered
    // for a task whose only anchor is the stored number.
    state.sessions.push({
      id: 'sess-readiness-ready',
      taskId: 'task-readiness-ready',
      projectId: '${PROJECT_ID}',
      pid: 9998,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pr-link-test',
      startedAt: ts,
      exitCode: null,
    });
    var readinessSeeds = [
      { id: 'task-readiness-ready', number: 301, state: 'open', readiness: 'ready', sessionId: 'sess-readiness-ready', branch: null },
      { id: 'task-readiness-blocked', number: 302, state: 'open', readiness: 'blocked', sessionId: null, branch: 'feature/readiness-302' },
      { id: 'task-readiness-conflicting', number: 303, state: 'open', readiness: 'conflicting', sessionId: null, branch: 'feature/readiness-303' },
      { id: 'task-readiness-unknown', number: 304, state: 'open', readiness: 'unknown', sessionId: null, branch: 'feature/readiness-304' },
      { id: 'task-readiness-stale-merged', number: 305, state: 'merged', readiness: 'ready', sessionId: null, branch: 'feature/readiness-305' },
      { id: 'task-readiness-queued', number: 306, state: 'open', readiness: 'queued', sessionId: null, branch: 'feature/readiness-306' },
      { id: 'task-readiness-running', number: 307, state: 'open', readiness: 'running', sessionId: null, branch: 'feature/readiness-307' },
    ];
    readinessSeeds.forEach(function (seed, index) {
      state.tasks.push({
        id: seed.id,
        title: 'Readiness ' + seed.readiness + ' ' + seed.state,
        description: '',
        swimlane_id: laneIds['Testing'],
        position: index,
        agent: 'claude',
        session_id: seed.sessionId,
        worktree_path: null,
        branch_name: seed.branch,
        pr_number: seed.number,
        pr_url: 'https://github.com/owner/repo/pull/' + seed.number,
        pr_state: seed.state,
        pr_merge_readiness: seed.readiness,
        base_branch: 'main',
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
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

  test('detail header has no PR pill; the kebab "View PR" entry opens the same URL', async () => {
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('text=PR Link Task')
      .first();
    await card.click();

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // The compact icon bar itself has no PR pill; that affordance lives only on
    // the card and in the overflow kebab.
    await expect(page.locator('[data-testid="pr-pill"]')).toHaveCount(0);

    await page.evaluate(() => {
      window.__openedExternalUrls = [];
      window.electronAPI.shell.openExternal = async (url: string) => {
        window.__openedExternalUrls?.push(url);
      };
    });

    await dialog.locator('[title="Actions"]').click();
    const viewPrItem = page.getByRole('button', { name: 'View PR #287' });
    await expect(viewPrItem).toBeVisible();
    await viewPrItem.click();

    await expect
      .poll(() => page.evaluate(() => window.__openedExternalUrls))
      .toEqual(['https://github.com/owner/repo/pull/287']);

    // Restore the mock's default no-op so this patch does not leak into later
    // tests on the shared page (matches mock-electron-api.js shell.openExternal).
    await page.evaluate(() => {
      window.electronAPI.shell.openExternal = async () => {
        return;
      };
    });

    // Close the dialog so state does not leak to other tests.
    // Use Control+Shift+W (capture-phase) rather than Escape: the task-detail
    // window has a running session, so Escape via the bubble-phase listener can
    // be intercepted on CI Linux (bubble-phase Escape is not capture-safe).
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});

test.describe('PR merge readiness folds into the state chip', () => {
  const chipFor = (taskId: string) =>
    page.locator(`[data-task-id="${taskId}"] [data-testid="task-card-pr-link"] [data-testid="pr-state-badge"]`);
  const pillFor = (taskId: string) =>
    page.locator(`[data-task-id="${taskId}"] [data-testid="task-card-pr-link"]`);

  test('ready keeps the open hue, relabels the chip, and names the caveat in the chip tooltip', async () => {
    const chip = chipFor('task-readiness-ready');
    await expect(chip).toHaveText('ready');
    await expect(chip).toHaveClass(/text-emerald-400/);
    await expect(chip).toHaveAttribute('title', /last PR refresh/);
    // The caveat lives on the chip; the pill keeps its own action tooltip.
    await expect(pillFor('task-readiness-ready')).toHaveAttribute('title', 'Open PR #301 in browser');
  });

  test('blocked is amber', async () => {
    const chip = chipFor('task-readiness-blocked');
    await expect(chip).toHaveText('blocked');
    await expect(chip).toHaveClass(/text-amber-400/);
    await expect(chip).toHaveAttribute('title', /Merge blocked/);
  });

  test('conflicts is orange, never the red that closed uses', async () => {
    const chip = chipFor('task-readiness-conflicting');
    await expect(chip).toHaveText('conflicts');
    await expect(chip).toHaveClass(/text-orange-400/);
    await expect(chip).not.toHaveClass(/text-red-400/);
    await expect(chip).toHaveAttribute('title', /Merge conflicts/);
  });

  test('a pending unknown verdict keeps plain open', async () => {
    const chip = chipFor('task-readiness-unknown');
    await expect(chip).toHaveText('open');
    await expect(chip).not.toHaveAttribute('title', /./);
  });

  test('queued and running are sky, so a check in flight reads as progress rather than pass or fail', async () => {
    const queued = chipFor('task-readiness-queued');
    await expect(queued).toHaveText('queued');
    await expect(queued).toHaveClass(/text-sky-400/);
    await expect(queued).toHaveAttribute('title', /queued as of the last PR refresh/);

    const running = chipFor('task-readiness-running');
    await expect(running).toHaveText('running');
    await expect(running).toHaveClass(/text-sky-400/);
    await expect(running).not.toHaveClass(/text-emerald-400|text-amber-400|text-orange-400|text-fg-muted/);
    await expect(running).toHaveAttribute('title', /running as of the last PR refresh/);
  });

  test('a stale verdict on a merged PR never shows through', async () => {
    const chip = chipFor('task-readiness-stale-merged');
    await expect(chip).toHaveText('merged');
    await expect(chip).toHaveClass(/text-purple-400/);
    await expect(chip).not.toHaveAttribute('title', /./);
  });

  test('the kebab offers Refresh PR for a task linked by PR number alone', async () => {
    // No branch and no worktree: before readiness this task had no manual
    // refresh at all, and the background sweep was its only freshness path.
    // The stored number is a Tier-1 anchor, so the control must be there.
    // Click the title, not the card centroid: on a card this short the centroid
    // lands on the PR pill, whose own click opens the PR and stops propagation.
    await page.locator('[data-task-id="task-readiness-ready"]').locator('text=Readiness ready open').first().click();
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    await dialog.locator('[title="Actions"]').click();
    await expect(page.getByRole('button', { name: 'Refresh PR', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View PR #301', exact: true })).toBeVisible();

    // Same close as the header test above: Control+Shift+W, since a running
    // session's xterm can intercept a bubble-phase Escape.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
