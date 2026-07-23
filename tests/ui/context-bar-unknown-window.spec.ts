/**
 * UI tests for ContextBar's context-window render gate.
 *
 * ContextBar (src/renderer/components/terminal/ContextBar.tsx) reads
 * `usage.contextWindow` and computes:
 *
 *   windowKnown = contextWindowSize > 0
 *   overBudget = contextWindowSize > 0 && usedTokens > contextWindowSize
 *
 * When the window is unknown (size 0, no denominator to draw a bar against),
 * the context-usage section renders nothing but a hidden sentinel (`<span
 * data-context-window="unknown" className="hidden" />`) - no fraction, no
 * bar, no percent. The model/effort pills render regardless (separate
 * cells). When the window is known but over budget (usedTokens exceeds it -
 * the near-full/auto-compaction state), the bar still renders, clamped to a
 * full 100% critical bar instead of hiding. When usage fits comfortably, the
 * fraction pill + bar + `{pct}%` render as usual.
 *
 * Setup mirrors context-bar-popover.spec.ts's CLAUDE_RUNNING_PRECONFIG and
 * applyClaudeUsage helper (launchWithState, the `.min-h-8` selector to
 * disambiguate ContextBar's bottom-panel instance from TaskCard's own
 * board-card usage-bar, and driving usage via the session store's
 * updateUsage - the same mechanism production's applyUsage -> IPC 'usage'
 * event -> session-store.updateUsage path uses).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own browser/page, so the file's tests can fan out
// across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-ctx-bar-unknown-window';
const TASK_ID = 'task-ctx-bar-unknown-window';
const SESSION_ID = 'sess-ctx-bar-unknown-window';
const SWIMLANE_ID = 'lane-ctx-bar-unknown-window';

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

const CLAUDE_RUNNING_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Unknown Window ContextBar Test',
      path: '/mock/ctx-bar-unknown-window',
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
      cwd: '/mock/ctx-bar-unknown-window',
      startedAt: ts,
      exitCode: null,
      resuming: false,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Unknown Window Task',
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
`;

interface ContextWindowPatch {
  usedPercentage: number;
  usedTokens: number;
  cacheTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  contextWindowSize: number;
}

/** Drives usage via the session store, mirroring applyUsage -> IPC 'usage'
 * event -> session-store.updateUsage in production (same pattern as
 * applyClaudeUsage in context-bar-popover.spec.ts, generalized to accept an
 * explicit contextWindow payload instead of a hardcoded zero-usage patch). */
async function applyUsage(
  page: Page,
  sessionId: string,
  model: { id: string; displayName: string },
  contextWindow: ContextWindowPatch,
): Promise<void> {
  await page.evaluate(
    ({ sessionId: id, model: modelPatch, contextWindow: contextWindowPatch }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
        };
      }).__zustandStores;
      stores?.session.getState().updateUsage(id, {
        model: modelPatch,
        contextWindow: contextWindowPatch,
        cost: { totalCostUsd: 0, totalDurationMs: 0 },
      });
    },
    { sessionId, model, contextWindow },
  );
}

test.describe('ContextBar context-window render gate', () => {
  test('over-budget usage (usedTokens > contextWindowSize) clamps to a full 100% critical bar', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(contextBar).toBeVisible({ timeout: 10000 });

      await applyUsage(
        page,
        SESSION_ID,
        { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
        {
          usedPercentage: 325,
          usedTokens: 650398,
          cacheTokens: 446,
          totalInputTokens: 650398,
          totalOutputTokens: 318,
          contextWindowSize: 200000,
        },
      );

      // Model pill renders as usual (separate cell from the context-usage section).
      await expect.poll(async () => contextBar.textContent(), { timeout: 5000 }).toMatch(/Opus 4\.8/);

      // The over-budget pairing is a known window (200k, not the unknown
      // sentinel), so the segment still renders - clamped to a full 100%
      // critical bar rather than the impossible 325%. Assert structurally
      // (the bar track carries a "cached (system)" title, the percent label
      // an "N% remaining" title) rather than by raw text, because the
      // SEPARATE tokens pill legitimately still shows the used-token count
      // ("650.4k") - that cell is not the context-window bar.
      await expect(contextBar).not.toContainText('325');
      await expect(contextBar.locator('[data-context-window="unknown"]')).toHaveCount(0);
      await expect(contextBar.locator('[title*="cached (system)"]')).toHaveCount(1);
      await expect(contextBar.locator('[title*="remaining"]')).toHaveCount(1);
      await expect.poll(async () => contextBar.textContent(), { timeout: 5000 }).toMatch(/100%/);
    } finally {
      await browser.close();
    }
  });

  test('consistent usage (usedTokens within contextWindowSize) shows percent and bar', async () => {
    const { browser, page } = await launchWithState(CLAUDE_RUNNING_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const contextBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(contextBar).toBeVisible({ timeout: 10000 });

      await applyUsage(
        page,
        SESSION_ID,
        { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
        {
          usedPercentage: 65,
          usedTokens: 650000,
          cacheTokens: 400000,
          totalInputTokens: 650000,
          totalOutputTokens: 1000,
          contextWindowSize: 1_000_000,
        },
      );

      await expect.poll(async () => contextBar.textContent(), { timeout: 5000 }).toMatch(/65%/);

      // The progress-bar track carries the cache/conversation breakdown as
      // its title - a stable, semantic way to assert the bar rendered
      // without depending on Tailwind class churn.
      await expect(contextBar.locator('[title*="cached (system)"]')).toHaveCount(1);
      await expect(contextBar.locator('[data-context-window="unknown"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
