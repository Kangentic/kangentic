/**
 * UI test for the board task-detail window layer being hidden (not torn down)
 * when the active view switches from Board to Backlog.
 *
 * Regression coverage for: a board task's detail window (and its live agent
 * terminal) stayed painted over the Backlog view because `<WindowLayer />` is
 * mounted unconditionally in AppLayout, outside the `activeView === 'board'`
 * gate. The fix keeps the layer (and its session bridges / PTY) mounted at all
 * times, but makes the overlay `invisible` off the board - so this test asserts
 * the window is hidden AND still attached (never unmounted) while on Backlog,
 * then visible again after switching back.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-window-backlog-hide';
const TASK_ID = 'task-window-backlog-hide';
const SESSION_ID = 'sess-window-backlog-hide';

const preConfig = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();

    state.projects.push({
      id: '${PROJECT_ID}',
      name: 'Window Backlog Hide Test',
      path: '/mock/window-backlog-hide-test',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });

    var laneIds = {};
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
      laneIds[s.name] = id;
      state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
    });

    // Running session so the task-detail window opens with a live terminal.
    state.sessions.push({
      id: '${SESSION_ID}',
      taskId: '${TASK_ID}',
      projectId: '${PROJECT_ID}',
      pid: 9999,
      status: 'running',
      shell: 'bash',
      cwd: '/mock/window-backlog-hide-test',
      startedAt: ts,
      exitCode: null,
    });

    state.tasks.push({
      id: '${TASK_ID}',
      display_id: 1,
      title: 'Live Agent Task',
      description: 'Task used to verify the window layer hides over Backlog',
      swimlane_id: laneIds['Code Review'],
      position: 0,
      agent: 'claude',
      session_id: '${SESSION_ID}',
      worktree_path: '/mock/worktrees/window-backlog-hide',
      branch_name: 'feature/window-backlog-hide',
      pr_number: null,
      pr_url: null,
      base_branch: 'main',
      archived_at: null,
      created_at: ts,
      updated_at: ts,
    });

    return { currentProjectId: '${PROJECT_ID}' };
  });
`;

async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('Window layer: hidden over Backlog, restored on Board', () => {
  test('task-detail window stays attached but hidden on Backlog, and reappears on Board', async () => {
    const { browser, page } = await launchWithState();
    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });

      // Open the task-detail window for the running-session task.
      const card = page
        .locator('[data-swimlane-name="Code Review"]')
        .locator('text=Live Agent Task')
        .first();
      await card.click();

      const dialog = page.locator('[data-testid="task-detail-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await expect(dialog).toBeVisible();

      // Switch to Backlog: the backlog list renders and the board columns hide,
      // but the task-detail window must stay ATTACHED (session/PTY alive) while
      // becoming invisible (no layering over the backlog).
      await page.locator('[data-testid="view-toggle-backlog"]').click();
      await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();
      await expect(page.locator('[data-swimlane-name="Code Review"]')).not.toBeVisible();

      await expect(dialog).not.toBeVisible();
      await expect(dialog).toBeAttached();

      // The overlay itself carries the hidden state (visibility:hidden via `invisible`).
      const overlay = page.locator('[data-testid="window-overlay"]');
      await expect(overlay).toHaveClass(/invisible/);

      // The underlying session is untouched by the view switch - it is still
      // tracked as running, proving the agent kept working in the background.
      const sessionStillRunning = await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { getState: () => { sessions: Array<{ id: string; status: string }> } } };
        }).__zustandStores;
        const session = stores?.session?.getState().sessions.find((candidate) => candidate.id === sessionId);
        return session?.status === 'running';
      }, SESSION_ID);
      expect(sessionStillRunning).toBe(true);

      // Switch back to Board: the SAME window frame reappears (never remounted).
      await page.locator('[data-testid="view-toggle-board"]').click();
      await expect(page.locator('[data-swimlane-name="Code Review"]')).toBeVisible();
      await expect(overlay).not.toHaveClass(/invisible/);
      await expect(dialog).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
