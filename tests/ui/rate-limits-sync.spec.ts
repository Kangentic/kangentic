/**
 * Cross-session sync of rate-limit pill values.
 *
 * Rate limits are an account-wide value, but each session only sees its own
 * status.json updates. The renderer keeps a single `latestRateLimits`
 * snapshot in the session store, merged MONOTONICALLY per window, and every
 * `ContextBar` reads from it, so an idle agent never shows stale numbers while
 * a sibling agent shows fresh ones.
 *
 * This spec sets up two sessions with different rateLimits (sharing the same
 * `resetsAt`, so they describe the same fixed windows) in the initial usage
 * cache and asserts that the displayed percentages on a session's ContextBar
 * match the per-window MAXIMUM (the fresher snapshot), regardless of which
 * session's row is in view and regardless of iteration order.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-rate-limits-sync';
const TASK_STALE_ID = 'task-rate-limits-stale';
const TASK_FRESH_ID = 'task-rate-limits-fresh';
const SESSION_STALE_ID = 'sess-rate-limits-stale';
const SESSION_FRESH_ID = 'sess-rate-limits-fresh';
const SWIMLANE_ID = 'lane-rate-limits';

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

/**
 * Pre-configure two tasks, each backed by its own session, and seed the
 * usage cache with different rateLimits for each. The two entries share the
 * same `resetsAt` (same fixed windows), so the monotonic per-window merge keeps
 * the higher "fresh" values (73/41) as the snapshot regardless of iteration
 * order. The `getUsage` map below inserts the fresh entry FIRST specifically to
 * prove order independence (last-writer-wins would have shown the stale 18/4).
 */
function makePreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Rate Limits Sync',
        path: '/mock/rate-limits-sync',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = i === 0 ? '${SWIMLANE_ID}' : state.uuid();
        state.swimlanes.push({
          id: id,
          name: s.name,
          role: s.role,
          color: s.color,
          icon: s.icon,
          is_archived: s.is_archived,
          permission_strategy: s.permission_strategy ?? null,
          auto_spawn: s.auto_spawn ?? false,
          position: i,
          created_at: ts,
        });
      });

      ['${SESSION_STALE_ID}', '${SESSION_FRESH_ID}'].forEach(function (sessionId) {
        state.sessions.push({
          id: sessionId,
          taskId: sessionId === '${SESSION_STALE_ID}' ? '${TASK_STALE_ID}' : '${TASK_FRESH_ID}',
          projectId: '${PROJECT_ID}',
          pid: 9999,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/rate-limits-sync',
          startedAt: ts,
          exitCode: null,
        });
        state.activityCache[sessionId] = 'idle';
      });

      state.tasks.push({
        id: '${TASK_STALE_ID}',
        title: 'Stale agent task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_STALE_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      state.tasks.push({
        id: '${TASK_FRESH_ID}',
        title: 'Fresh agent task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 1,
        agent: 'claude',
        session_id: '${SESSION_FRESH_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });

    // Seed two distinct rateLimits snapshots that share the same resetsAt (same
    // fixed windows). The FRESH entry (73/41) is inserted FIRST and the stale
    // entry (18/4) LAST: the monotonic per-window merge still keeps 73/41, which
    // last-writer-wins would not have. Both entries anchor to a single captured
    // nowSeconds so the two windows line up exactly (well within the merge's
    // reset epsilon).
    window.electronAPI.sessions.getUsage = async function () {
      var nowSeconds = Math.floor(Date.now() / 1000);
      var baseUsage = {
        model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
        contextWindow: { usedPercentage: 25, usedTokens: 1500, cacheTokens: 0, totalInputTokens: 1000, totalOutputTokens: 500, contextWindowSize: 200000 },
        cost: { totalCostUsd: 0.01, totalDurationMs: 5000 },
      };
      var result = {};
      result['${SESSION_FRESH_ID}'] = Object.assign({}, baseUsage, {
        rateLimits: [
          { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 73, resetsAt: nowSeconds + 3600, windowDurationSeconds: 5 * 60 * 60 },
          { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 41, resetsAt: nowSeconds + 86400 * 5, windowDurationSeconds: 7 * 24 * 60 * 60 },
        ],
      });
      result['${SESSION_STALE_ID}'] = Object.assign({}, baseUsage, {
        rateLimits: [
          { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 18, resetsAt: nowSeconds + 3600, windowDurationSeconds: 5 * 60 * 60 },
          { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 4, resetsAt: nowSeconds + 86400 * 5, windowDurationSeconds: 7 * 24 * 60 * 60 },
        ],
      });
      return result;
    };
  `;
}

test.describe('Rate limits cross-session sync', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithState(makePreConfig()));
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('stale session ContextBar shows the fresher snapshot, not its own rateLimits', async () => {
    // Open the stale-agent task. Its own usage entry has 18%/4%, but the
    // global snapshot was last populated by the fresh-agent entry (73%/41%).
    // The pill must reflect the global snapshot.
    await page.locator(`[data-task-id="${TASK_STALE_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('73%');
    await expect(pill).toContainText('41%');
    await expect(pill).not.toContainText('18%');
    await expect(pill).not.toContainText('4%');

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('fresh session ContextBar shows the same fresher snapshot', async () => {
    await page.locator(`[data-task-id="${TASK_FRESH_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('73%');
    await expect(pill).toContainText('41%');

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('each rate-limit bar shows a time-elapsed marker positioned by time into the window', async () => {
    await page.locator(`[data-task-id="${TASK_FRESH_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    await expect(pill).toBeVisible();

    // One marker per window (5h session + 7d weekly).
    const markers = pill.locator('[data-testid="rate-limit-time-marker"]');
    await expect(markers).toHaveCount(2);

    // 5h window: resetsAt is now + 3600s of an 18000s window, so ~80% of the
    // window has elapsed. Tolerance absorbs the seconds between fixture build
    // and render, and avoids a pixel-exact assertion (cross-platform-parity).
    const fiveHourLeft = await markers.nth(0).evaluate((el) => parseFloat((el as HTMLElement).style.left));
    expect(fiveHourLeft).toBeGreaterThan(75);
    expect(fiveHourLeft).toBeLessThan(85);

    // 7d window: resetsAt is now + 5d of a 7d window, so ~28.6% has elapsed.
    const sevenDayLeft = await markers.nth(1).evaluate((el) => parseFloat((el as HTMLElement).style.left));
    expect(sevenDayLeft).toBeGreaterThan(23);
    expect(sevenDayLeft).toBeLessThan(34);

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('rate-limit fill bars stay on width, unlike the composited context and card fills', async () => {
    // ContextBar.tsx documents deliberately keeping RateLimitBar's fill on
    // `width` (unlike the context-usage fill in the same file and
    // ContextUsageFooter's board/monitor card fill, both of which moved to a
    // composited `transform: scaleX()` - see composited-meter-fill.test.ts):
    // the `minWidth: 2px` floor that keeps a barely-started window visible is
    // a width-space idea with no scale-space equivalent short of measuring
    // the track. That static scan only asserts properties of fills it FINDS
    // via `scaleX(` - a correct-looking conversion of this bar (with
    // `origin-left` and `transform` in its transition list) would just add a
    // third entry and still pass. This test guards the actual decision: the
    // fill must still be a `width` bar, and the floor that decision protects
    // (a low nonzero percentage stays visible via `minWidth: 2px`) must still
    // be there.
    await page.locator(`[data-task-id="${TASK_FRESH_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    await expect(pill).toBeVisible();

    // One fill per window (5h session at 73%, 7d weekly at 41% - see
    // makePreConfig's fresh rateLimits payload). A count other than 2 here
    // means the fill's own class list changed, which is itself the
    // conversion signal this test exists to catch.
    const fills = pill.locator('span.block.h-full.rounded-full');
    await expect(fills).toHaveCount(2);

    const fiveHourFillStyle = await fills.nth(0).evaluate((el) => ({
      width: (el as HTMLElement).style.width,
      minWidth: (el as HTMLElement).style.minWidth,
      transform: (el as HTMLElement).style.transform,
    }));
    expect(fiveHourFillStyle.width).toBe('73%');
    expect(fiveHourFillStyle.transform).toBe('');
    // Pinned even though it is visually inert at 73% (the floor only matters
    // near zero): `roundedUsedPercentage > 0` is what sets it, so its
    // presence here is what a future "why is this here" cleanup would delete
    // along with the whole `width` approach.
    expect(fiveHourFillStyle.minWidth).toBe('2px');

    const sevenDayFillStyle = await fills.nth(1).evaluate((el) => ({
      width: (el as HTMLElement).style.width,
      transform: (el as HTMLElement).style.transform,
    }));
    expect(sevenDayFillStyle.width).toBe('41%');
    expect(sevenDayFillStyle.transform).toBe('');

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('pill tooltip records the snapshot source as "Updated ... via <agent>"', async () => {
    await page.locator(`[data-task-id="${TASK_STALE_ID}"]`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
    await expect(contextBar).toBeVisible({ timeout: 10000 });

    const pill = contextBar.locator('[data-testid="rate-limits-pill"]');
    const titleAttr = await pill.getAttribute('title');
    expect(titleAttr).toBeTruthy();
    expect(titleAttr).toMatch(/Updated /);
    // The fresh task is what set the per-window maximum (sourceSessionId points
    // at SESSION_FRESH_ID; the stale entry was rejected by the merge). Its agent
    // is 'claude' so the "via" suffix resolves to 'Claude'. This asserts the
    // snapshot's sourceSessionId is wired through to the tooltip.
    expect(titleAttr).toContain('via Claude');

    await page.locator('[data-testid="task-detail-close"]').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });
});
