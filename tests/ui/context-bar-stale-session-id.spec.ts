/**
 * Red-green guard for the ContextBar model/effort picker vanishing after a
 * live column model change.
 *
 * Root cause: a model-override restart (column edit or manual override)
 * suspends the old session and respawns a new one; the DB `tasks.session_id`
 * is updated to the new session, but the board store keeps the stale
 * (now-exited) session id until the next reload. `ContextBar` used to join
 * its task via `tasks.find(t => t.session_id === sessionId)`, which misses
 * once the board row is stale, dropping the interactive model/effort
 * triggers in favor of static pill text.
 *
 * This spec seeds that exact mismatch directly (no restart needed to
 * reproduce it): a running, non-transient session whose own `taskId` names a
 * real task, but whose task row's `session_id` points at a dangling id that
 * is never itself seeded as a session (modeling "exited/gone"). The fix
 * resolves the task via the session's own `taskId` instead, so the pickers
 * mount regardless of the task's stale `session_id`.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-ctx-bar-stale-session';
const TASK_ID = 'task-ctx-bar-stale-session';
const LIVE_SESSION_ID = 'sess-ctx-bar-live';
const STALE_SESSION_ID = 'sess-ctx-bar-stale-gone';
const SWIMLANE_ID = 'lane-ctx-bar-stale-session';

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

// Task's session_id points at STALE_SESSION_ID (never seeded as a session -
// models an exited session after a restart). The one running session in the
// project is LIVE_SESSION_ID, whose own taskId correctly names TASK_ID.
const STALE_SESSION_PRECONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Stale Session ContextBar Test',
      path: '/mock/ctx-bar-stale-session',
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
      id: '${LIVE_SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/ctx-bar-stale-session',
      startedAt: ts,
      exitCode: null,
      resuming: false,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      title: 'Stale Session Task',
      description: '',
      swimlane_id: '${SWIMLANE_ID}',
      position: 0,
      agent: 'claude',
      session_id: '${STALE_SESSION_ID}',
      worktree_path: null,
      branch_name: null,
      pr_number: null,
      pr_url: null,
      base_branch: null,
      labels: [],
      priority: 0,
      model_override: null,
      effort_override: null,
      attachment_count: 0,
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function applyClaudeUsage(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session: { getState: () => { updateUsage: (id: string, data: unknown) => void } };
      };
    }).__zustandStores;
    stores?.session.getState().updateUsage(id, {
      model: { id: 'opus', displayName: 'Opus 4.8 (1M context)', effort: 'high' },
      contextWindow: {
        usedPercentage: 0,
        usedTokens: 0,
        cacheTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        contextWindowSize: 1_000_000,
      },
      cost: { totalCostUsd: 0, totalDurationMs: 0 },
    });
  }, sessionId);
}

test.describe('ContextBar model/effort picker - stale task.session_id', () => {
  test('renders interactive triggers by resolving the task via the session\'s own taskId', async () => {
    const { browser, page } = await launchWithState(STALE_SESSION_PRECONFIG);
    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      const usageBar = page.locator('[data-testid="usage-bar"].min-h-8');
      await expect(usageBar).toBeVisible({ timeout: 10000 });

      await applyClaudeUsage(page, LIVE_SESSION_ID);

      // Sanity check: the board's task row genuinely carries the stale,
      // never-seeded session id (not the live session rendering this bar).
      const taskSessionId = await page.evaluate((taskId) => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { tasks: Array<{ id: string; session_id: string | null }> } } };
        }).__zustandStores;
        return stores?.board.getState().tasks.find((row) => row.id === taskId)?.session_id ?? null;
      }, TASK_ID);
      expect(taskSessionId).toBe(STALE_SESSION_ID);

      // The join must succeed via session.taskId despite the stale forward
      // pointer, so both pickers mount as interactive buttons, not static text.
      await expect(page.locator('[data-testid="context-bar-model-trigger"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="context-bar-effort-trigger"]')).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
