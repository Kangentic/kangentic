/**
 * The context bar is one row (src/renderer/components/terminal/useContextBarFold.ts):
 * what does not fit folds into its +N list, the agent and the model and effort
 * pickers stay, and nothing wraps to a second row.
 *
 * Pattern-matched off `tests/ui/context-bar-version-pill.spec.ts`: a task and
 * its session pre-seeded, with usage pushed through `session-store.updateUsage`
 * so the bottom panel's bar renders past its spinner. The window is then made
 * narrow so the bar has to fold.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-context-bar-fold';
const TASK_ID = 'task-context-bar-fold';
const SESSION_ID = 'sess-context-bar-fold';
const SWIMLANE_ID = 'lane-context-bar-fold-todo';
/** One row of pills: a second row would make the bar at least this much taller. */
const ONE_ROW_MAX_HEIGHT = 40;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.addInitScript((overrides) => {
    (window as unknown as { __mockAgentListOverrides?: unknown }).__mockAgentListOverrides = overrides;
  }, { claude: { found: true, path: '/usr/bin/claude', version: '2.1.314' } });
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}', name: 'Context Bar Fold', path: '/mock/context-bar-fold',
        github_url: null, default_agent: 'claude', last_opened: ts, created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push({
          id: i === 0 ? '${SWIMLANE_ID}' : state.uuid(), name: s.name, role: s.role, color: s.color,
          icon: s.icon, is_archived: s.is_archived, permission_strategy: s.permission_strategy ?? null,
          auto_spawn: s.auto_spawn ?? false, position: i, created_at: ts,
        });
      });
      state.sessions.push({
        id: '${SESSION_ID}', taskId: '${TASK_ID}', projectId: '${PROJECT_ID}', pid: 9999, status: 'running',
        shell: 'bash', cwd: '/mock/context-bar-fold', startedAt: ts, exitCode: null, resuming: false,
      });
      state.tasks.push({
        id: '${TASK_ID}', title: 'Fold Task', description: '', swimlane_id: '${SWIMLANE_ID}', position: 0,
        agent: 'claude', session_id: '${SESSION_ID}', worktree_path: null, branch_name: null, pr_number: null,
        pr_url: null, base_branch: null, archived_at: null, created_at: ts, updated_at: ts,
      });
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

async function pushUsage(page: Page): Promise<void> {
  await page.evaluate((sessionId: string) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { updateUsage: (id: string, data: unknown) => void } } };
    }).__zustandStores;
    stores?.session.getState().updateUsage(sessionId, {
      model: { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', effort: 'medium', reportedByAgent: true },
      contextWindow: {
        usedPercentage: 11, usedTokens: 105500, cacheTokens: 20000,
        totalInputTokens: 105500, totalOutputTokens: 4200, contextWindowSize: 1000000,
      },
      cost: { totalCostUsd: 12.34, totalDurationMs: 600000 },
      toolCallCount: 42,
    });
  }, SESSION_ID);
}

test.describe('Context bar fold', () => {
  test('a bar with room folds nothing; a narrow one keeps one row, folds the shell first, and lists it under +N', async () => {
    const { browser, page } = await launch();
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      const bar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(bar).toBeVisible({ timeout: 10000 });
      await pushUsage(page);
      await expect.poll(async () => bar.textContent(), { timeout: 5000 }).toMatch(/Sonnet 5\.5/);
      const more = bar.getByTestId('context-bar-overflow');

      // With room, every pill shows and the +N pill stays out of sight.
      await expect(bar.locator('[data-folded]')).toHaveCount(0);
      await expect(more).toHaveAttribute('aria-hidden', 'true');

      await page.setViewportSize({ width: 900, height: 700 });
      await expect(bar.locator('[data-fold-id="shell"][data-folded]')).toHaveCount(1, { timeout: 5000 });
      expect((await bar.boundingBox())?.height ?? 0).toBeLessThanOrEqual(ONE_ROW_MAX_HEIGHT);
      // The agent's name and the model and effort pickers stay in the row.
      await expect(bar.locator('[data-fold-id="agent"]')).toBeVisible();
      await expect(bar.locator('[data-fold-id="agent"][data-folded]')).toHaveCount(0);
      await expect(bar.getByTestId('context-bar-model-trigger')).toBeVisible();
      await expect(bar.getByTestId('context-bar-effort-trigger')).toBeVisible();
      // Nothing in the row runs past its edge.
      expect(await bar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

      await expect(more).toBeVisible();
      const foldedCount = await bar.locator(':scope > [data-folded], :scope > * > [data-folded]').count();
      await expect(more).toHaveText(`+${foldedCount}`);
      await more.click();
      const list = page.getByTestId('context-bar-overflow-list');
      await expect(list).toBeVisible();
      await expect(list.locator('[data-overflow-item="shell"]')).toContainText(/bash/i);

      // Escape closes the list and nothing under it.
      await page.keyboard.press('Escape');
      await expect(list).toHaveCount(0);
      await expect(bar).toBeVisible();

      await page.setViewportSize({ width: 1920, height: 1080 });
      await expect(bar.locator('[data-folded]')).toHaveCount(0, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('cost and the context counts fold before a bar drops under 80px, and the list keeps their pill look', async () => {
    const { browser, page } = await launch();
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      const bar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(bar).toBeVisible({ timeout: 10000 });
      await pushUsage(page);
      await expect.poll(async () => bar.textContent(), { timeout: 5000 }).toMatch(/Sonnet 5\.5/);

      const readRow = () => bar.evaluate((element) => {
        const optionalIds = ['shell', 'version', 'agent-active', 'elapsed', 'tokens', 'tool-calls', 'cost', 'context-fraction'];
        const optionalShown = optionalIds.some((id) => {
          const node = element.querySelector(`[data-fold-id="${id}"]`);
          return node !== null && !node.hasAttribute('data-folded');
        });
        const trackWidths = Array.from(element.querySelectorAll('[data-meter] [data-meter-track]'))
          .filter((track) => track.closest('[data-folded]') === null)
          .map((track) => track.getBoundingClientRect().width);
        return { optionalShown, narrowestTrack: trackWidths.length > 0 ? Math.min(...trackWidths) : Infinity };
      });

      // While anything outside the five shows, no bar is under its 80px comfort width.
      for (const width of [1400, 1200, 1100, 1000, 900, 800, 760]) {
        await page.setViewportSize({ width, height: 700 });
        await expect.poll(async () => {
          const row = await readRow();
          return !row.optionalShown || row.narrowestTrack >= 79.5;
        }, { timeout: 5000, message: `at ${width}px` }).toBe(true);
      }
      // The sweep reached the narrow end: cost is in the list and the context bar stays.
      await expect(bar.locator('[data-fold-id="cost"][data-folded]')).toHaveCount(1);
      await expect(bar.locator('[data-fold-id="context"][data-folded]')).toHaveCount(0);

      // The list draws on the bar's own fill, so each copy keeps its raised pill.
      await bar.getByTestId('context-bar-overflow').click();
      const list = page.getByTestId('context-bar-overflow-list');
      await expect(list).toBeVisible();
      const fills = await list.evaluate((element) => {
        const pill = element.querySelector('[data-overflow-item="cost"] > *');
        return { list: getComputedStyle(element).backgroundColor, pill: pill ? getComputedStyle(pill).backgroundColor : '' };
      });
      expect(fills.pill).not.toBe('');
      expect(fills.pill).not.toBe(fills.list);
    } finally {
      await browser.close();
    }
  });

  test('tool calls folded into the list open their table above the +N pill', async () => {
    const { browser, page } = await launch();
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
      const bar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(bar).toBeVisible({ timeout: 10000 });
      await pushUsage(page);
      await expect.poll(async () => bar.textContent(), { timeout: 5000 }).toMatch(/Sonnet 5\.5/);
      await page.setViewportSize({ width: 760, height: 700 });
      await expect(bar.locator('[data-fold-id="tool-calls"][data-folded]')).toHaveCount(1, { timeout: 5000 });

      const more = bar.getByTestId('context-bar-overflow');
      await more.click();
      await page.getByTestId('context-bar-tool-calls-overflow').click();
      await expect(page.getByTestId('context-bar-overflow-list')).toHaveCount(0);
      const table = page.getByTestId('context-bar-tool-breakdown-popover');
      await expect(table).toBeVisible();
      const tableBox = await table.boundingBox();
      const moreBox = await more.boundingBox();
      // Above the +N pill, not at the folded trigger's hidden spot.
      expect((tableBox?.y ?? 0) + (tableBox?.height ?? 0)).toBeLessThanOrEqual((moreBox?.y ?? 0) + 2);
    } finally {
      await browser.close();
    }
  });
});
