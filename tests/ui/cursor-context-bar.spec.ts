/**
 * UI tests for the ContextBar model pill resolving for Cursor sessions.
 *
 * Gap 8: Cursor task spawned in permissionMode='default' (interactive TUI)
 * eventually resolves the model pill via the attachSession/applyUsage path.
 * In interactive mode, Cursor emits no stream-json NDJSON, so the only
 * mechanism that populates SessionUsage.model is the `agent about --format
 * json` call made by CursorAdapter.attachSession(). The resolved model name
 * arrives as a SessionUsage patch via applyUsage -> usageTracker.setSessionUsage
 * -> IPC 'usage' event -> session-store.updateUsage -> ContextBar re-render.
 *
 * We cannot invoke real IPC here (UI tier). Instead we simulate the final
 * step - the store update - by calling updateUsage directly via
 * __zustandStores, which mirrors exactly what the IPC listener does in
 * production. This is the canonical UI-tier pattern for "event arrives from
 * backend" without needing a real PTY.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-cursor-ctx-bar';
const TASK_ID = 'task-cursor-ctx-bar';
const SESSION_ID = 'sess-cursor-ctx-bar';
const SWIMLANE_ID = 'lane-cursor-todo';

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
 * Pre-configure script: Cursor session in running/idle state with no usage
 * (simulates the moment after spawn before attachSession resolves).
 * permissionMode is 'default' (interactive TUI) - the scenario where
 * stream-json is not emitted and attachSession is the only model source.
 */
const CURSOR_INTERACTIVE_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Cursor ContextBar Test',
      path: '/mock/cursor-ctx-bar',
      github_url: null,
      default_agent: 'cursor',
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
      cwd: '/mock/cursor-ctx-bar',
      startedAt: ts,
      exitCode: null,
      resuming: false,
    });

    // No activityCache entry - simulates the moment before any CLI signal
    // (same as noActivityCache: true in task-activity-indicators tests)

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Cursor Interactive Task',
      description: '',
      swimlane_id: '${SWIMLANE_ID}',
      position: 0,
      agent: 'cursor',
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

test.describe('Cursor ContextBar model pill', () => {
  test('shows "Starting agent..." spinner before usage arrives (interactive TUI spawn)', async () => {
    const { browser, page } = await launchWithState(CURSOR_INTERACTIVE_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator('[data-testid="usage-bar"]').first();
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      // No usage yet - must show "Starting agent..." spinner (not the model name)
      await expect(usageBar).toContainText('Starting agent...');
      await expect(usageBar.locator('.lucide-loader-circle')).toBeVisible();
      await expect(usageBar).not.toContainText('Cursor');
    } finally {
      await browser.close();
    }
  });

  test('resolves model pill when usage arrives via applyUsage (end-to-end path for attachSession)', async () => {
    const { browser, page } = await launchWithState(CURSOR_INTERACTIVE_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator('[data-testid="usage-bar"]').first();
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      // Before: "Starting agent..." spinner (no model resolved yet)
      await expect(usageBar).toContainText('Starting agent...');

      // Simulate what applyUsage -> usageTracker.setSessionUsage -> IPC 'usage'
      // event -> session-store.updateUsage does in production.
      // updateUsage is the final step that causes ContextBar to re-render.
      //
      // We pass a full SessionUsage object (not just { model }) because TaskCard
      // unconditionally dereferences usage.contextWindow.totalInputTokens when
      // usage is truthy. A partial patch would crash the component before it
      // could render the model name. In production, UsageTracker.setSessionUsage
      // deep-merges into the existing entry, so the contextWindow sub-object is
      // always populated before the model field arrives. We replicate that here.
      await page.evaluate(
        (sessionId: string) => {
          const stores = (window as unknown as {
            __zustandStores?: {
              session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
            };
          }).__zustandStores;
          stores?.session.getState().updateUsage(sessionId, {
            model: { id: 'auto', displayName: 'Auto' },
            contextWindow: {
              usedPercentage: 0,
              usedTokens: 0,
              cacheTokens: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              contextWindowSize: 0,
            },
            cost: { totalCostUsd: 0, totalDurationMs: 0 },
          });
        },
        SESSION_ID,
      );

      // After: model name replaces the spinner
      await expect.poll(async () => {
        return page.locator('[data-testid="usage-bar"]').first().textContent();
      }, { timeout: 5000 }).toMatch(/Auto/);

      await expect(usageBar).not.toContainText('Starting agent...');
    } finally {
      await browser.close();
    }
  });
});
