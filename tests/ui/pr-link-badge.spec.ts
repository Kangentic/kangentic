/**
 * UI tests for the shared compact PR pill (PrLink) and its detail-header
 * counterpart (the "View PR #N" kebab entry).
 *
 * Seeds a Code Review task with a linked, open PR and a running session (so the
 * detail dialog opens on TaskDetailHeader, not the edit form), then asserts the
 * two surfaces that let a user open the linked PR: the board card's pill (PR
 * number, the state's tint, a trailing external-link icon, and a "PR #287" tooltip
 * with the state as its detail and one "Open in default browser" row, since no
 * Kangentic browser is open for the task, which a click and a Ctrl+click both use)
 * and the detail header's `...` kebab "View PR #287" entry (which opens the same URL). The header's compact icon
 * bar itself has no PR pill; the Changes panel opens the PR from its Pull
 * request section (changes-pull-request-section.spec.ts).
 *
 * The second describe seeds more linked tasks into the Testing lane to pin how
 * merge readiness tints the SAME pill, which draws no state word: `ready` keeps
 * the open green, `blocked` is amber, `conflicts` is red with the conflict
 * glyph, a pending `unknown` keeps plain open, a check in flight is sky with a
 * pulsing edge, and a stale verdict on a merged PR never shows.
 * Each is scoped by `data-task-id`, since the first test locates the Code
 * Review card's pill with no `.first()`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await gotoVite(page, VITE_URL);
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
      { id: 'task-readiness-failing', number: 308, state: 'open', readiness: 'failing', sessionId: null, branch: 'feature/readiness-308' },
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

    // No state word: the glyph and the open green carry the state.
    await expect(prLink).toHaveText('PR #287');
    await expect(prLink).toHaveClass(/text-emerald-400/);
    await expect(prLink).toHaveAttribute('data-pr-state', 'open');

    // Trailing external-link icon signals it opens in the browser.
    await expect(prLink.locator('.lucide-external-link')).toBeVisible();

    // Tooltip is a head line (the PR, and the state as its detail) over a row
    // per click (the accessible description joins its lines with spaces). This
    // task's agent is running, so its window would offer a Kangentic browser,
    // and the card offers it too.
    await expect(prLink).toHaveAccessibleDescription(/^PR #287 /);
    await expect(prLink).toHaveAccessibleDescription(/open/);
    await expect(prLink).toHaveAccessibleDescription(/Open in default browser \(Click\)/);
    // Ctrl off a Mac, Cmd on one: the chip is drawn for the platform.
    await expect(prLink).toHaveAccessibleDescription(/Open in Kangentic browser \((Ctrl|⌘)\+Click\)/u);
  });

  test('a task with no running agent has one row, and a click and a Ctrl+click both open the default browser', async () => {
    // Readiness "blocked" is seeded with no session, so it has no Kangentic browser to offer.
    const prLink = page.locator('[data-task-id="task-readiness-blocked"] [data-testid="task-card-pr-link"]');
    await page.evaluate(() => {
      window.__openedExternalUrls = [];
      window.electronAPI.shell.openExternal = async (url: string) => {
        window.__openedExternalUrls?.push(url);
      };
    });
    try {
      await prLink.hover();
      const tip = page.locator('[data-shape="stack"]').filter({ has: page.locator('[data-tooltip-row]') });
      await expect(tip).toBeVisible({ timeout: 5000 });
      await expect(tip.locator('[data-tooltip-row]')).toHaveCount(1);
      await expect(tip.locator('[data-tooltip-row]')).toHaveAttribute('data-tooltip-row', 'default-browser');

      await prLink.click();
      // The click that opens the other browser: Ctrl, or Cmd on a Mac.
      await prLink.click({ modifiers: ['ControlOrMeta'] });

      // Neither click opens the task window: the pill stops the card's own click.
      await expect
        .poll(() => page.evaluate(() => window.__openedExternalUrls))
        .toEqual(['https://github.com/owner/repo/pull/302', 'https://github.com/owner/repo/pull/302']);
      await expect(page.locator('[data-testid="task-detail-dialog"]')).toHaveCount(0);
    } finally {
      await page.evaluate(() => {
        window.electronAPI.shell.openExternal = async () => {
          return;
        };
      });
    }
  });

  test('a running task: a click opens the default browser, and a Ctrl+click opens its window and loads the PR in its Kangentic browser', async () => {
    const prLink = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator('[data-testid="task-card-pr-link"]');
    await page.evaluate(() => {
      window.__openedExternalUrls = [];
      window.electronAPI.shell.openExternal = async (url: string) => {
        window.__openedExternalUrls?.push(url);
      };
    });
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    try {
      await prLink.hover();
      const tip = page.locator('[data-shape="stack"]').filter({ has: page.locator('[data-tooltip-row]') });
      await expect(tip).toBeVisible({ timeout: 5000 });
      await expect(tip.locator('[data-tooltip-row]')).toHaveCount(2);
      await expect(tip.locator('[data-tooltip-row]').first()).toHaveAttribute('data-tooltip-row', 'default-browser');
      await expect(tip.locator('[data-tooltip-row]').last()).toHaveAttribute('data-tooltip-row', 'kangentic-browser');

      // A plain click: the default browser, and the card does not open.
      await prLink.click();
      await expect
        .poll(() => page.evaluate(() => window.__openedExternalUrls))
        .toEqual(['https://github.com/owner/repo/pull/287']);
      await expect(dialog).toHaveCount(0);

      // Ctrl+click: the task's window opens, and its Browser pane takes the link.
      await prLink.click({ modifiers: ['ControlOrMeta'] });
      await expect(dialog).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('browser-url-input')).toHaveValue('https://github.com/owner/repo/pull/287', { timeout: 10000 });
      // The pane took the link, so nothing more went to the default browser.
      // That the fallback timer is cancelled with it is pinned in
      // tests/unit/task-link-browser.test.ts, which does not wait it out.
      expect(await page.evaluate(() => window.__openedExternalUrls)).toEqual(['https://github.com/owner/repo/pull/287']);
    } finally {
      await page.evaluate(() => {
        window.electronAPI.shell.openExternal = async () => {
          return;
        };
      });
      // The page is shared: leave no window open for the next test.
      if (await dialog.count() > 0) {
        await page.locator('[data-testid="task-detail-close"]').click();
        await expect(dialog).toHaveCount(0, { timeout: 10000 });
      }
    }
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

    await dialog.locator('[aria-label="Actions"]').click();
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

test.describe('PR merge readiness tints the pill', () => {
  const pillFor = (taskId: string) =>
    page.locator(`[data-task-id="${taskId}"] [data-testid="task-card-pr-link"]`);

  test('ready keeps the open green, and the tooltip names the caveat after the action', async () => {
    const pill = pillFor('task-readiness-ready');
    await expect(pill).toHaveText('PR #301');
    await expect(pill).toHaveClass(/text-emerald-400/);
    await expect(pill).toHaveAccessibleDescription(/^PR #301 /);
    await expect(pill).toHaveAccessibleDescription(/last PR refresh/);
  });

  test('blocked is amber', async () => {
    const pill = pillFor('task-readiness-blocked');
    await expect(pill).toHaveClass(/text-amber-400/);
    await expect(pill).toHaveAccessibleDescription(/Merge blocked/);
  });

  test('conflicts is red with the conflict glyph, not the grey closed uses', async () => {
    const pill = pillFor('task-readiness-conflicting');
    await expect(pill).toHaveClass(/text-red-400/);
    await expect(pill.locator('.lucide-git-merge-conflict')).toBeVisible();
    await expect(pill).toHaveAccessibleDescription(/Merge conflicts/);
  });

  test('failing is red, still, and its tooltip names the failed check', async () => {
    const pill = pillFor('task-readiness-failing');
    await expect(pill).toHaveAttribute('data-pr-readiness', 'failing');
    await expect(pill).toHaveClass(/text-red-400/);
    await expect(pill.locator('.kng-pr-pulse')).toHaveCount(0);
    await expect(pill).toHaveAccessibleDescription(/A check or build failed as of the last PR refresh/);
  });

  test('a pending unknown verdict keeps plain open', async () => {
    const pill = pillFor('task-readiness-unknown');
    await expect(pill).toHaveClass(/text-emerald-400/);
    await expect(pill).not.toHaveAccessibleDescription(/last PR refresh/);
  });

  test('queued and running are sky with a pulsing edge, so a check in flight reads as progress', async () => {
    for (const taskId of ['task-readiness-queued', 'task-readiness-running']) {
      const pill = pillFor(taskId);
      await expect(pill).toHaveClass(/text-sky-400/);
      await expect(pill.locator('.kng-pr-pulse')).toHaveCount(1);
    }
    await expect(pillFor('task-readiness-queued')).toHaveAccessibleDescription(/queued as of the last PR refresh/);
    await expect(pillFor('task-readiness-running')).toHaveAccessibleDescription(/running as of the last PR refresh/);
    await expect(pillFor('task-readiness-ready').locator('.kng-pr-pulse')).toHaveCount(0);
  });

  test('a stale verdict on a merged PR never shows through', async () => {
    const pill = pillFor('task-readiness-stale-merged');
    await expect(pill).toHaveClass(/text-purple-400/);
    await expect(pill.locator('.lucide-git-merge')).toBeVisible();
    await expect(pill).not.toHaveAccessibleDescription(/last PR refresh/);
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

    await dialog.locator('[aria-label="Actions"]').click();
    await expect(page.getByRole('button', { name: 'Refresh PR', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View PR #301', exact: true })).toBeVisible();

    // Same close as the header test above: Control+Shift+W, since a running
    // session's xterm can intercept a bubble-phase Escape.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+W');
    await expect(dialog).not.toBeVisible({ timeout: 8000 });
  });
});
