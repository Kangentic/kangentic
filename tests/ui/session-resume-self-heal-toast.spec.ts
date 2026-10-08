/**
 * UI tests for the self-heal toast that fires when `resumeSession` returns
 * the SAME session id the renderer was already displaying.
 *
 * Background (branch: switching-projects-d-368fa13a):
 * After a rapid project switch the renderer can hold a stale 'suspended'
 * entry for a session whose PTY is actually still alive in main. When the
 * user clicks Resume, the IPC handler detects the live PTY and returns the
 * existing session object unchanged (same id, status='running') instead of
 * spawning a new one. useTaskActions detects this condition and shows an
 * info toast: "Reconnected to running session".
 *
 * Gap 2: Toast fires when resumed id === prior id and status === 'running'.
 * Gap 3: Toast does NOT fire when resumed id !== prior id (normal spawn).
 *
 * Tier: UI (headless Chromium). The logic under test lives entirely in
 * useTaskActions.ts and the React store layer -- no PTY or real IPC needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Unique run suffix so parallel workers don't collide on shared mock state.
const RUN_ID = Date.now();
const PROJECT_ID = `proj-self-heal-${RUN_ID}`;
const TASK_ID = `task-self-heal-${RUN_ID}`;
const SESSION_ID = `sess-self-heal-${RUN_ID}`;

/**
 * Launch a headless page pre-configured with:
 *   - A project with default swimlanes
 *   - A task in the "Executing" column (non-todo, non-done)
 *   - A suspended session linked to that task
 *
 * Executing is a non-todo lane, so canToggle=true and the Resume button
 * is shown in TaskDetailBody.
 */
async function launchWithSuspendedTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });

  // Pre-configure: project + swimlanes + suspended session + task in Executing lane
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Self-Heal Toast Test ${RUN_ID}',
        path: '/mock/self-heal-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Create swimlanes using DEFAULT_SWIMLANES so roles are correct.
      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-sh-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      // Resolve plan_exit_target_id for Planning lane
      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // Create a suspended session for the task
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: null,
        status: 'suspended',
        shell: 'bash',
        cwd: '/mock/self-heal-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });

      // Task in Executing lane with session_id null (user-paused state)
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Self-Heal Toast Task ${RUN_ID}',
        description: 'Tests the reconnected-to-running-session toast',
        swimlane_id: executingLaneId,
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        labels: [],
        priority: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

/**
 * Open the task detail dialog by clicking the task card.
 * Waits for the dialog to mount before returning.
 */
async function openTaskDialog(page: Page): Promise<void> {
  const card = page.locator(`[data-task-id="${TASK_ID}"]`);
  await card.waitFor({ state: 'visible', timeout: 5000 });
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the task detail dialog using document-level Escape dispatch.
 * Using page.keyboard.press('Escape') would send the key to any focused
 * xterm widget inside the dialog (anti-pattern 10); dispatching at the
 * document level bypasses that.
 */
async function closeTaskDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
}

// ---------------------------------------------------------------------------
// Gap 2: Resume self-heal -- same id returned -> "Reconnected" toast fires
// ---------------------------------------------------------------------------
test.describe('Resume self-heal toast (same session id returned)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithSuspendedTask());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('shows "Reconnected to running session" info toast when resume returns the same session id', async () => {
    // Override sessions.resume to return the SAME session id with status='running'.
    // This simulates main's self-heal path: the PTY was live all along, so main
    // returns the existing session object instead of spawning a new one.
    await page.evaluate((sessionId) => {
      const originalResume = window.electronAPI.sessions.resume.bind(window.electronAPI.sessions);
      window.electronAPI.sessions.resume = async function (taskId: string) {
        // Ignore the original; return the existing session with status='running'
        void originalResume;
        return {
          id: sessionId,
          taskId: taskId,
          projectId: '',
          pid: 12345,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/path',
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
        };
      };
    }, SESSION_ID);

    await openTaskDialog(page);

    // Confirm the Resume session button is present
    const resumeButton = page.locator('button:has-text("Resume session")');
    await expect(resumeButton).toBeVisible({ timeout: 3000 });

    await resumeButton.click();

    // Poll for the toast with the specific reconnect message
    await expect(
      page.locator('[data-testid="toast"]').filter({ hasText: 'Reconnected to running session' }),
    ).toBeVisible({ timeout: 5000 });

    await closeTaskDialog(page);
  });
});

// ---------------------------------------------------------------------------
// Gap 3: Normal spawn -- different id returned -> no "Reconnected" toast
// ---------------------------------------------------------------------------
test.describe('Normal session spawn does not show reconnect toast', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithSuspendedTask());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('does not show "Reconnected" toast when resume returns a different session id', async () => {
    // Override sessions.resume to return a DIFFERENT session id.
    // This is the normal fresh-spawn path.
    await page.evaluate(() => {
      window.electronAPI.sessions.resume = async function (taskId: string) {
        return {
          id: 'new-session-id-from-spawn-' + Math.random().toString(36).slice(2),
          taskId: taskId,
          projectId: '',
          pid: 99999,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/path',
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
        };
      };
    });

    await openTaskDialog(page);

    const resumeButton = page.locator('button:has-text("Resume session")');
    await expect(resumeButton).toBeVisible({ timeout: 3000 });

    await resumeButton.click();

    // Intentional fixed wait: we cannot poll for non-occurrence. We give any
    // latent reconnect toast 800ms to appear, then assert it never did.
    // 800ms is well above the React render cycle but short enough not to
    // interfere with the toast auto-dismiss timer (default 4s).
    await page.waitForTimeout(800);

    const reconnectToastCount = await page
      .locator('[data-testid="toast"]')
      .filter({ hasText: 'Reconnected to running session' })
      .count();
    expect(reconnectToastCount).toBe(0);

    await closeTaskDialog(page);
  });
});
