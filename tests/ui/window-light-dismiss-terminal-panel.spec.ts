/**
 * UI tests for light-dismissing an open task-detail window via the bottom
 * terminal panel, and for the one thing in it that must NEVER dismiss.
 *
 * Click-outside (light-dismiss) is a DENYLIST (`useClickOutsideToClose.ts`):
 * a clean click on dead space anywhere in the app shell closes the focused
 * task-detail window, unless the target is excluded. The terminal panel is
 * ordinary shell like the toolbar or the status bar, and needs no marker to
 * dismiss - so the interesting case here is the exclusion, not the dismissal.
 *
 * A live panel is excluded by three sibling markers plus one selector, and the
 * split is deliberate. `data-no-dismiss` sits on the tab-bar row, the session-pane
 * wrapper, and the ContextBar, because those are SIBLINGS - no one of them contains
 * the others, so each needs its own. `.xterm` in the hook's excluded-control
 * selector is a second guarantee under the pane wrapper. See the comments in
 * `TerminalPanel.tsx` and `useClickOutsideToClose.ts` for why each is kept; do not
 * re-derive xterm's cursor CSS here.
 *
 * Test A: the empty panel dismisses. This passes because EVERYTHING in the shell
 * dismisses now, not because of any per-state marking on the panel. (It predates
 * the inversion, when the panel opted into being a dismiss surface only while no
 * live pane was mounted, via a `hasLiveTerminal` conditional that no longer
 * exists. Same outcome, different reason.)
 * Test B: a mounted live terminal pane must never dismiss. This is the
 * load-bearing guard for both exclusions above.
 * Test B2: the ContextBar below the pane - a SIBLING, not a child, so the pane
 * wrapper's own `data-no-dismiss` never covered it - must never dismiss either.
 * Regression guard: when the inversion landed, the root-level `hasLiveTerminal`
 * exclusion that used to cover the whole live panel was deleted and replaced with
 * `data-no-dismiss` on the pane wrapper alone, which silently left the ContextBar's
 * padding, its inter-pill gaps, and every text-only pill (shell, version, cost,
 * tokens, elapsed, the "Starting agent..." spinner) as dismissible dead space.
 * Test C: with the Activity tab active no pane wrapper is mounted at all, so its
 * dead space dismisses like the rest of the shell.
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

    // Dismisses because the panel is ordinary shell inside AppLayout's
    // `data-dismiss-layer="board"` subtree, and nothing here is excluded - NOT because the
    // panel opts into being a dismiss surface in this particular state.
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

    // The pane wrapper: covered by its `data-no-dismiss`, which is what protects the
    // pane's non-xterm children (LaunchOverlay, FileDropOverlay).
    await dispatchCleanClickOn(page, '[data-testid="terminal-session-pane"]');

    // Intentional fixed wait - we cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);

    // The xterm element itself - the click a user makes to focus a running agent's terminal
    // and type. Note this does NOT isolate the `.xterm` exclusion: `closest()` walks up to the
    // wrapper's `data-no-dismiss` too, so deleting `.xterm` from the hook's selector leaves
    // this assertion green. The `.xterm` branch is a second guarantee for the day the wrapper
    // marker is dropped, and only `tests/unit/light-dismiss-action-cursor.test.ts` pins that
    // it still exists. Asserted here anyway because this exact target is the one that must
    // never dismiss, whichever exclusion catches it.
    await page.locator('[data-testid="terminal-session-pane"] .xterm').first()
      .waitFor({ state: 'visible', timeout: 5000 });
    await dispatchCleanClickOn(page, '[data-testid="terminal-session-pane"] .xterm');

    // Intentional fixed wait - we cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Test B2: the ContextBar itself (not just the pane wrapper) never dismisses
// (regression guard - see the file header for what this pins).
// ---------------------------------------------------------------------------

test('the bottom panel\'s ContextBar dead space does NOT dismiss the open task-detail window (regression guard)', async () => {
  const { browser, page } = await launchWithState(buildLiveTerminalPreConfig());
  try {
    await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
    await setPolicy(page, 'single');

    await openWindow(page, 'No Session Task');
    await pollWindowCount(page, 1);

    // Same fixture as Test B: the live session auto-selects as the active tab, which
    // mounts both the pane and its sibling ContextBar below it.
    await page.locator('[data-testid="terminal-session-pane"]').waitFor({ state: 'visible', timeout: 5000 });

    // Scoped to the BOTTOM PANEL's instance. The task-detail dialog renders its own
    // ContextBar too (also `data-testid="usage-bar"`), already excluded wholesale by
    // `data-window-layer-root` - anchoring on `terminal-panel-container` (AppLayout's
    // wrapper around TerminalPanel) is what proves the click below lands on the panel's
    // copy, not the dialog's.
    const panelUsageBar = page.locator('[data-testid="terminal-panel-container"] [data-testid="usage-bar"]');
    await panelUsageBar.waitFor({ state: 'visible', timeout: 5000 });
    await expect(panelUsageBar).toHaveCount(1);
    // The open window here is the NO-session task, so its dialog renders no ContextBar of
    // its own - confirms the count above cannot be passing vacuously against a second,
    // dialog-hosted match.
    await expect(page.locator('[data-testid="task-detail-dialog"] [data-testid="usage-bar"]')).toHaveCount(0);

    // Dispatched on the bar's OWN root (not a pill inside it) - exactly the element
    // `data-no-dismiss` sits on. None of its pills show a pointer cursor, so the cursor
    // heuristic in useClickOutsideToClose.ts cannot exclude them without this marker.
    await dispatchCleanClickOn(page, '[data-testid="terminal-panel-container"] [data-testid="usage-bar"]');

    // Intentional fixed wait - we cannot poll for non-occurrence.
    await page.waitForTimeout(400);
    await pollWindowCount(page, 1);
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------
// Test C: with the Activity tab active, no terminal pane wrapper is mounted, so
// the panel's dead space dismisses like the rest of the shell. This is the
// boundary of the exclusion: it must cover a live pane and nothing more.
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
    // sentinel and the terminal pane unmounts (only the active tab's pane is ever
    // mounted), taking its `data-no-dismiss` wrapper and its `.xterm` with it.
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

// NOTE: an earlier revision of this file included a "Test D" for the case where the
// active session is claimed by its own task-detail window. It was removed because that
// state is architecturally transient rather than one a test can wait for: AppLayout's
// `shouldForceCollapseTerminal` force-collapses the whole panel the instant
// `dialogSessionIds.length > 0`, so the window to click closes with the ~200ms CSS
// transition. It failed intermittently on CI (`TimeoutError` waiting for the pane
// container, because the transition had already finished and the whole
// `{showContent && (...)}` block had unmounted).
//
// It is a non-issue under the denylist. A window-owned session renders no pane wrapper at
// all, so there is nothing to exclude and nothing to keep in sync - the old
// `hasLiveTerminal` conditional this test chased has been deleted. The panel's actual
// force-collapse behavior is covered by `tests/ui/terminal-no-flash-on-switch.spec.ts`.
