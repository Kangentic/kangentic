/**
 * UI tests for light-dismissing an open task-detail window via the bottom
 * terminal panel's dead space.
 *
 * The terminal panel is normally excluded from the click-outside
 * (light-dismiss) surface set (`useClickOutsideToClose.ts`, the
 * `[data-dismiss-surface]` allowlist) so that clicking into a live terminal
 * never closes an open task-detail window. That exclusion used to be
 * unconditional: it also blocked dismissal when the panel had no live
 * terminal to interact with (the empty "No active sessions" state).
 * `TerminalPanel.tsx` now marks its dead space as a dismiss surface only when
 * no live terminal pane is mounted (`hasLiveTerminal`).
 *
 * Test A proves the fix: the empty panel dismisses like the rest of the app
 * shell. Test B is the regression guard: a mounted live terminal pane must
 * still never dismiss.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own browser/page from a known state, so the file's
// tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);

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

/** Open the task-detail window for a task by clicking its card. */
async function openWindow(page: Page, taskTitle: string): Promise<void> {
  const card = page.locator(`text=${taskTitle}`).first();
  await card.click();
  const dialog = page.locator('[data-testid="task-detail-dialog"]');
  await dialog.first().waitFor({ state: 'visible', timeout: 5000 });
}

/** Assert that the count of open task-detail windows eventually reaches `expected`. */
async function pollWindowCount(page: Page, expected: number, timeoutMs = 3000): Promise<void> {
  await expect
    .poll(
      () => page.locator('[data-testid="task-detail-dialog"]').count(),
      { timeout: timeoutMs, intervals: [100, 150, 200, 300] },
    )
    .toBe(expected);
}

/** Set the `windowLightDismiss` policy via the config store. */
async function setPolicy(page: Page, policy: 'off' | 'single' | 'focused' | 'all'): Promise<void> {
  await page.evaluate((policyValue) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { updateConfig: (patch: Record<string, unknown>) => void } } };
    }).__zustandStores;
    stores?.config.getState().updateConfig({ windowLightDismiss: policyValue });
  }, policy);
}

/** Dispatch a clean (0px-travel) pointerdown + pointerup pair on the first
 *  element matching `selector` via `dispatchEvent`, so `event.target` is
 *  deterministic regardless of viewport/layout (never `page.mouse`). */
async function dispatchCleanClickOn(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 3000 });
  await page.evaluate((selectorArg) => {
    const element = document.querySelector(selectorArg);
    if (!element) throw new Error(`no element for selector: ${selectorArg}`);
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientX: 200,
      clientY: 700,
    };
    element.dispatchEvent(new PointerEvent('pointerdown', init));
    element.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  }, selector);
}

// ---------------------------------------------------------------------------
// Test A: empty terminal panel light-dismisses
// ---------------------------------------------------------------------------

const EMPTY_PROJECT_ID = `proj-term-empty-dismiss-${RUN_SUFFIX}`;
const EMPTY_TASK_ID = `task-term-empty-${RUN_SUFFIX}`;

function buildEmptyPanelPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${EMPTY_PROJECT_ID}',
        name: 'Empty Terminal Panel Dismiss Test',
        path: '/mock/empty-terminal-dismiss-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-etd-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // To Do task, no session -> opens in edit mode and claims no session,
      // so dialogSessionIds stays empty and the panel is not force-collapsed.
      // With no running sessions anywhere, the panel renders its empty state.
      state.tasks.push({
        id: '${EMPTY_TASK_ID}',
        display_id: 1,
        title: 'Empty Panel Task',
        description: '',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${EMPTY_PROJECT_ID}' };
    });
  `;
}

test('empty terminal panel dead space light-dismisses the open task-detail window', async () => {
  const { browser, page } = await launchWithState(buildEmptyPanelPreConfig());
  try {
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    await setPolicy(page, 'single');

    await openWindow(page, 'Empty Panel Task');
    await pollWindowCount(page, 1);

    // No running sessions anywhere -> the panel shows its empty state.
    await page.locator('[data-testid="terminal-panel-empty"]').waitFor({ state: 'visible', timeout: 5000 });

    await dispatchCleanClickOn(page, '[data-testid="terminal-panel-empty"]');
    await pollWindowCount(page, 0);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Test B: a mounted live terminal pane never dismisses (regression guard)
// ---------------------------------------------------------------------------

const LIVE_PROJECT_ID = `proj-term-live-no-dismiss-${RUN_SUFFIX}`;
const LIVE_SESSION_TASK_ID = `task-term-live-sess-${RUN_SUFFIX}`;
const LIVE_SESSION_ID = `sess-term-live-${RUN_SUFFIX}`;
const LIVE_NO_SESSION_TASK_ID = `task-term-live-nosess-${RUN_SUFFIX}`;

function buildLiveTerminalPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${LIVE_PROJECT_ID}',
        name: 'Live Terminal No-Dismiss Test',
        path: '/mock/live-terminal-no-dismiss-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-tln-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // Task with a running session -> its terminal auto-mounts in the
      // bottom panel (the only session, unclaimed by any window).
      state.sessions.push({
        id: '${LIVE_SESSION_ID}',
        taskId: '${LIVE_SESSION_TASK_ID}',
        projectId: '${LIVE_PROJECT_ID}',
        pid: 5001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/live-terminal-no-dismiss-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        isolatedSwimlaneId: null,
      });
      state.tasks.push({
        id: '${LIVE_SESSION_TASK_ID}',
        display_id: 1,
        title: 'Live Session Task',
        description: '',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: '${LIVE_SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.activityCache['${LIVE_SESSION_ID}'] = 'idle';

      // A separate To Do task with NO session: its window claims nothing, so
      // dialogSessionIds stays empty and the panel keeps showing the live
      // session's terminal above (not force-collapsed).
      state.tasks.push({
        id: '${LIVE_NO_SESSION_TASK_ID}',
        display_id: 2,
        title: 'No Session Task',
        description: '',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${LIVE_PROJECT_ID}' };
    });
  `;
}

test('a live terminal pane in the bottom panel does NOT dismiss the open task-detail window', async () => {
  const { browser, page } = await launchWithState(buildLiveTerminalPreConfig());
  try {
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    await setPolicy(page, 'single');

    await openWindow(page, 'No Session Task');
    await pollWindowCount(page, 1);

    // The live session is auto-selected as the active tab and mounts its
    // terminal pane (the open window claims no session, so the panel is not
    // force-collapsed).
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: 5000 });

    await dispatchCleanClickOn(page, '[data-testid="terminal-session-pane"]');

    // Intentional fixed wait - we cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Test C: selecting the Activity tab makes the dead space a dismiss surface
// again (covers the `!isActivityActive` term of `hasLiveTerminal`)
// ---------------------------------------------------------------------------

const ACTIVITY_PROJECT_ID = `proj-term-activity-dismiss-${RUN_SUFFIX}`;
const ACTIVITY_SESSION_TASK_ID = `task-term-activity-sess-${RUN_SUFFIX}`;
const ACTIVITY_SESSION_ID = `sess-term-activity-${RUN_SUFFIX}`;
const ACTIVITY_NO_SESSION_TASK_ID = `task-term-activity-nosess-${RUN_SUFFIX}`;

function buildActivityTabPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${ACTIVITY_PROJECT_ID}',
        name: 'Activity Tab Dismiss Test',
        path: '/mock/activity-tab-dismiss-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-tad-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // Task with a running session -> its terminal auto-mounts in the
      // bottom panel (the only session, unclaimed by any window).
      state.sessions.push({
        id: '${ACTIVITY_SESSION_ID}',
        taskId: '${ACTIVITY_SESSION_TASK_ID}',
        projectId: '${ACTIVITY_PROJECT_ID}',
        pid: 5002,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/activity-tab-dismiss-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        isolatedSwimlaneId: null,
      });
      state.tasks.push({
        id: '${ACTIVITY_SESSION_TASK_ID}',
        display_id: 1,
        title: 'Activity Session Task',
        description: '',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: '${ACTIVITY_SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.activityCache['${ACTIVITY_SESSION_ID}'] = 'idle';

      // A separate To Do task with NO session: its window claims nothing, so
      // dialogSessionIds stays empty and the panel keeps showing the live
      // session's terminal (or the Activity tab) above.
      state.tasks.push({
        id: '${ACTIVITY_NO_SESSION_TASK_ID}',
        display_id: 2,
        title: 'No Session Task (Activity)',
        description: '',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${ACTIVITY_PROJECT_ID}' };
    });
  `;
}

test('selecting the Activity tab makes the panel dead space light-dismiss the open task-detail window', async () => {
  const { browser, page } = await launchWithState(buildActivityTabPreConfig());
  try {
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    await setPolicy(page, 'single');

    await openWindow(page, 'No Session Task (Activity)');
    await pollWindowCount(page, 1);

    // Starts on the live session's tab, same as Test B.
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: 5000 });

    // Switch to the Activity tab: effectiveActiveId becomes the ACTIVITY_TAB
    // sentinel, isActivityActive flips true, hasLiveTerminal flips false, and
    // the terminal pane unmounts (only the active tab's pane is ever mounted).
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'hidden', timeout: 5000 });

    // The Activity tab has no events pushed by the mock, so it renders its
    // own empty state. There's no data-testid on it (production source is
    // out of scope for this test), so target its root by its class list,
    // which is unique in the DOM given BacklogView/DiffViewer (the only
    // other elements that share individual classes) are not mounted here.
    const activityLogRoot = '.h-full.w-full.bg-surface.flex.flex-col.font-mono.px-2';
    await dispatchCleanClickOn(page, activityLogRoot);
    await pollWindowCount(page, 0);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Test D: a session claimed by its own task-detail window (`dialogSessionIds`)
// makes the dead space a dismiss surface even while `showContent` stays true
// (covers the `!dialogSessionIds.includes(effectiveActiveId)` term of
// `hasLiveTerminal`).
//
// A direct store poke (`useSessionStore.getState().claimDialogSession(id)`,
// mirroring how `setPolicy` pokes the config store) was tried first and
// rejected: `useWindowSessionClaims.ts` reconciles `dialogSessionIds` to
// exactly the set of sessions owned by currently-open windows on every
// `windows`/`sessions` change, so a poke that doesn't correspond to a real
// open window is stomped back to `[]` on the very next effect pass. The
// non-flaky way to reach this state is the real mechanism: open the
// task-detail window for the task that OWNS the running session.
// `useTaskSessionState`'s `useLayoutEffect` (`claimDialogSession`) then runs
// synchronously before paint - not a race against a timer - and the claim
// persists deterministically for as long as the window stays open (the
// steady "one xterm per session" state documented in CLAUDE.md), which is
// exactly the condition this term guards against.
// ---------------------------------------------------------------------------

const DIALOG_OWNED_PROJECT_ID = `proj-term-dialog-owned-${RUN_SUFFIX}`;
const DIALOG_OWNED_SESSION_TASK_ID = `task-term-dialog-owned-sess-${RUN_SUFFIX}`;
const DIALOG_OWNED_SESSION_ID = `sess-term-dialog-owned-${RUN_SUFFIX}`;

function buildDialogOwnedPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${DIALOG_OWNED_PROJECT_ID}',
        name: 'Dialog Owned Session Dismiss Test',
        path: '/mock/dialog-owned-dismiss-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-tdo-' + i;
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // Task with a running session -> its terminal auto-mounts in the
      // bottom panel (the only session, unclaimed by any window).
      state.sessions.push({
        id: '${DIALOG_OWNED_SESSION_ID}',
        taskId: '${DIALOG_OWNED_SESSION_TASK_ID}',
        projectId: '${DIALOG_OWNED_PROJECT_ID}',
        pid: 5003,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/dialog-owned-dismiss-test',
        startedAt: ts,
        exitCode: null,
        resuming: false,
        isolatedSwimlaneId: null,
      });
      state.tasks.push({
        id: '${DIALOG_OWNED_SESSION_TASK_ID}',
        display_id: 1,
        title: 'Dialog Owned Session Task',
        description: '',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: '${DIALOG_OWNED_SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
      state.activityCache['${DIALOG_OWNED_SESSION_ID}'] = 'idle';

      return { currentProjectId: '${DIALOG_OWNED_PROJECT_ID}' };
    });
  `;
}

test('a window that claims its own session (dialogSessionIds) makes the panel dead space light-dismiss even while showContent stays true', async () => {
  const { browser, page } = await launchWithState(buildDialogOwnedPreConfig());
  try {
    await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
    await setPolicy(page, 'single');

    // Before any window opens, the session's terminal auto-mounts in the
    // bottom panel (unclaimed).
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: 5000 });

    // Opening the task-detail window for the task that OWNS this session
    // claims it into dialogSessionIds synchronously on mount (see the
    // comment above this test block for why this - not a store poke - is
    // the deterministic way to reach this state).
    await openWindow(page, 'Dialog Owned Session Task');
    await pollWindowCount(page, 1);

    // The panel's pane mount filter excludes any session in
    // dialogSessionIds, so it unmounts even though effectiveActiveId is
    // unchanged and showContent is still true.
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'hidden', timeout: 5000 });

    // The now-empty pane container has no data-testid; its class list is
    // unique within the marked dismiss-surface root (BacklogView/DiffViewer,
    // the only elements sharing individual classes, are not mounted here).
    const panelPaneContainer = '[data-dismiss-surface] .flex-1.min-h-0.relative';
    await dispatchCleanClickOn(page, panelPaneContainer);
    await pollWindowCount(page, 0);
  } finally {
    await browser.close();
  }
});
