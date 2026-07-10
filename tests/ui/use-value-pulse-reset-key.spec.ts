/**
 * UI-tier tests for the `resetKey` behavior introduced in `useValuePulse.ts`.
 *
 * ## Why UI tier (not unit)
 *
 * `useValuePulse` is DOM-coupled: it applies a CSS class via `element.classList`,
 * queues the class-add via `requestAnimationFrame`, and schedules removal via
 * `setTimeout`. The vitest config has NO jsdom environment and NO
 * @testing-library/react dependency (deliberate team decision - see
 * `tests/unit/use-browser-url-logic.test.ts`). A pure-logic replica would not
 * produce a genuine red-green test: reverting the production `resetKey` branch
 * would leave the replica green (the replica doesn't use the real hook). A
 * genuine red-green test MUST import and exercise the real exported `useValuePulse`
 * inside a real DOM where `requestAnimationFrame` runs.
 *
 * Headless Chromium (the `--project=ui` tier) is the ONLY existing environment
 * where both the real React hook and rAF run without new dependencies.
 *
 * ## What we test
 *
 * The hook is exercised through its real consumer: the usage dashboard's KPI
 * tiles (the old StatusBar usage strip was replaced by the dashboard). The
 * Cost tile's value element `[data-testid="kpi-cost-value"]` is the ref target
 * of `useValuePulse(value, { resetKey })` with
 * `resetKey = "<scopeKind>:<projectId>:<period>"`. We manipulate the Zustand
 * stores (exposed on `window.__zustandStores` in DEV mode) to trigger value and
 * resetKey changes, then observe whether `animate-value-update` appears.
 *
 * ## Behavior contract
 *
 * (a) When `resetKey` CHANGES, the hook rebaselines SILENTLY - it must NOT add
 *     the pulse class `animate-value-update`.
 * (b) When `resetKey` is STABLE and `value` changes, it DOES pulse.
 * (c) Initial mount never pulses.
 *
 * ## Red-green anchoring
 *
 * Reverting the `resetKey` effect branch in `useValuePulse.ts` makes test (a)
 * fail: a period change flips the resetKey AND changes the displayed value
 * (live-only -> DB+live layering), so without the early return the hook falls
 * through to the pulse path and applies `animate-value-update`.
 */

import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-pulse-test';
const SESSION_ID = 'sess-pulse-test';
const SWIMLANE_ID = 'lane-pulse-0';

/** Initial live cost. Formats as $0.05 - the pulse fires on the FORMATTED value,
 *  so test values must differ after formatCost. */
const INITIAL_COST = 0.05;
/** A different cost whose formatted value differs ($0.12). */
const UPDATED_COST = 0.12;

/**
 * Pre-configure script: one project with one running session. The `getUsage`
 * mock is overridden so the dashboard's live KPI layering sees real usage.
 */
const PRE_CONFIGURE = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Pulse Test Project',
      path: '/mock/pulse-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
      state.swimlanes.push({
        id: index === 0 ? '${SWIMLANE_ID}' : 'lane-pulse-' + index,
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

    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: 'task-pulse-test',
      projectId: '${PROJECT_ID}',
      pid: 7777,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/pulse-test',
      startedAt: ts,
      exitCode: null,
    });

    state.activityCache['${SESSION_ID}'] = 'idle';

    state.tasks.push({
      id: 'task-pulse-test',
      title: 'Pulse Test Task',
      description: '',
      swimlane_id: '${SWIMLANE_ID}',
      position: 0,
      agent: null,
      session_id: '${SESSION_ID}',
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

  // Override getUsage so the dashboard's live layer sees usage for SESSION_ID.
  window.electronAPI.sessions.getUsage = async function () {
    var result = {};
    result['${SESSION_ID}'] = {
      model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
      contextWindow: {
        usedPercentage: 10,
        usedTokens: 800,
        cacheTokens: 0,
        totalInputTokens: 600,
        totalOutputTokens: 200,
        contextWindowSize: 200000,
      },
      cost: { totalCostUsd: ${INITIAL_COST}, totalDurationMs: 1000 },
    };
    return result;
  };
`;

async function launchPulsePage(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIGURE);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

/** Open the dashboard from the title bar and wait for the seeded live cost. */
async function openDashboard(page: Page): Promise<void> {
  await page.locator('[data-testid="usage-stats-button"]').click();
  await page.locator('[data-testid="stats-page"]').waitFor({ state: 'visible', timeout: 10000 });
  await expect(page.locator('[data-testid="kpi-cost-value"]')).toContainText('$0.05', { timeout: 10000 });
}

/**
 * Inject new usage data into the session store's `sessionUsage` map for
 * SESSION_ID. Scope, project, and period are untouched, so the KPI tiles'
 * resetKey is unchanged - a pure VALUE change with a STABLE reset key.
 */
async function injectUsageUpdate(page: Page, newCostUsd: number): Promise<void> {
  await page.evaluate(
    ({ sessionId, newCost }: { sessionId: string; newCost: number }) => {
      type SessionStoreHandle = {
        getState: () => {
          sessionUsage: Record<
            string,
            {
              cost: { totalCostUsd: number; totalDurationMs: number };
            }
          >;
        };
        setState: (partial: Record<string, unknown>) => void;
      };

      const stores = (
        window as unknown as { __zustandStores?: { session: SessionStoreHandle } }
      ).__zustandStores;
      if (!stores) throw new Error('window.__zustandStores not exposed');

      const currentUsage = stores.session.getState().sessionUsage;
      const existing = currentUsage[sessionId];
      if (!existing) throw new Error(`No usage entry for session ${sessionId}`);

      stores.session.setState({
        sessionUsage: {
          ...currentUsage,
          [sessionId]: {
            ...existing,
            cost: { totalCostUsd: newCost, totalDurationMs: existing.cost.totalDurationMs + 100 },
          },
        },
      });
    },
    { sessionId: SESSION_ID, newCost: newCostUsd },
  );
}

/**
 * Flip the dashboard period from 'live' to 'today' via a direct store
 * setState (no action side effects). One synchronous evaluate = one React 18
 * batched render = one effect run that sees BOTH a resetKey change (the
 * period component flips) AND a value change (live-only cost becomes
 * DB-totals + live via the layering), so:
 *
 * - WITH the resetKey branch: the early return fires, no class is added.
 * - WITHOUT the resetKey branch: `value !== prevRef.current` is true, so the
 *   class IS added. That is what the red run verifies.
 */
async function injectResetKeyChange(page: Page): Promise<void> {
  await page.evaluate(() => {
    type DashboardStoreHandle = {
      setState: (partial: Record<string, unknown>) => void;
    };
    const stores = (
      window as unknown as { __zustandStores?: { usageDashboard: DashboardStoreHandle } }
    ).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    stores.usageDashboard.setState({ period: 'today' });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('useValuePulse resetKey behavior (via the usage dashboard KPI tiles)', () => {
  // Tests use separate browser instances for isolation - no shared state.

  test('(c) initial mount never pulses - animate-value-update is absent on first open', async () => {
    const { browser, page } = await launchPulsePage();
    try {
      await openDashboard(page);

      // On initial mount, mountedRef.current is false so the effect returns early.
      // The class must never appear at all - not even for a frame.
      await expect(page.locator('[data-testid="kpi-cost-value"]')).not.toHaveClass(
        /animate-value-update/,
      );
      await expect(page.locator('[data-testid="kpi-tokens-value"]')).not.toHaveClass(
        /animate-value-update/,
      );
    } finally {
      await browser.close();
    }
  });

  test('(b) stable resetKey + value change = pulse class is applied then removed', async () => {
    const { browser, page } = await launchPulsePage();
    try {
      await openDashboard(page);

      // Confirm no class before the mutation.
      await expect(page.locator('[data-testid="kpi-cost-value"]')).not.toHaveClass(
        /animate-value-update/,
      );

      // Inject a cost update with the same scope/project/period = stable resetKey.
      await injectUsageUpdate(page, UPDATED_COST);

      // The hook queues the class-add via requestAnimationFrame. Poll for it.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const element = document.querySelector('[data-testid="kpi-cost-value"]');
              return element?.classList.contains('animate-value-update') ?? false;
            }),
          { timeout: 2000, intervals: [50, 50, 100, 100, 100] },
        )
        .toBe(true);

      // After durationMs (350ms default) the class is removed.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const element = document.querySelector('[data-testid="kpi-cost-value"]');
              return element?.classList.contains('animate-value-update') ?? false;
            }),
          { timeout: 1500, intervals: [100, 200, 300, 300] },
        )
        .toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('(a) resetKey change suppresses pulse - animate-value-update must NOT appear', async () => {
    const { browser, page } = await launchPulsePage();
    try {
      await openDashboard(page);

      // Confirm no class before the mutation.
      await expect(page.locator('[data-testid="kpi-cost-value"]')).not.toHaveClass(
        /animate-value-update/,
      );

      // Flip the period: resetKey changes AND the displayed cost changes in the
      // same render (live-only -> DB totals + live). With the correct
      // implementation the hook rebaselines silently and never adds the class.
      await injectResetKeyChange(page);

      // Red-green observation window: sample the DOM every 100ms for 600ms.
      // We do NOT use expect.poll(toBe(false)) here - that is anti-pattern 6
      // (polling for non-occurrence exits immediately). Instead we actively scan
      // the window before drawing a conclusion.
      let classObservedDuringWindow = false;
      for (let iteration = 0; iteration < 6; iteration++) {
        // intentional fixed wait - scanning for non-occurrence requires a time budget
        await page.waitForTimeout(100);
        const classPresent = await page.evaluate(() => {
          const element = document.querySelector('[data-testid="kpi-cost-value"]');
          return element?.classList.contains('animate-value-update') ?? false;
        });
        if (classPresent) {
          classObservedDuringWindow = true;
          break;
        }
      }

      expect(
        classObservedDuringWindow,
        'animate-value-update must NOT appear when resetKey changes: a context switch is ' +
          'not a live value tick and must not pulse (useValuePulse.ts resetKey branch)',
      ).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
