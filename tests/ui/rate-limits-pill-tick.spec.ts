/**
 * The rate-limits pill's own 30s tick.
 *
 * `RateLimitsPill` (ContextBar.tsx) keeps a `now` that a 30s interval advances.
 * Each tick does two things with no new usage report arriving: it expires a
 * window whose `resetsAt` has passed while the pill is on screen, and it moves
 * every bar's time marker. The session store's merge prunes lapsed windows only
 * when a report lands, so without the interval a window that was open at mount
 * would stay on screen after its reset.
 *
 * `rate-limits-sync.spec.ts` seeds windows that were already lapsed when the
 * pill mounted. Those pass with the interval deleted, because the pill filters
 * on its first render too. Every case here starts with windows that are OPEN
 * at mount, opens the pill, and only then moves page time with Playwright's
 * fake clock, so only the tick can account for the change.
 *
 * The clock is installed before the app boots (it can only fake timers the page
 * creates after it) and is never paused, so the app boots and animates in real
 * time until a test calls `page.clock.fastForward`. It jumps rather than runs:
 * `runFor` fires every timer the app has in between, and one simulated minute
 * took about 5.7s of real time against the UI project's 15s budget. `fastForward`
 * fires each due timer once, at the new time, which is all the 30s interval needs.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

// Each case launches its own browser, so the file's tests can fan out across the UI workers.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-rate-limits-tick';
const TASK_ID = 'task-rate-limits-tick';
const SESSION_ID = 'sess-rate-limits-tick';
const SWIMLANE_ID = 'lane-rate-limits-tick';

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

/** The pill's refresh interval, mirrored from ContextBar.tsx. Each case jumps page time by a multiple of it. */
const PILL_TICK_MS = 30_000;

/**
 * The session's rateLimits as a JavaScript array expression, evaluated inside
 * the page's `getUsage` stub, where `seededNowSeconds` is in scope. That value
 * is read once, from the page's (fake) clock, so every call to the stub anchors
 * to the same instant and the windows keep their resetsAt however often the
 * store asks.
 */
interface SeededWindows {
  rateLimits: string;
}

/**
 * A 5h window that resets two minutes after the page loads, beside a 7d window
 * days away. Two minutes is long enough that a slow boot cannot lapse it before
 * the pill mounts, and short enough that a fake-clock jump of a few minutes
 * crosses it.
 */
const FIVE_HOUR_LAPSES_SEED: SeededWindows = {
  rateLimits: `[
    { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 73, resetsAt: seededNowSeconds + 120, windowDurationSeconds: ${FIVE_HOUR_SECONDS} },
    { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 41, resetsAt: seededNowSeconds + 86400 * 5, windowDurationSeconds: ${SEVEN_DAY_SECONDS} },
  ]`,
};

/** The same two windows, with the 7d one lapsing too, so the whole pill empties. */
const BOTH_LAPSE_SEED: SeededWindows = {
  rateLimits: `[
    { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 73, resetsAt: seededNowSeconds + 120, windowDurationSeconds: ${FIVE_HOUR_SECONDS} },
    { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 41, resetsAt: seededNowSeconds + 180, windowDurationSeconds: ${SEVEN_DAY_SECONDS} },
  ]`,
};

/** One 5h window an hour from its reset, so ~80% of it has elapsed and nothing lapses during a short jump. */
const ONE_LONG_WINDOW_SEED: SeededWindows = {
  rateLimits: `[
    { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 73, resetsAt: seededNowSeconds + 3600, windowDurationSeconds: ${FIVE_HOUR_SECONDS} },
  ]`,
};

/** One project with one running Claude task whose usage cache carries `seededWindows`. */
function makePreConfig(seededWindows: SeededWindows): string {
  return `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Rate Limits Tick',
        path: '/mock/rate-limits-tick',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });

      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = index === 0 ? '${SWIMLANE_ID}' : state.uuid();
        state.swimlanes.push({
          id: id,
          name: swimlane.name,
          role: swimlane.role,
          color: swimlane.color,
          icon: swimlane.icon,
          is_archived: swimlane.is_archived,
          permission_strategy: swimlane.permission_strategy ?? null,
          auto_spawn: swimlane.auto_spawn ?? false,
          position: index,
          created_at: timestamp,
        });
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/rate-limits-tick',
        startedAt: timestamp,
        exitCode: null,
      });
      state.activityCache['${SESSION_ID}'] = 'idle';

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Rate limits tick task',
        description: '',
        swimlane_id: '${SWIMLANE_ID}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });

    var seededNowSeconds = Math.floor(Date.now() / 1000);
    window.electronAPI.sessions.getUsage = async function () {
      var result = {};
      result['${SESSION_ID}'] = {
        model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
        contextWindow: { usedPercentage: 25, usedTokens: 1500, cacheTokens: 0, totalInputTokens: 1000, totalOutputTokens: 500, contextWindowSize: 200000 },
        cost: { totalCostUsd: 0.01, totalDurationMs: 5000 },
        rateLimits: ${seededWindows.rateLimits},
      };
      return result;
    };
  `;
}

/** Launch with the fake clock installed before the app boots, so the pill's interval is a fake timer. */
async function launchWithClock(seededWindows: SeededWindows): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.clock.install();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(makePreConfig(seededWindows));
    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/**
 * Open the task window and return its rate-limits pill. The pill has to be on
 * screen BEFORE page time moves: one opened afterwards reads the new time when
 * it mounts and would pass with no interval at all.
 */
async function openPill(page: Page) {
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator(`[data-task-id="${TASK_ID}"]`).first().click();
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });
  const contextBar = page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"].min-h-8');
  await expect(contextBar).toBeVisible({ timeout: 10000 });
  return contextBar.locator('[data-testid="rate-limits-pill"]');
}

/** How many windows the session store's shared snapshot holds, which only a usage report (never a tick) changes. */
async function storedWindowCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores: { session: { getState: () => { latestRateLimits: { rateLimits: unknown[] } | null } } };
    }).__zustandStores;
    return stores.session.getState().latestRateLimits?.rateLimits.length ?? 0;
  });
}

test.describe('Rate limits pill tick', () => {
  test('a window that is open when the pill mounts leaves it on the next tick after its reset', async () => {
    const { browser, page } = await launchWithClock(FIVE_HOUR_LAPSES_SEED);
    try {
      const pill = await openPill(page);
      const fills = pill.locator('span.block.h-full.rounded-full');
      await expect(fills).toHaveCount(2);
      await expect(pill).toContainText('73%');
      await expect(pill).toContainText('41%');
      expect(await storedWindowCount(page)).toBe(2);

      // Jump page time well past the 5h window's reset (two minutes out) and nowhere near
      // the 7d one's. `fastForward` fires the due 30s interval once, at the new time, the
      // way a laptop waking from sleep would. No usage report arrives while the clock
      // moves, so only the pill's own tick can react.
      await page.clock.fastForward(PILL_TICK_MS * 5);

      await expect(fills).toHaveCount(1);
      await expect(pill).toContainText('41%');
      await expect(pill).not.toContainText('73%');
      expect(await fills.first().evaluate((fillElement) => (fillElement as HTMLElement).style.width)).toBe('41%');
      await expect(pill.locator('[data-testid="rate-limit-time-marker"]')).toHaveCount(1);
      const description = await pill.getAttribute('aria-description');
      expect(description).toContain('7d weekly');
      expect(description).not.toContain('5h session');

      // The shared snapshot still holds both windows, so the pill did the pruning itself.
      expect(await storedWindowCount(page)).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('the pill leaves the bar once its last open window has lapsed', async () => {
    const { browser, page } = await launchWithClock(BOTH_LAPSE_SEED);
    try {
      const pill = await openPill(page);
      await expect(pill.locator('span.block.h-full.rounded-full')).toHaveCount(2);

      await page.clock.fastForward(PILL_TICK_MS * 8);

      await expect(page.locator('[data-testid="rate-limits-pill"]')).toHaveCount(0);
      // The tick, not a report, emptied it: the store still holds both lapsed windows.
      expect(await storedWindowCount(page)).toBe(2);
    } finally {
      await browser.close();
    }
  });

  test('the time marker moves right on the tick by the share of the window that passed', async () => {
    const { browser, page } = await launchWithClock(ONE_LONG_WINDOW_SEED);
    try {
      const pill = await openPill(page);
      const marker = pill.locator('[data-testid="rate-limit-time-marker"]');
      await expect(marker).toHaveCount(1);
      const readMarkerLeft = () => marker.evaluate((markerElement) => parseFloat((markerElement as HTMLElement).style.left));

      // resetsAt is an hour out of a five-hour window: about 80% of it has elapsed.
      const leftBefore = await readMarkerLeft();
      expect(leftBefore).toBeGreaterThan(75);
      expect(leftBefore).toBeLessThan(85);

      // One minute of page time passes and the interval fires once at the new time. The
      // marker reads the `now` that tick sets, so it moves by 60s of an 18000s window,
      // about 0.33 percentage points, with a tolerance wide enough to absorb the real
      // time the clock also flows through.
      await page.clock.fastForward(PILL_TICK_MS * 2);

      await expect.poll(async () => (await readMarkerLeft()) - leftBefore, { timeout: 5000 }).toBeGreaterThan(0.2);
      const movedBy = (await readMarkerLeft()) - leftBefore;
      expect(movedBy).toBeLessThan(0.6);
      // Nothing lapsed: the bar is still there.
      await expect(pill.locator('span.block.h-full.rounded-full')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });
});
