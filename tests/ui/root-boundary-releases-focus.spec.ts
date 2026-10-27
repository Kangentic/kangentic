/**
 * Regression spec: a render error the ROOT error boundary catches releases the
 * window's terminal focus, and Try again publishes it again.
 *
 * Task #912. A dev hot update threw under the root `ErrorBoundary`, which
 * unmounted the whole tree while the page lived on. The page kept its pty port
 * and its last published focus set, so the pty host went on posting a
 * session's output to an xterm that no longer existed. Nothing acked it, the
 * in-flight count passed the backpressure high water, and the agent sat paused
 * for ten minutes until a reload. A packaged build does the same on any error
 * the root boundary catches.
 *
 * The fix publishes an empty set from `ErrorBoundary.componentDidCatch`, not
 * from an unmount effect: Fast Refresh re-runs every effect, so an unmount
 * cleanup would drop and restore the focus on every dev save.
 *
 * The throw is real: a null `swimlanes` in the board store makes AppLayout's
 * render throw (a selector reads its length), outside any `PanelErrorBoundary`.
 * The spec asserts the root
 * fallback is on screen before it reads the focus log, so a future hardening
 * that stops the throw fails loudly instead of passing vacuously.
 *
 * How to verify RED / GREEN: delete the `setFocused([])` line in
 * `ErrorBoundary.componentDidCatch`. The "released" assertion goes red.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROJECT_ID = `proj-root-boundary-${RUN_ID}`;
const TASK_ID = `task-root-boundary-${RUN_ID}`;
const SESSION_ID = `sess-root-boundary-${RUN_ID}`;

function preConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Root Boundary ${RUN_ID}',
        path: '/mock/root-boundary-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-rb-${RUN_ID}-' + index;
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId, position: index, created_at: ts,
        }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 7200,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/root-boundary-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });
      state.tasks.push({
        id: '${TASK_ID}',
        display_id: 1,
        title: 'Root Boundary Task ${RUN_ID}',
        description: '',
        swimlane_id: executingLaneId,
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
      state.activityCache['${SESSION_ID}'] = 'thinking';

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

interface BoundaryTestWindow {
  electronAPI: { sessions: { __setFocusedCalls: string[][] } };
  __zustandStores: {
    board: {
      getState(): { swimlanes: unknown };
      setState(partial: Record<string, unknown>): void;
    };
  };
  __savedSwimlanes?: unknown;
}

/** The most recent focused set the renderer published to main. */
const latestFocusedSet = (page: Page) => page.evaluate(() => {
  const calls = (window as unknown as BoundaryTestWindow).electronAPI.sessions.__setFocusedCalls;
  return calls.length > 0 ? calls[calls.length - 1] : null;
});

test('the root error boundary releases the window\'s terminal focus, and Try again publishes it again', async () => {
  await waitForViteReady(VITE_URL);
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await page.addInitScript({ path: MOCK_SCRIPT });
    await page.addInitScript(preConfig());
    await gotoVite(page, VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });

    // The panel shows the running session, so main streams it to this window.
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => latestFocusedSet(page), { timeout: 10000 }).toContain(SESSION_ID);

    // A render throw under the root boundary. setState runs the store's own
    // subscribers synchronously, and one of them may throw too; the render
    // error is the one that matters, so a subscriber's is swallowed here.
    await page.evaluate(() => {
      const testWindow = window as unknown as BoundaryTestWindow;
      const board = testWindow.__zustandStores.board;
      testWindow.__savedSwimlanes = board.getState().swimlanes;
      try {
        board.setState({ swimlanes: null });
      } catch {
        // A subscriber outside React threw; React still re-renders and throws.
      }
    });
    await expect(page.locator('h1', { hasText: 'Something went wrong' })).toBeVisible({ timeout: 10000 });

    // Released: nothing under the boundary can ack a byte now.
    await expect.poll(() => latestFocusedSet(page), { timeout: 10000 }).toEqual([]);

    // Put the state right and retry: the remount publishes the panel's session again.
    await page.evaluate(() => {
      const testWindow = window as unknown as BoundaryTestWindow;
      testWindow.__zustandStores.board.setState({ swimlanes: testWindow.__savedSwimlanes });
    });
    await page.locator('[data-testid="root-error-retry"]').click();
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
    await expect.poll(() => latestFocusedSet(page), { timeout: 10000 }).toContain(SESSION_ID);
  } finally {
    await browser.close();
  }
});
