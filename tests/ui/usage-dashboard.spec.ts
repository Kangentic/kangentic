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

// Every test here boots a full app instance inside its own body: launchWithState()
// polls Vite, launches Chromium, loads the page, and waits up to 15000ms for the
// app, and the board-mount waitFor after it allows another 15000ms. The ui
// project's default 15000ms test budget cannot hold even one of those, so on a
// loaded machine it fired on a blank page before the app had painted. See the
// same reasoning in task-detail-archived-no-resume.spec.ts.
test.describe.configure({ mode: 'parallel', timeout: 30_000 });

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

  test('per-project table Files column renders each project\'s summed filesChanged value', async () => {
    // Bug #2 of the usage-dashboard fix: per-project filesChanged was never
    // summed/displayed. The default fixture's cost-sort keeps "Mock Project"
    // first; its Files cell (column index 6: project, tokensIn, tokensOut,
    // cost, costShare, lines, files) must show the fixture's filesChanged
    // value, not a defensive-fallback 0. The blended $/Mtok column that used
    // to sit between costShare and lines is gone: cost reaches back to a
    // project's first session while per-turn token capture starts later, so
    // the ratio divided a full-range numerator by a partial-range one.
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);
      await page.locator('[data-testid="stats-scope-trigger"]').click();
      await page.locator('[data-testid="stats-scope-option-all"]').click();
      await expect(page.locator('[data-testid="per-project-table"]')).toBeVisible({ timeout: 10000 });

      const firstRow = page.locator('[data-testid="per-project-row"]').first();
      await expect(firstRow).toContainText('Mock Project');
      await expect(firstRow.locator('td').nth(6)).toHaveText('47');
    } finally {
      await browser.close();
    }
  });

  test('the Sessions tile shows "N active now" for live running/queued sessions scoped to the current project', async () => {
    // Bug #3 of the usage-dashboard fix: live (in-flight) sessions were
    // undercounted in the SESSIONS KPI. The merge into `kpis.sessionCount`
    // itself is server-side and unit-tested (usage-stats-service.test.ts);
    // this proves the renderer's own remaining piece, the cosmetic "N active
    // now" subtitle on the Sessions tile, correctly counts a live session
    // scoped to the open project.
    const liveSessionPreConfig = `${twoProjectPreConfig()}
      window.__mockPreConfigure(function (state) {
        state.sessions.push({
          id: 'live-session-usage-1',
          taskId: 'task-live-usage-1',
          projectId: '${PROJECT_A}',
          pid: 4242,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/usage-a',
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
          isolatedSwimlaneId: null,
          agentSessionId: null,
        });
      });
    `;
    const { browser, page } = await launchWithState(liveSessionPreConfig);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      await expect(page.locator('[data-testid="kpi-sessions"]')).toContainText('1 active now', { timeout: 10000 });
    } finally {
      await browser.close();
    }
  });

  test('the headline Cost equals each breakdown, and both burn-rate lines reproduce their own tile', async () => {
    // The four numbers the usage audit found disagreeing. The Cost tile used
    // to float above the breakdowns by the whole cumulative cost of every
    // session still in the session store, and the burn rate divided
    // turn-ALLOCATED cost by the range while the Cost tile showed the full
    // ledger, so tile-divided-by-tile implied two different window lengths.
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);
      await page.locator('[data-testid="stats-period-group"] button:has-text("This Week")').click();
      await expect(page.locator('[data-testid="kpi-tiles"]')).toBeVisible({ timeout: 10000 });

      const checks = await page.evaluate(async () => {
        const api = (window as unknown as {
          electronAPI: {
            projects: { list: () => Promise<Array<{ id: string }>> };
            usage: { getDashboardStats: (...args: unknown[]) => Promise<Record<string, never>> };
          };
        }).electronAPI;
        const projects = await api.projects.list();
        const stats = await api.usage.getDashboardStats(
          { kind: 'project', projectId: projects[0].id }, 'week', null, null,
        ) as unknown as {
          kpis: Record<string, number>;
          byModel: Array<{ costUsd: number }>;
          byAgent: Array<{ costUsd: number }>;
          byEffort: Array<{ costUsd: number }>;
          rangeStartMs: number;
          rangeEndMs: number;
        };
        const sum = (rows: Array<{ costUsd: number }>) =>
          rows.reduce((runningTotal, row) => runningTotal + row.costUsd, 0);
        const hours = (stats.rangeEndMs - stats.rangeStartMs) / 3_600_000;
        return {
          headline: stats.kpis.totalCostUsd,
          byModel: sum(stats.byModel),
          byAgent: sum(stats.byAgent),
          byEffort: sum(stats.byEffort),
          usdOverRange: stats.kpis.burnRateUsdPerHour * hours,
          tokensOverRange: stats.kpis.burnRateTokensPerHour * hours,
          tileTokens: stats.kpis.turnInputTokens + stats.kpis.turnOutputTokens,
        };
      });

      expect(checks.byModel).toBeCloseTo(checks.headline, 6);
      expect(checks.byAgent).toBeCloseTo(checks.headline, 6);
      expect(checks.byEffort).toBeCloseTo(checks.headline, 6);
      // Each rate times the range reproduces the tile it sits beside, which is
      // only true when both lines share one denominator AND each numerator is
      // the field its own tile renders.
      expect(checks.usdOverRange).toBeCloseTo(checks.headline, 6);
      expect(checks.tokensOverRange).toBeCloseTo(checks.tileTokens, 6);
    } finally {
      await browser.close();
    }
  });

  test('Avg Active reports agent-working time over the sessions the interval ledger covers', async () => {
    // Was "Avg Session": the agent's own wall clock (idle included) summed
    // across every resume leg, divided by a count of ledger rows. On the
    // dogfooding install that read 4h11m, which works out to 3.7 sessions
    // running around the clock for six months.
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);
      await page.locator('[data-testid="stats-period-group"] button:has-text("This Week")').click();

      const tile = page.locator('[data-testid="kpi-avg-session"]');
      // 90 minutes of active time over 6 covered sessions = 15m each.
      await expect(tile).toContainText('15m', { timeout: 10000 });
      // The denominator is on the tile: it is a different population from the
      // Sessions tile two cards to the left, and a reader comparing the two
      // deserves to see why.
      await expect(tile).toContainText('over 6 sessions');
      await expect(tile).toHaveAttribute(
        'title',
        'Time the agent was working, per session, excluding idle. Covers the 6 session(s) with '
        + 'activity tracking in this range, which is fewer than the Sessions tile counts.',
      );
    } finally {
      await browser.close();
    }
  });

  test('the Tokens tile flags a range that reaches back before per-turn capture started', async () => {
    // The two ledgers do not start at the same time: usage_history reaches
    // back to a project's first session, but per-turn capture shipped later
    // and the CLI prunes the transcripts that would backfill it. A range
    // whose rangeStartMs sits before earliestTurnMs genuinely has less token
    // coverage than the Cost tile beside it, and the tile has to say so
    // rather than let a partial number read as full coverage. The default
    // fixture's rangeStartMs never reaches back that far (~5h), so this
    // branch has no coverage without a custom fixture.
    const dayMs = 24 * 60 * 60 * 1000;
    const partialCoverageFixture = `
      (function () {
        window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
          var now = Date.now();
          var dayMs = ${dayMs};
          return {
            scope: scope, period: period,
            rangeStartMs: now - 60 * dayMs, rangeEndMs: now,
            bucketSizeMs: 86400000, costBucketSizeMs: 86400000, generatedAtMs: now,
            kpis: {
              totalCostUsd: 40, costKnown: true,
              totalInputTokens: 5000, totalOutputTokens: 1000, totalTokens: 6000,
              sessionCount: 4, toolCallCount: 20,
              linesAdded: 0, linesRemoved: 0, filesChanged: 0,
              compactionCount: 0, totalDurationMs: 100000,
              activeMs: 0, activeSessionsCovered: 0,
              turnInputTokens: 900, turnOutputTokens: 150,
              cacheCreationTokens: 10, cacheReadTokens: 50,
              subagentInputTokens: 0, subagentOutputTokens: 0,
              subagentCacheCreationTokens: 0, subagentCacheReadTokens: 0,
              subagentTurnCount: 0, subagentCount: 0, subagentNestedCount: 0,
              burnRateTokensPerHour: 100, burnRateUsdPerHour: 1,
            },
            previousKpis: null,
            tokenSeries: [], costSeries: [],
            byModel: [], byAgent: [], byEffort: [], bySubagentType: [],
            subagentBlindAgents: [],
            liveLedgerBaseline: { costUsd: 0 },
            earliestTurnMs: now - 10 * dayMs,
          };
        };
      })();
    `;
    const { browser, page } = await launchWithState(twoProjectPreConfig() + partialCoverageFixture);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);
      // Off Live so the Cost tile reads the ledger total rather than an empty
      // client-side overlay - a sanity check that the note does not corrupt
      // the neighboring tile.
      await page.locator('[data-testid="stats-period-group"] button:has-text("This Week")').click();

      const tokensTile = page.locator('[data-testid="kpi-tokens"]');
      await expect(tokensTile).toBeVisible({ timeout: 10000 });
      const title = await tokensTile.getAttribute('title');
      // Stable substrings only: the title interpolates a locale-formatted
      // date, which is not portable across Windows and CI Linux.
      expect(title).toContain('Per-turn capture starts');
      expect(title).toContain('covers less of the range than Cost does');
      await expect(page.locator('[data-testid="kpi-cost-value"]')).toContainText('$40.00');
    } finally {
      await browser.close();
    }
  });

  test('the Subagents tile and By-subagent card report fan-out without changing the main-thread totals', async () => {
    // Task-tool subagent tokens are ADDITIVE: the headline Tokens tile and
    // both series stay main-thread, so the historical series remains
    // comparable, and the fan-out shows up in its own tile and card.
    const { browser, page } = await launchWithState(twoProjectPreConfig());
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);
      // Off the default Live period so the comparison below has a
      // ledger-backed range rather than an empty trailing window.
      await page.locator('[data-testid="stats-period-group"] button:has-text("This Week")').click();

      const subagentTile = page.locator('[data-testid="kpi-subagents"]');
      // 180000 + 45000 fresh + output from the mock's subagent rollup.
      await expect(subagentTile).toContainText('225k', { timeout: 10000 });
      await expect(subagentTile).toContainText('8 agent(s), 5.2M cached');
      // A real period-over-period delta, which only appears when the previous
      // window is read for the subagent fields too (225k against 186k = +21%).
      await expect(subagentTile).toContainText('+21%');

      // The tooltip carries the two facts too small for the tile's own body:
      // how many of the 8 subagents were nested (2, from the mock's
      // kpis.subagentNestedCount), and that 'codex' (present in byAgent) cannot
      // report subagent usage at all, so this range's total is a floor, not a
      // complete count.
      await expect(subagentTile).toHaveAttribute(
        'title',
        'Fresh input and output from 190 subagent turn(s). The Tokens tile is main-thread only, '
        + 'so these are on top of it; the session\'s reported Cost already covers them. '
        + '5.2M cache read. 2 of 8 were spawned by another subagent. '
        + 'Excludes Codex, which does not report subagent usage.',
      );

      // Unchanged: the mock's main-thread turn tokens (60k fresh input + 20k
      // output), which never absorb the subagent traffic above. NOT the
      // mock's totalInputTokens/totalOutputTokens - those are context-window
      // snapshots, which is exactly what this tile stopped reporting.
      await expect(page.locator('[data-testid="kpi-tokens-value"]')).toContainText('80k');

      const card = page.locator('[data-testid="breakdown-subagent"]');
      await expect(card).toBeVisible();
      await expect(card).toContainText('review-finder');
      await expect(card).toContainText('test-builder');
      await expect(card).toContainText('Explore');
    } finally {
      await browser.close();
    }
  });

  test('hides the By-subagent card entirely for a range with no fan-out', async () => {
    // A range that predates subagent capture, and one where nothing fanned out,
    // look identical and neither should leave an empty card on the page.
    const emptySubagentFixture = `
      (function () {
        window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
          var now = Date.now();
          return {
            scope: scope, period: period,
            rangeStartMs: now - 3600000, rangeEndMs: now,
            bucketSizeMs: 3600000, costBucketSizeMs: 86400000, generatedAtMs: now,
            kpis: {
              totalCostUsd: 5, costKnown: true,
              totalInputTokens: 1000, totalOutputTokens: 200, totalTokens: 1200,
              sessionCount: 1, toolCallCount: 3,
              linesAdded: 0, linesRemoved: 0, filesChanged: 0,
              compactionCount: 0, totalDurationMs: 1000,
              turnInputTokens: 900, turnOutputTokens: 150,
              cacheCreationTokens: 10, cacheReadTokens: 50,
              subagentInputTokens: 0, subagentOutputTokens: 0,
              subagentCacheCreationTokens: 0, subagentCacheReadTokens: 0,
              subagentTurnCount: 0, subagentCount: 0, subagentNestedCount: 0,
              burnRateTokensPerHour: 100, burnRateUsdPerHour: 1,
            },
            previousKpis: null,
            tokenSeries: [], costSeries: [],
            byModel: [], byAgent: [], byEffort: [], bySubagentType: [],
            subagentBlindAgents: [],
          };
        };
      })();
    `;
    const { browser, page } = await launchWithState(twoProjectPreConfig() + emptySubagentFixture);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      // The other three breakdown cards still render, so this is "the subagent
      // card is absent", not "the dashboard failed to load".
      await expect(page.locator('[data-testid="breakdown-model"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="breakdown-subagent"]')).toHaveCount(0);
      const tile = page.locator('[data-testid="kpi-subagents"]');
      await expect(tile).toContainText('-');
      // Every agent here CAN report subagent usage, so the dash is a real
      // measurement and the tooltip must not imply a blind spot.
      await expect(tile).toHaveAttribute('title', 'No subagent turns recorded in this range');
    } finally {
      await browser.close();
    }
  });

  test('says which agents cannot report subagent usage, instead of a dash that reads as "nothing fanned out"', async () => {
    // The two cases render the same `-`: a range where nothing fanned out, and a
    // range whose agent has no subagent capture at all. Only Claude implements
    // it, so a Codex range is permanently the second one and has to say so.
    const blindAgentFixture = `
      (function () {
        window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
          var now = Date.now();
          return {
            scope: scope, period: period,
            rangeStartMs: now - 3600000, rangeEndMs: now,
            bucketSizeMs: 3600000, costBucketSizeMs: 86400000, generatedAtMs: now,
            kpis: {
              totalCostUsd: 5, costKnown: true,
              totalInputTokens: 1000, totalOutputTokens: 200, totalTokens: 1200,
              sessionCount: 1, toolCallCount: 3,
              linesAdded: 0, linesRemoved: 0, filesChanged: 0,
              compactionCount: 0, totalDurationMs: 1000,
              turnInputTokens: 900, turnOutputTokens: 150,
              cacheCreationTokens: 10, cacheReadTokens: 50,
              subagentInputTokens: 0, subagentOutputTokens: 0,
              subagentCacheCreationTokens: 0, subagentCacheReadTokens: 0,
              subagentTurnCount: 0, subagentCount: 0, subagentNestedCount: 0,
              burnRateTokensPerHour: 100, burnRateUsdPerHour: 1,
            },
            previousKpis: null,
            tokenSeries: [], costSeries: [],
            byModel: [], byAgent: [], byEffort: [], bySubagentType: [],
            subagentBlindAgents: ['codex'],
          };
        };
      })();
    `;
    const { browser, page } = await launchWithState(twoProjectPreConfig() + blindAgentFixture);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      await openDashboard(page);

      const tile = page.locator('[data-testid="kpi-subagents"]');
      await expect(tile).toContainText('-', { timeout: 10000 });
      // Singular agent, singular verb - the list is short enough that agreement
      // is worth getting right rather than papering over with "do(es) not".
      await expect(tile).toHaveAttribute(
        'title',
        'Codex does not report subagent usage, so fan-outs in this range cannot be counted.',
      );
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

      // "-" rather than "0": a range with no per-turn rows has no token data,
      // which is not the same claim as measuring zero tokens.
      await expect(page.locator('[data-testid="kpi-tokens-value"]')).toHaveText('-', { timeout: 10000 });
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
