/**
 * UI tests for the usage statistics dashboard: the full-surface overlay opened
 * from the title-bar chart button (Mod+Shift+U), which replaced the old
 * status-bar usage strip.
 *
 * Covers: open/close paths (button, Escape, keybinding), the shared
 * range/scope filter behavior (refetch args via the mock's
 * `__getDashboardStatsCalls` log + persistence via config), the bug #316
 * regression (the selected range survives a project switch and the refetch
 * carries the NEW project id), graceful degradation (empty payloads, agents
 * that report no cost / no model id), and the no-project all-projects lock.
 *
 * Each test launches its own browser (no cross-test state).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A = 'proj-usage-a';
const PROJECT_B = 'proj-usage-b';

/** Two projects so the #316 regression can switch between them. */
function twoProjectPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      [
        { id: '${PROJECT_A}', name: 'Usage Alpha', path: '/mock/usage-a' },
        { id: '${PROJECT_B}', name: 'Usage Beta', path: '/mock/usage-b' },
      ].forEach(function (proj) {
        state.projects.push({
          id: proj.id,
          name: proj.name,
          path: proj.path,
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });
      });

      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        state.swimlanes.push({
          id: 'lane-usage-' + index,
          name: lane.name,
          role: lane.role,
          color: lane.color,
          icon: lane.icon,
          is_archived: lane.is_archived,
          permission_strategy: lane.permission_strategy || null,
          auto_spawn: lane.auto_spawn || false,
          position: index,
          created_at: ts,
        });
      });

      return { currentProjectId: '${PROJECT_A}' };
    });
  `;
}

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

async function openDashboard(page: Page): Promise<void> {
  await page.locator('[data-testid="usage-stats-button"]').click();
  await page.locator('[data-testid="stats-page"]').waitFor({ state: 'visible', timeout: 10000 });
}

type RecordedCall = {
  scope: { kind: string; projectId?: string };
  period: string;
  drill: { dayStartMs: number } | null;
};

function getCalls(page: Page): Promise<RecordedCall[]> {
  return page.evaluate(() => {
    const api = (window as unknown as {
      electronAPI: { usage: { __getDashboardStatsCalls: RecordedCall[] } };
    }).electronAPI;
    return api.usage.__getDashboardStatsCalls;
  });
}

test.describe('usage dashboard', () => {
  test('opens from the title-bar button, closes via X, Escape, and the keybinding toggles', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Button opens; the default fixture populates tiles and charts. The
      // default period is Live, whose token/cost tiles show live-session
      // usage only (none here), so assert on a payload-driven tile.
      await openDashboard(page);
      await expect(page.locator('[data-testid="kpi-tool-calls-value"]')).toContainText('315', { timeout: 10000 });
      await expect(page.locator('[data-testid="kpi-sessions"]')).toBeVisible();
      await expect(page.locator('[data-testid="chart-burn-rate"]')).toBeVisible();

      // X closes.
      await page.locator('[data-testid="stats-close"]').click();
      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'hidden', timeout: 5000 });

      // Escape closes.
      await openDashboard(page);
      await page.keyboard.press('Escape');
      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'hidden', timeout: 5000 });

      // The registered keybinding toggles open and closed.
      await page.keyboard.press('Control+Shift+U');
      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.keyboard.press('Control+Shift+U');
      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'hidden', timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('range selection refetches with the new period and persists to config', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      await page.locator('[data-testid="stats-period-group"] button:has-text("This Week")').click();

      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          const last = calls[calls.length - 1];
          return last ? `${last.scope.kind}:${last.scope.projectId ?? ''}:${last.period}` : '';
        }, { timeout: 5000 })
        .toBe(`project:${PROJECT_A}:week`);

      // Persisted as the global usageStatsPeriod preference.
      await expect
        .poll(async () => page.evaluate(async () => {
          const config = await (window as unknown as {
            electronAPI: { config: { get: () => Promise<{ usageStatsPeriod?: string }> } };
          }).electronAPI.config.get();
          return config.usageStatsPeriod ?? '';
        }), { timeout: 5000 })
        .toBe('week');
    } finally {
      await browser.close();
    }
  });

  test('scope select switches between named projects and the app-wide rollup', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // The scope picker pill shows the current project by NAME; its popover
      // pins All Projects above the project list.
      const trigger = page.locator('[data-testid="stats-scope-trigger"]');
      await expect(trigger).toContainText('Usage Alpha');
      await trigger.click();
      await page.locator('[data-testid="stats-scope-option-all"]').click();

      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          return calls[calls.length - 1]?.scope.kind ?? '';
        }, { timeout: 5000 })
        .toBe('all');
      await expect(trigger).toContainText('All Projects');

      // The default all-scope fixture carries per-project sub-totals.
      await expect(page.locator('[data-testid="per-project-table"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="per-project-row"]').first()).toBeVisible();

      // Pick the OTHER project by name: views its stats WITHOUT switching the
      // app's current project, and the table disappears.
      await trigger.click();
      await page.locator('[data-testid="stats-scope-option-project"]:has-text("Usage Beta")').click();
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          const last = calls[calls.length - 1];
          return `${last?.scope.kind ?? ''}:${last?.scope.projectId ?? ''}`;
        }, { timeout: 5000 })
        .toBe(`project:${PROJECT_B}`);
      await expect(trigger).toContainText('Usage Beta');
      await expect(page.locator('[data-testid="per-project-table"]')).not.toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('per-project table sorts both directions, clears on the third click, and shift-click adds a tie-break level', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);
      await page.locator('[data-testid="stats-scope-trigger"]').click();
      await page.locator('[data-testid="stats-scope-option-all"]').click();
      await expect(page.locator('[data-testid="per-project-table"]')).toBeVisible({ timeout: 10000 });

      const firstRow = page.locator('[data-testid="per-project-row"]').first();
      const tokensInHeader = page.locator('[data-testid="per-project-table"] th').filter({ hasText: 'Tokens In' });

      // Numeric columns start descending (Mock Project has the most input tokens)...
      await tokensInHeader.click();
      await expect(firstRow).toContainText('Mock Project');
      // ...a second click flips to ASCENDING. This direction used to be
      // unreachable: the old cycle was anchored to asc-first, so numeric
      // columns went desc -> clear and never offered ascending.
      await tokensInHeader.click();
      await expect(firstRow).toContainText('Other Project');
      // ...and a third click clears back to payload order.
      await tokensInHeader.click();
      await expect(firstRow).toContainText('Mock Project');

      // Shift+Click adds a second sort level; both headers show a priority.
      await tokensInHeader.click();
      await page
        .locator('[data-testid="per-project-table"] th')
        .filter({ hasText: /^Cost$/ })
        .click({ modifiers: ['Shift'] });
      await expect(page.locator('[data-testid="sort-priority"]')).toHaveCount(2);
    } finally {
      await browser.close();
    }
  });

  test('the custom month-window picker applies a bounded range, survives scope cycling, and clears via the period pills', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // Pick "two months ago" through "last month" (stable relative to now).
      const nowDate = new Date();
      const fromDate = new Date(nowDate.getFullYear(), nowDate.getMonth() - 2, 1);
      const toDate = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1);
      const expectedSinceMs = fromDate.getTime();
      const expectedUntilMs = new Date(toDate.getFullYear(), toDate.getMonth() + 1, 1).getTime();

      await page.locator('[data-testid="stats-custom-trigger"]').click();
      await page.locator('select[data-testid="stats-custom-from"]').selectOption(`${fromDate.getFullYear()}-${fromDate.getMonth()}`);
      await page.locator('select[data-testid="stats-custom-to"]').selectOption(`${toDate.getFullYear()}-${toDate.getMonth()}`);
      await page.locator('[data-testid="stats-custom-apply"]').click();

      // The refetch carries the window and the applied chip renders.
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          const last = calls[calls.length - 1];
          return `${last?.customWindow?.sinceMs ?? 'none'}:${last?.customWindow?.untilMs ?? 'none'}`;
        }, { timeout: 5000 })
        .toBe(`${expectedSinceMs}:${expectedUntilMs}`);
      await expect(page.locator('[data-testid="stats-custom-clear"]')).toBeVisible();

      // Scope cycling PRESERVES the window (compare the same span across projects).
      await page.locator('[data-testid="stats-scope-trigger"]').click();
      await page.locator('[data-testid="stats-scope-option-all"]').click();
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          const last = calls[calls.length - 1];
          return `${last?.scope.kind ?? ''}:${last?.customWindow?.sinceMs ?? 'none'}`;
        }, { timeout: 5000 })
        .toBe(`all:${expectedSinceMs}`);

      // A quick period pill returns to the full range.
      await page.locator('[data-testid="stats-period-group"] button:has-text("Today")').click();
      await expect(page.locator('[data-testid="stats-custom-clear"]')).not.toBeVisible({ timeout: 5000 });
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          return calls[calls.length - 1]?.customWindow === null;
        }, { timeout: 5000 })
        .toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('the Cost/Tokens metric re-keys the breakdown donuts (center total follows the toggle)', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // Default metric is Cost (the fixture reports cost): the by-agent donut
      // center shows the dimension's LEADER and its cost share
      // (claude $11.00 of $12.34 = 89%).
      await expect(page.locator('[data-testid="breakdown-agent"]')).toContainText('89%', { timeout: 10000 });

      // Switching to Tokens re-keys the share to the token split (claude 166k
      // of 192k = 86%); the per-slice cost column stays visible either way.
      await page.locator('[data-testid="stats-metric-group"] button:has-text("Tokens")').click();
      await expect(page.locator('[data-testid="breakdown-agent"]')).toContainText('86%');
      await expect(page.locator('[data-testid="breakdown-agent"]')).not.toContainText('89%');
      await expect(page.locator('[data-testid="breakdown-agent-row"]').first()).toContainText('$11.00');
    } finally {
      await browser.close();
    }
  });

  test('clicking a daily bar drills into that day and the chip returns to the base range', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // Live's per-bucket cards are never drillable (5-minute buckets), so
      // switch to a non-Live period first. The default fixture's cost buckets
      // are daily regardless of period, so the stacked bars stay drillable.
      await page.locator('[data-testid="stats-period-group"] button:has-text("This Week")').click();
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          return calls[calls.length - 1]?.period ?? '';
        }, { timeout: 5000 })
        .toBe('week');

      // Click a bar segment.
      await page.locator('[data-testid="chart-daily"] .recharts-rectangle').first().click();

      // Drill chip appears and the refetch carries the drill day.
      await expect(page.locator('[data-testid="stats-drill-chip"]')).toBeVisible({ timeout: 5000 });
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          return typeof calls[calls.length - 1]?.drill?.dayStartMs === 'number';
        }, { timeout: 5000 })
        .toBe(true);

      // Cycling the SCOPE keeps the drilled day (one day compared across
      // projects): the refetch for the new scope still carries the drill.
      await page.locator('[data-testid="stats-scope-trigger"]').click();
      await page.locator('[data-testid="stats-scope-option-all"]').click();
      await expect(page.locator('[data-testid="stats-drill-chip"]')).toBeVisible();
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          const last = calls[calls.length - 1];
          return `${last?.scope.kind ?? ''}:${typeof last?.drill?.dayStartMs === 'number'}`;
        }, { timeout: 5000 })
        .toBe('all:true');

      // The chip clears the drill and returns to the base range. No new IPC
      // call is expected here: the base payload is still fresh in the store's
      // cache, so the return repaints instantly from it (the snappiness
      // contract) - assert on the store instead.
      await page.locator('[data-testid="stats-drill-chip"]').click();
      await expect(page.locator('[data-testid="stats-drill-chip"]')).not.toBeVisible({ timeout: 5000 });
      await expect
        .poll(async () => page.evaluate(() => {
          const stores = (window as unknown as {
            __zustandStores?: { usageDashboard: { getState: () => { drill: unknown } } };
          }).__zustandStores;
          return stores ? stores.usageDashboard.getState().drill === null : false;
        }), { timeout: 5000 })
        .toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('bug #316 regression: the selected range survives a project switch and the refetch carries the new project id', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // Pick a non-default range.
      const weekButton = page.locator('[data-testid="stats-period-group"] button:has-text("This Week")');
      await weekButton.click();
      await expect(weekButton).toHaveClass(/bg-surface-raised/);

      // Close the overlay (it covers the sidebar) and switch projects.
      await page.locator('[data-testid="stats-close"]').click();
      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'hidden', timeout: 5000 });
      await page.locator('[role="button"]:has-text("Usage Beta")').click();

      // Reopen: the range MUST still be "This Week" (the old status-bar bug
      // reverted it to Live and/or kept the previous project's data), and the
      // refetch must target the NEW project with that same range.
      await openDashboard(page);
      await expect(weekButton).toHaveClass(/bg-surface-raised/);
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          const last = calls[calls.length - 1];
          return last ? `${last.scope.kind}:${last.scope.projectId ?? ''}:${last.period}` : '';
        }, { timeout: 5000 })
        .toBe(`project:${PROJECT_B}:week`);
    } finally {
      await browser.close();
    }
  });

  test('renders friendly empty states when nothing is recorded', async () => {
    const emptyFixture = `
      (function () {
        window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
          var now = Date.now();
          return {
            scope: scope,
            period: period,
            rangeStartMs: now - 3600000,
            rangeEndMs: now,
            bucketSizeMs: 3600000,
            costBucketSizeMs: 86400000,
            generatedAtMs: now,
            kpis: {
              totalCostUsd: 0, costKnown: false,
              totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
              sessionCount: 0, toolCallCount: 0,
              linesAdded: 0, linesRemoved: 0, filesChanged: 0,
              compactionCount: 0, totalDurationMs: 0,
              turnInputTokens: 0, turnOutputTokens: 0,
              cacheCreationTokens: 0, cacheReadTokens: 0,
              burnRateTokensPerHour: null, burnRateUsdPerHour: null,
            },
            previousKpis: null,
            tokenSeries: [],
            costSeries: [],
            byModel: [],
            byAgent: [],
            byEffort: [],
          };
        };
      })();
    `;
    const { browser, page } = await launchWithState(twoProjectPreConfig() + emptyFixture);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      await expect(page.locator('[data-testid="kpi-tokens-value"]')).toContainText('0', { timeout: 10000 });
      await expect(page.locator('[data-testid="kpi-cost-value"]')).toContainText('$0.00');
      await expect(page.locator('[data-testid="chart-burn-rate"]')).toContainText('No agent turns recorded');
      await expect(page.locator('[data-testid="breakdown-model"]')).toContainText('No usage recorded yet');
    } finally {
      await browser.close();
    }
  });

  test('degrades gracefully for agents that report no cost and no model id', async () => {
    const degradedFixture = `
      (function () {
        window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
          var now = Date.now();
          var hour = 3600000;
          return {
            scope: scope,
            period: period,
            rangeStartMs: now - 3 * hour,
            rangeEndMs: now,
            bucketSizeMs: hour,
            costBucketSizeMs: 24 * hour,
            generatedAtMs: now,
            kpis: {
              totalCostUsd: 0, costKnown: false,
              totalInputTokens: 5000, totalOutputTokens: 2000, totalTokens: 7000,
              sessionCount: 2, toolCallCount: 12,
              linesAdded: 10, linesRemoved: 2, filesChanged: 3,
              compactionCount: 0, totalDurationMs: hour,
              turnInputTokens: 4000, turnOutputTokens: 1500,
              cacheCreationTokens: 100, cacheReadTokens: 900,
              burnRateTokensPerHour: 1800, burnRateUsdPerHour: null,
            },
            previousKpis: null,
            tokenSeries: [
              { bucketStartMs: now - 2 * hour, inputTokens: 2000, outputTokens: 800, cacheCreationTokens: 50, cacheReadTokens: 400, allocatedCostUsd: 0, turnCount: 3 },
              { bucketStartMs: now - hour, inputTokens: 2000, outputTokens: 700, cacheCreationTokens: 50, cacheReadTokens: 500, allocatedCostUsd: 0, turnCount: 4 },
            ],
            costSeries: [
              { bucketStartMs: now - 24 * hour, costUsd: 0, inputTokens: 5000, outputTokens: 2000, sessionCount: 2, byModel: [
                { modelId: null, costUsd: 0, inputTokens: 5000, outputTokens: 2000 },
              ] },
            ],
            byModel: [
              { modelId: null, modelDisplayName: null, inputTokens: 5000, outputTokens: 2000, costUsd: 0, sessionCount: 2 },
            ],
            byAgent: [
              { agent: 'aider', inputTokens: 5000, outputTokens: 2000, costUsd: 0, sessionCount: 2 },
            ],
            byEffort: [
              { effort: null, inputTokens: 5000, outputTokens: 2000, costUsd: 0, sessionCount: 2 },
            ],
          };
        };
      })();
    `;
    const { browser, page } = await launchWithState(twoProjectPreConfig() + degradedFixture);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // No cost reported: the Cost/Tokens metric toggle is hidden (tokens
      // forced), the burn tile falls back to tokens/hr (the '/hr' unit is a
      // muted suffix beside the hero value), and the cumulative card retitles
      // to tokens.
      await expect(page.locator('[data-testid="kpi-burn-rate-value"]')).toContainText('tok', { timeout: 10000 });
      await expect(page.locator('[data-testid="kpi-burn-rate-value"]')).not.toContainText('$');
      await expect(page.locator('[data-testid="kpi-burn-rate"]')).toContainText('/hr');
      await expect(page.locator('[data-testid="stats-metric-group"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="chart-cumulative"]')).toContainText('Cumulative tokens');

      // A null model id renders as "(unknown)" in the breakdown list; a null
      // effort renders as "(default)" (a real bucket, not missing data).
      // Agent ids render as product-style short names ('aider' -> 'Aider').
      await expect(page.locator('[data-testid="breakdown-model-row"]').first()).toContainText('(unknown)');
      await expect(page.locator('[data-testid="breakdown-agent-row"]').first()).toContainText('Aider');
      await expect(page.locator('[data-testid="breakdown-effort-row"]').first()).toContainText('(default)');
    } finally {
      await browser.close();
    }
  });

  test('Cost hero sparkline populates in Live from turn-derived cost, not the empty session ledger', async () => {
    // Live has no finalized costSeries yet (the session ledger only writes on
    // completion), but tokenSeries carries turn-allocated cost as it happens.
    // KngSparkline renders nothing for fewer than 2 points, so an empty
    // costSeries with a populated tokenSeries is the exact real-world shape
    // that previously left the Cost hero tile's sparkline blank in Live.
    const liveFixture = `
      (function () {
        window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
          var now = Date.now();
          var hour = 3600000;
          return {
            scope: scope,
            period: period,
            rangeStartMs: now - 2 * hour,
            rangeEndMs: now,
            bucketSizeMs: hour,
            costBucketSizeMs: 24 * hour,
            generatedAtMs: now,
            kpis: {
              totalCostUsd: 1.75, costKnown: true,
              totalInputTokens: 4000, totalOutputTokens: 1500, totalTokens: 5500,
              sessionCount: 1, toolCallCount: 9,
              linesAdded: 4, linesRemoved: 1, filesChanged: 2,
              compactionCount: 0, totalDurationMs: hour,
              turnInputTokens: 4000, turnOutputTokens: 1500,
              cacheCreationTokens: 0, cacheReadTokens: 0,
              burnRateTokensPerHour: 5500, burnRateUsdPerHour: 1.75,
            },
            previousKpis: null,
            tokenSeries: [
              { bucketStartMs: now - 2 * hour, inputTokens: 2000, outputTokens: 800, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 1.0, turnCount: 4 },
              { bucketStartMs: now - hour, inputTokens: 2000, outputTokens: 700, cacheCreationTokens: 0, cacheReadTokens: 0, allocatedCostUsd: 0.75, turnCount: 5 },
            ],
            costSeries: [],
            byModel: [],
            byAgent: [],
            byEffort: [],
          };
        };
      })();
    `;
    const { browser, page } = await launchWithState(twoProjectPreConfig() + liveFixture);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      // Default period on open is Live (see the first test's comment above).
      // The Cost hero VALUE in Live is sourced from the in-memory running
      // session aggregate, not this payload (there is no running session
      // here, so it reads $0.00) - only the sparkline is payload-derived, so
      // that is the one assertion this test needs.
      await openDashboard(page);

      await expect(page.locator('[data-testid="kpi-cost"] .recharts-area-area')).toBeVisible({ timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  test('Live default period fills the token-type and cumulative cards from tokenSeries, disables per-bucket drilling, and uses token-count empty messages', async () => {
    // Phase 1: default (non-empty) fixture at the default Live period. Both
    // cards read from tokenSeries (the bug this diff fixes: costSeries is
    // empty in Live, so both previously rendered empty placeholders). The
    // left card retitles to a token-type stack with its own legend, and
    // NEITHER card is drillable (Live buckets are 5 minutes wide, so a day
    // drill is nonsense).
    {
      const { browser, page } = await launchWithState(twoProjectPreConfig());
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        // Default period on open is Live: do not switch periods here.
        await openDashboard(page);

        await expect(page.locator('[data-testid="chart-daily"]')).toContainText('Tokens by type', { timeout: 10000 });
        // The legend switches from model names to the fixed token-type labels
        // (deriveTokenTypeStack's series), the actual wiring this diff added.
        const legend = page.locator('[data-testid="chart-daily-legend"]');
        await expect(legend).toContainText('Input');
        await expect(legend).toContainText('Output');
        await expect(legend).toContainText('Cache read');
        await expect(legend).toContainText('Cache write');
        await expect(legend).not.toContainText('Mock Large');

        await page.locator('[data-testid="chart-daily"] .recharts-rectangle').first().click();
        // Bounded negative check (no bare waitForTimeout): onBucketClick is
        // undefined in Live, so nothing async could produce a drill chip
        // later; the timeout budget still covers a mistaken async wiring.
        await expect(page.locator('[data-testid="stats-drill-chip"]')).not.toBeVisible({ timeout: 2000 });

        // The Cumulative card must render the tokenSeries-derived running sum
        // (a rising area), not the empty placeholder: this is the exact card
        // that previously stayed blank in Live.
        const cumulativeCard = page.locator('[data-testid="chart-cumulative"]');
        await expect(cumulativeCard).not.toContainText('recorded');
        await expect(cumulativeCard.locator('.recharts-area-area')).toBeVisible({ timeout: 10000 });
        // Neither Live card accepts a day drill: their chart containers never
        // pick up the onBucketClick cursor-pointer affordance.
        await expect(cumulativeCard.locator('[role="img"]')).not.toHaveClass(/cursor-pointer/);
        await expect(page.locator('[data-testid="chart-daily"] [role="img"]')).not.toHaveClass(/cursor-pointer/);

        // Toggling the Cost/Tokens metric while still in Live re-keys the
        // Cumulative card's title and value source, but it must STAY
        // populated from tokenSeries either way (not silently go empty).
        await page.locator('[data-testid="stats-metric-group"] button:has-text("Tokens")').click();
        await expect(cumulativeCard).toContainText('Cumulative tokens');
        await expect(cumulativeCard).not.toContainText('recorded');
        await expect(cumulativeCard.locator('.recharts-area-area')).toBeVisible({ timeout: 10000 });
      } finally {
        await browser.close();
      }
    }

    // Phase 2: an empty tokenSeries fixture (no agent turns recorded yet).
    // Both per-bucket Live cards fall back to their tokens-aware empty
    // message; costKnown: false forces the tokens metric so the cumulative
    // card's empty message is the tokens variant, not the cost variant.
    {
      const emptyLiveFixture = `
        (function () {
          window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
            var now = Date.now();
            var hour = 3600000;
            return {
              scope: scope,
              period: period,
              rangeStartMs: now - 2 * hour,
              rangeEndMs: now,
              bucketSizeMs: hour,
              costBucketSizeMs: 86400000,
              generatedAtMs: now,
              kpis: {
                totalCostUsd: 0, costKnown: false,
                totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
                sessionCount: 0, toolCallCount: 0,
                linesAdded: 0, linesRemoved: 0, filesChanged: 0,
                compactionCount: 0, totalDurationMs: 0,
                turnInputTokens: 0, turnOutputTokens: 0,
                cacheCreationTokens: 0, cacheReadTokens: 0,
                burnRateTokensPerHour: null, burnRateUsdPerHour: null,
              },
              previousKpis: null,
              tokenSeries: [],
              costSeries: [],
              byModel: [],
              byAgent: [],
              byEffort: [],
            };
          };
        })();
      `;
      const { browser, page } = await launchWithState(twoProjectPreConfig() + emptyLiveFixture);
      try {
        await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
        await openDashboard(page);

        await expect(page.locator('[data-testid="chart-daily"]')).toContainText(
          'No agent turns recorded in the last 2 hours',
          { timeout: 10000 },
        );
        await expect(page.locator('[data-testid="chart-cumulative"]')).toContainText(
          'No tokens recorded in the last 2 hours',
        );
      } finally {
        await browser.close();
      }
    }
  });

  test('with no project open, the dashboard opens app-wide (picker reads All Projects)', async () => {
    const noProjectPreConfig = `
      window.__mockPreConfigure(function () {
        return { currentProjectId: null };
      });
    `;
    const { browser, page } = await launchWithState(noProjectPreConfig);
    try {
      await openDashboard(page);

      await expect(page.locator('[data-testid="stats-scope-trigger"]')).toContainText('All Projects');
      await expect
        .poll(async () => {
          const calls = await getCalls(page);
          return calls[calls.length - 1]?.scope.kind ?? '';
        }, { timeout: 5000 })
        .toBe('all');
    } finally {
      await browser.close();
    }
  });

  // Pop-out mutual exclusivity (see .claude/rules/pop-out-surface-registry.md):
  // the stats overlay and its detached OS window must never coexist. These two
  // tests drive the renderer's pop-out store directly via
  // window.__zustandStores.popOut (exposed dev-only in App.tsx for exactly this
  // purpose) - the same shape the real popOut:changed IPC push delivers - so the
  // AppLayout/TitleBar wiring is proven without a real second BrowserWindow.
  test('title-bar button focuses the detached stats window instead of opening the in-app overlay', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await page.evaluate(() => {
        (window as unknown as {
          __zustandStores: { popOut: { getState: () => { setOpen: (keys: string[]) => void } } };
        }).__zustandStores.popOut.getState().setOpen(['stats']);
      });

      const statsButton = page.locator('[data-testid="usage-stats-button"]');
      await expect(statsButton).toHaveAttribute('title', 'Focus usage stats window');
      await statsButton.click();

      await expect
        .poll(async () => page.evaluate(() => (window as unknown as {
          __mockPopOut: { getCalls: () => Array<{ type: string; kind: string }> };
        }).__mockPopOut.getCalls().length), { timeout: 3000 })
        .toBe(1);

      const calls = await page.evaluate(() => (window as unknown as {
        __mockPopOut: { getCalls: () => Array<{ type: string; kind: string; params: unknown }> };
      }).__mockPopOut.getCalls());
      expect(calls).toEqual([{ type: 'focus', kind: 'stats', params: {} }]);

      // Strict mutual exclusivity: the in-app overlay never mounted.
      await expect(page.locator('[data-testid="stats-page"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('the pop-out engine reporting the stats surface as detached closes an already-open in-app overlay', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // Simulates the user popping the surface out via its header button (or
      // any other trigger): the popOut:changed push reports 'stats' as open.
      // AppLayout's mutual-exclusivity effect must close the in-app overlay.
      await page.evaluate(() => {
        (window as unknown as {
          __zustandStores: { popOut: { getState: () => { setOpen: (keys: string[]) => void } } };
        }).__zustandStores.popOut.getState().setOpen(['stats']);
      });

      await page.locator('[data-testid="stats-page"]').waitFor({ state: 'hidden', timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  // The surface header's OWN pop-out control (rendered by DetachableSurfaceHeader
  // -> PopOutButton, the same shared component ChangesPanel and BrowserPane use)
  // is a separate button from the title-bar trigger above, and is untested
  // elsewhere: it is the actual mechanism a user clicks to detach a surface.
  test('the surface header pop-out button opens the detached stats window', async () => {
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      const popOutButton = page.locator('[data-testid="pop-out-button-stats"]');
      await expect(popOutButton).toBeVisible();
      await expect(popOutButton).toHaveAttribute('title', 'Open in new window');
      await popOutButton.click();

      await expect
        .poll(async () => page.evaluate(() => (window as unknown as {
          __mockPopOut: { getCalls: () => Array<{ type: string; kind: string }> };
        }).__mockPopOut.getCalls().length), { timeout: 3000 })
        .toBe(1);

      const calls = await page.evaluate(() => (window as unknown as {
        __mockPopOut: { getCalls: () => Array<{ type: string; kind: string; params: unknown }> };
      }).__mockPopOut.getCalls());
      expect(calls).toEqual([{ type: 'open', kind: 'stats', params: {} }]);
    } finally {
      await browser.close();
    }
  });
});
