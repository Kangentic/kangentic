/**
 * UI tests for TaskCard's board-card context-window render gate.
 *
 * TaskCard (src/renderer/components/board/TaskCard.tsx), the 'running'
 * bottom-bar case, computes the SAME gate as ContextBar but on its own
 * separate render path:
 *
 *   windowKnown = contextWindowSize > 0
 *   overBudget = contextWindowSize > 0 && usedTokens > contextWindowSize
 *
 * When the window is unknown, the card footer renders `<div
 * data-testid="usage-bar" data-context-window="unknown"><span>{modelName}
 * </span></div>` with the bar reserved at 0% (stable card height) - no
 * denominator to draw a real bar against. When the window is known but
 * over budget (the near-full/auto-compaction state), the bar still renders,
 * clamped to a full 100% critical bar. When usage fits comfortably, it
 * renders the model name + `{pct}%` label + the bar track
 * (`div.h-full.rounded-full`).
 *
 * The card must have already streamed a model displayName (else it shows the
 * "Starting agent..." spinner), so usage is seeded via a `sessions.getUsage`
 * override BEFORE mount - the same pattern task-activity-indicators.spec.ts
 * uses in its "ContextBar spinner pill" group (e.g. "shows model name with 0%
 * bar when usage exists but no tokens streamed yet"), which this spec's cases
 * extend to the over-budget/consistent context-window pairing.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-task-card-ctx-window';
const TASK_ID = 'task-card-ctx-window';
const SESSION_ID = 'sess-task-card-ctx-window';
const SWIMLANE_ID = 'lane-task-card-ctx-window';

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

interface ContextWindowPatch {
  usedPercentage: number;
  usedTokens: number;
  cacheTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  contextWindowSize: number;
}

/**
 * Preconfig: a running Claude session bound to a task, with
 * `sessions.getUsage` overridden so the card is already past the "Starting
 * agent..." spinner on first render (model.displayName present from the
 * initial load, not injected post-mount).
 */
function makePreConfig(contextWindow: ContextWindowPatch): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'TaskCard Context Window Test',
        path: '/mock/task-card-ctx-window',
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

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/task-card-ctx-window',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });

      state.activityCache['${SESSION_ID}'] = 'idle';

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'TaskCard Context Window Task',
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
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });

    // Seed usage BEFORE mount so the card is already past the "Starting
    // agent..." spinner on first render (model.displayName present).
    window.electronAPI.sessions.getUsage = async function () {
      var result = {};
      result['${SESSION_ID}'] = {
        model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
        contextWindow: ${JSON.stringify(contextWindow)},
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
      };
      return result;
    };
  `;
}

test.describe('TaskCard context-window render gate', () => {
  test('over-budget usage (usedTokens > contextWindowSize) shows a full 100% critical bar', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      usedPercentage: 325,
      usedTokens: 650398,
      cacheTokens: 446,
      totalInputTokens: 650398,
      totalOutputTokens: 318,
      contextWindowSize: 200000,
    }));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator(`[data-task-id="${TASK_ID}"] [data-testid="usage-bar"]`);
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      await expect(usageBar).toContainText('Opus 4.8');
      // Over budget on a KNOWN window (200k) clamps to a full 100%, never the
      // impossible 325% - this is a critical state to show, not a broken
      // denominator to hide.
      await expect(usageBar).toContainText('100%');
      await expect(usageBar).not.toContainText('325');
      await expect(usageBar).not.toHaveAttribute('data-context-window', 'unknown');
      const fillBar = usageBar.locator('div.h-full.rounded-full');
      await expect(fillBar).toHaveCount(1);

      // getProgressColor's own unit tests (tests/unit/progress-color.test.ts)
      // prove the pure function returns 'var(--kng-danger)' at 100% and that
      // index.css DECLARES the --kng-danger custom property. Neither proves
      // the browser actually RESOLVES it: --kng-danger and --kng-warning are
      // brand new tokens (unlike --kng-active, already load-bearing for the
      // activity indicators) that have never rendered anywhere before this
      // change. If the token failed to resolve, the inline backgroundColor
      // would be invalid and the fill would paint transparent while every
      // unit test stayed green - that gap is what this closes.
      const fillColor = await fillBar.evaluate((el) => getComputedStyle(el).backgroundColor);
      const expectedDangerColor = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--kng-danger)';
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return resolved;
      });
      // The load-bearing assertion: if --kng-danger failed to resolve, BOTH
      // the fill and the probe would come back as the same transparent
      // default, and a bare equality check would pass for the wrong reason.
      expect(fillColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(fillColor).toBe(expectedDangerColor);

      // Cheap sibling coverage while the page is already up: confirm
      // --kng-warning is also a live, non-empty custom property (its own
      // color-band boundary is pinned by the unit test; this only proves the
      // token resolves in a real browser, same failure mode as above).
      const warningTokenValue = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--kng-warning').trim(),
      );
      expect(warningTokenValue).not.toBe('');
    } finally {
      await browser.close();
    }
  });

  test('consistent usage (usedTokens within contextWindowSize) shows percent and bar', async () => {
    const { browser, page } = await launchWithState(makePreConfig({
      usedPercentage: 65,
      usedTokens: 650000,
      cacheTokens: 400000,
      totalInputTokens: 650000,
      totalOutputTokens: 1000,
      contextWindowSize: 1_000_000,
    }));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator(`[data-task-id="${TASK_ID}"] [data-testid="usage-bar"]`);
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      await expect(usageBar).toContainText('Opus 4.8');
      await expect(usageBar).toContainText('65%');
      await expect(usageBar).not.toHaveAttribute('data-context-window', 'unknown');
      await expect(usageBar.locator('div.h-full.rounded-full')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('unknown window (contextWindowSize: 0) still prints "0%", never a fabricated dash', async () => {
    // TaskCard's ContextUsageFooter call omits `unknownLabel` deliberately (see
    // the comment above its call site in TaskCard.tsx): the track is held at
    // 0% rather than swapped for a placeholder, because a resized label would
    // trip dnd-kit's per-card ResizeObserver re-measure mid-drag. This is the
    // call-site half of that contract - ContextUsageFooter's own unit tests
    // (tests/unit/context-usage-footer.test.ts) prove the component honors an
    // omitted `unknownLabel`, but only reading TaskCard's actual props here
    // proves TaskCard still omits it. contextWindowDisplayPercent(0, 0, 0)
    // (src/renderer/utils/format-tokens.ts) returns 0 for an unknown window,
    // so "0%" is the function's contract, not a value copied from a run.
    const { browser, page } = await launchWithState(makePreConfig({
      usedPercentage: 0,
      usedTokens: 0,
      cacheTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      contextWindowSize: 0,
    }));
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator(`[data-task-id="${TASK_ID}"] [data-testid="usage-bar"]`);
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      const percentLabel = usageBar.locator('[data-testid="usage-bar-percent"]');
      await expect(percentLabel).toHaveText('0%');
      await expect(percentLabel).not.toHaveText('-');
      await expect(usageBar).toHaveAttribute('data-context-window', 'unknown');
    } finally {
      await browser.close();
    }
  });
});
