/**
 * UI tests for the proactive self-heal probe in the task detail dialog.
 *
 * Background:
 * The renderer's `sessions[]` cache can drift from main's PTY registry: it
 * may show `status='suspended'` for a task whose PTY is actually still
 * running (HMR listener gap, optimistic suspend in suspendSession, etc.).
 * Without this fix the dialog paints the lone "Resume session" button even
 * though the session is alive and the bottom panel can show its scrollback.
 *
 * The fix: `useTaskSessionState` calls `sessions.reconcile(taskId)` on dialog
 * mount when `session.status === 'suspended'`. If main returns a live
 * Session, the store upserts it and the dialog re-renders with the active
 * terminal. If main returns null, the resume branch renders as before.
 *
 * Tier: UI (headless Chromium). The logic under test lives in the renderer
 * effect + store action; no PTY or real IPC needed.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_ID = Date.now();
const PROJECT_ID = `proj-reconcile-${RUN_ID}`;
const TASK_ID = `task-reconcile-${RUN_ID}`;
const SESSION_ID = `sess-reconcile-${RUN_ID}`;

/**
 * Launch a headless page pre-configured with a task in the Executing lane
 * whose session is `status='suspended'` in the renderer cache. Each test
 * then overrides `sessions.reconcile` to drive either the heal path or
 * the confirm-suspended path before opening the dialog.
 *
 * `liveSiblingId` adds a SECOND row for the same task, `status='running'`,
 * listed AFTER the suspended one: the shape main's registry exported when a
 * stale suspended row leaked ahead of the task's live PTY.
 */
async function launchWithStaleSuspendedTask(
  options: { liveSiblingId?: string } = {},
): Promise<{ browser: Browser; page: Page }> {
  const liveSiblingSeed = options.liveSiblingId
    ? `
      state.sessions.push({
        id: '${options.liveSiblingId}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 60208,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/reconcile-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });`
    : '';
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });

  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Reconcile Probe Test ${RUN_ID}',
        path: '/mock/reconcile-${RUN_ID}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var executingLaneId = null;
      state.DEFAULT_SWIMLANES.forEach(function (template, index) {
        var laneId = 'lane-rc-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
        if (template.name === 'Executing') executingLaneId = laneId;
        state.swimlanes.push(Object.assign({}, template, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // Stale suspended session in the renderer cache. The probe should
      // detect this on dialog mount and reconcile against the mock's
      // reconcile() override (set per-test below).
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: null,
        status: 'suspended',
        shell: 'bash',
        cwd: '/mock/reconcile-${RUN_ID}',
        startedAt: ts,
        exitCode: null,
        resuming: false,
      });
      ${liveSiblingSeed}

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Reconcile Probe Task ${RUN_ID}',
        description: 'Tests the proactive reconcile-on-mount probe',
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

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

  return { browser, page };
}

async function openTaskDialog(page: Page): Promise<void> {
  const card = page.locator(`[data-task-id="${TASK_ID}"]`);
  await card.waitFor({ state: 'visible', timeout: 5000 });
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Heal path: probe returns live session -> store swaps to running -> terminal
// ---------------------------------------------------------------------------
test.describe('Task detail proactive reconcile - heal path', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithStaleSuspendedTask());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('opens directly into the active terminal when reconcile returns a running session', async () => {
    // Override reconcile to return the SAME session id but with status='running',
    // simulating the bug case: renderer cache says suspended, main says running.
    await page.evaluate((sessionId) => {
      window.electronAPI.sessions.reconcile = async function (taskId: string) {
        return {
          id: sessionId,
          taskId: taskId,
          projectId: '',
          pid: 4242,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/reconcile',
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
        };
      };
    }, SESSION_ID);

    await openTaskDialog(page);

    // The probe runs in a useEffect on mount. Once it resolves, the store
    // updates and the dialog re-renders without the Resume button. Polling
    // accommodates the IPC roundtrip + React commit.
    // Scoped to the task-detail-dialog so a future Resume button outside
    // the dialog cannot produce a strict-mode violation here.
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    const resumeButton = dialog.locator('button:has-text("Resume session")');
    await expect(resumeButton).toBeHidden({ timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// Project-switch round-trip: stale renderer view survives navigating away
// and back. Covers the user-visible bug where the renderer's session cache
// drifts to 'suspended' for a task whose PTY is still alive on main, and the
// dialog paints "Resume session" after the round-trip. With the heal-by-
// taskId fallback in `reconcileTaskSessionRef`, main re-discovers the live
// session and the renderer probe swaps it in on dialog mount.
// ---------------------------------------------------------------------------
test.describe('Task detail proactive reconcile - survives project-switch round-trip', () => {
  let browser: Browser;
  let page: Page;
  const OTHER_PROJECT_ID = `proj-other-${RUN_ID}`;

  test.beforeAll(async () => {
    await waitForViteReady(VITE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    page = await context.newPage();

    await page.addInitScript({ path: MOCK_SCRIPT });

    // Two-project fixture: project A holds the stale-suspended task + cached
    // session entry; project B is an empty sibling so the sidebar has
    // somewhere to navigate to and back.
    await page.addInitScript(`
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();

        state.projects.push({
          id: '${PROJECT_ID}',
          name: 'Reconcile Probe Test ${RUN_ID}',
          path: '/mock/reconcile-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });
        state.projects.push({
          id: '${OTHER_PROJECT_ID}',
          name: 'Other Project ${RUN_ID}',
          path: '/mock/other-${RUN_ID}',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });

        var executingLaneId = null;
        state.DEFAULT_SWIMLANES.forEach(function (template, index) {
          var laneId = 'lane-rt-' + template.name.toLowerCase().replace(/\\s+/g, '-') + '-${RUN_ID}';
          if (template.name === 'Executing') executingLaneId = laneId;
          state.swimlanes.push(Object.assign({}, template, {
            id: laneId,
            position: index,
            created_at: ts,
          }));
        });

        var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
        var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
        if (planningLane && executingLane) {
          planningLane.plan_exit_target_id = executingLane.id;
        }

        // Stale suspended session in the renderer cache - same bug shape
        // as the single-project fixture above. After the project round-trip
        // re-runs syncSessions, this entry is still what the dialog sees
        // because the mock's sessions list is project-agnostic and returns
        // it on every list() call.
        state.sessions.push({
          id: '${SESSION_ID}',
          taskId: '${TASK_ID}',
          projectId: '${PROJECT_ID}',
          pid: null,
          status: 'suspended',
          shell: 'bash',
          cwd: '/mock/reconcile-${RUN_ID}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
        });

        state.tasks.push({
          id: '${TASK_ID}',
          title: 'Round-trip Probe Task ${RUN_ID}',
          description: 'Verifies reconcile survives project switch',
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

    await page.goto(VITE_URL);
    await page.waitForLoadState('load');
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 10000 });

    // Mock the heal: reconcile probe returns a running session, simulating
    // main's heal-by-taskId fallback finding the live PTY.
    await page.evaluate((sessionId) => {
      window.electronAPI.sessions.reconcile = async function (taskId: string) {
        return {
          id: sessionId,
          taskId: taskId,
          projectId: '',
          pid: 4242,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/reconcile',
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
        };
      };
    }, SESSION_ID);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('Resume button stays hidden after switching projects and re-opening the dialog', async () => {
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    const resumeButton = dialog.locator('button:has-text("Resume session")');

    // Round 1: open the dialog, verify the probe healed it.
    await openTaskDialog(page);
    await expect(resumeButton).toBeHidden({ timeout: 3000 });

    // Close the dialog before navigating - its overlay intercepts clicks
    // on the sidebar. The X button is the canonical close affordance and
    // is always rendered in the dialog header.
    await page.locator('[data-testid="task-detail-close"]').click();
    await dialog.waitFor({ state: 'hidden', timeout: 3000 });

    // Switch to the other project, then back. App.tsx's currentProject
    // useEffect re-runs syncSessions on each change; the mock keeps the
    // stale-suspended session in state.sessions across both calls.
    await page.locator(`[data-testid="project-row-${OTHER_PROJECT_ID}"]`).click();
    await page.locator(`[data-testid="project-row-${PROJECT_ID}"]`).click();

    // Wait for project A's board to re-render before re-opening the task.
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 5000 });

    // Round 2: re-open the dialog. The bug repro would now paint Resume;
    // with the fix in place the probe re-fires and heals on this fresh
    // dialog mount (probedKeyRef is component-instance scoped, so a fresh
    // mount always probes once).
    await openTaskDialog(page);
    await expect(resumeButton).toBeHidden({ timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// Confirm-suspended path: probe returns null -> Resume button still renders
// ---------------------------------------------------------------------------
test.describe('Task detail proactive reconcile - genuinely suspended', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithStaleSuspendedTask());
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('keeps the Resume button when reconcile confirms no live session', async () => {
    // Override reconcile to return null (no live session on main). The
    // default mock impl already does this for suspended fixtures, but
    // setting it explicitly makes the test intent obvious.
    await page.evaluate(() => {
      window.electronAPI.sessions.reconcile = async function () {
        return null;
      };
    });

    // Attach the pageerror listener BEFORE opening the dialog so the
    // probe's mount window is covered. The probe fires inside a
    // useEffect during dialog mount; attaching after openTaskDialog
    // would miss any error thrown during that mount frame. Known-benign
    // renderer errors are filtered by the shared collector.
    const getPageErrors = collectPageErrors(page);

    await openTaskDialog(page);

    // Scoped to the task-detail-dialog to avoid strict-mode violations if
    // a Resume button is ever added elsewhere in the UI.
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    const resumeButton = dialog.locator('button:has-text("Resume session")');
    await expect(resumeButton).toBeVisible({ timeout: 3000 });

    // Negative assertion: the probe path produces no uncaught errors.
    // The store action's catch logs a warning, not a pageerror, so a
    // clean console is the right signal here.
    await page.waitForTimeout(300);
    expect(getPageErrors()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Two rows for one task, stale first: the selector must prefer the live row.
//
// Main's registry once exported [suspended, running] for a task (a leaked
// placeholder or a settings restart the spawn did not fully drain). The hook
// resolved the FIRST array match and painted "Resume session" over a running
// agent, while the board card (which resolves through the index) showed it
// running. The probe could not heal it either: the running row's id was
// already in the array, so the heal replaced it in place and left the stale
// sibling in front. The probe is disabled here so a heal cannot mask a
// first-wins regression in the selector itself.
// ---------------------------------------------------------------------------
test.describe('Task detail - stale suspended row listed ahead of the live session', () => {
  let browser: Browser;
  let page: Page;
  const LIVE_SESSION_ID = `sess-live-${RUN_ID}`;

  test.beforeAll(async () => {
    ({ browser, page } = await launchWithStaleSuspendedTask({ liveSiblingId: LIVE_SESSION_ID }));
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('opens into the live terminal without the reconcile probe', async () => {
    await page.evaluate(() => {
      window.electronAPI.sessions.reconcile = async function () {
        return null;
      };
    });
    const getPageErrors = collectPageErrors(page);

    await openTaskDialog(page);

    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await expect(dialog.locator('button:has-text("Resume session")')).toBeHidden({ timeout: 3000 });
    // Hidden because the LIVE row won, not because no session resolved at all.
    await expect(dialog.getByText('No active session')).toBeHidden({ timeout: 3000 });

    await page.waitForTimeout(300);
    expect(getPageErrors()).toHaveLength(0);
  });
});
