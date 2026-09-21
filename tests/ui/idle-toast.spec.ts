/**
 * UI tests for the Agent Idle toast: App.tsx's `sessions.onActivity` handler
 * raises an in-app toast when a session on the open project stops and waits for
 * the user, gated by notifications.toasts.onAgentIdle.
 *
 * The desktop half of this same event lives in main and fires on the opposite
 * condition (window unfocused, or another project active), so the toast exists to
 * cover the case that one skips: the user is here but is not looking at this
 * agent. That is why the suppression cases below matter as much as the firing one.
 *
 * UI-tier (headless Chromium + mock API): the whole path is renderer store +
 * component. `window.__mockFireActivity` stands in for main's SESSION_ACTIVITY
 * broadcast and carries the same five arguments.
 *
 * Every "no toast" case here counts through `toastCountRightNow` rather than
 * `toHaveCount(0)`, and every test pushes `durationSeconds` out to a minute. Both
 * are load-bearing: the first version of this spec had four of six tests passing
 * against code that raised a toast, because the toast auto-dismissed inside the
 * retry window. See `toastCountRightNow` in ./helpers for the mechanism.
 *
 * Two more describe blocks live in this file, both because they share this
 * file's fixtures rather than because they are about the toast itself: one
 * covers auto-focus reading the SAME `ownedSessionIds` value App.tsx computes
 * for the toast, and one covers the toast's Open action re-reading the current
 * project at click time instead of at toast-creation time.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, toastCountRightNow } from './helpers';

// Each test owns its page (separate launch / goto), so the file can fan out
// across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-idle-toast';
const TASK_ID = 'task-idle-toast';
const SESSION_ID = 'session-idle-toast';
const TASK_TITLE = 'Fix the drag ghost';

// A second session/task on the same project, used only by the mobile-streamed
// suppression test below, so that test can drive one session a paired phone is
// streaming and one it is not without disturbing the fixture the other six tests
// share.
const MOBILE_SESSION_ID = 'session-idle-toast-mobile';
const MOBILE_TASK_ID = 'task-idle-toast-mobile';
const MOBILE_TASK_TITLE = 'Stream this one to the phone';

// A second project, used only by the "Open after a project switch" test below,
// so that test can leave the fixture's normal single-project shape alone.
const OTHER_PROJECT_ID = 'proj-idle-toast-other';

/** How long to let a toast that should NOT exist have to show up. */
const NEGATIVE_ASSERTION_BUDGET_MS = 300;

/** A project with one running session on a task in Code Review. */
async function launchWithState(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Idle Toast Test',
        path: '/mock/idle-toast-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-idle-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4242,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/idle-toast-test',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: '${TASK_TITLE}',
        description: 'Drives the idle toast',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
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
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  // See the header: the default 4s dismiss is inside the expect timeout, which
  // is what made the first version of every negative case here pass vacuously.
  await patchToastConfig(page, { durationSeconds: 60 });

  return { browser, page };
}

/**
 * A project with two running sessions: the fixture's normal SESSION_ID/TASK_ID
 * (used as the positive control) plus MOBILE_SESSION_ID/MOBILE_TASK_ID (the one
 * the mobile-streamed suppression test marks as phone-streamed). Both sit in
 * Code Review, same shape as `launchWithState`'s single session.
 */
async function launchWithMobileStreamedState(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Idle Toast Test',
        path: '/mock/idle-toast-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-idle-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      function pushSessionAndTask(sessionId, taskId, title) {
        state.sessions.push({
          id: sessionId,
          taskId: taskId,
          projectId: '${PROJECT_ID}',
          pid: 4242,
          status: 'running',
          shell: 'bash',
          cwd: '/mock/idle-toast-test',
          startedAt: ts,
          exitCode: null,
        });

        state.tasks.push({
          id: taskId,
          title: title,
          description: 'Drives the idle toast',
          swimlane_id: laneIds['Code Review'],
          position: 0,
          agent: 'claude',
          session_id: sessionId,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          use_worktree: 0,
          labels: [],
          priority: 0,
          attachment_count: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        });
      }

      pushSessionAndTask('${SESSION_ID}', '${TASK_ID}', '${TASK_TITLE}');
      pushSessionAndTask('${MOBILE_SESSION_ID}', '${MOBILE_TASK_ID}', '${MOBILE_TASK_TITLE}');

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  // The swimlane rendering only proves loadBoard() landed. sessions.list()'s
  // syncSessions() is a SEPARATE async round trip in the mock, so a fast run can
  // reach the assertions below before both seeded sessions are in the session
  // store, which makes resolveIdleToast's `sessionStore.sessions.find(...)`
  // silently miss and drop the toast. Wait for both explicitly rather than
  // relying on the swimlane wait to imply it.
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        session?: { getState: () => { sessions: { id: string }[] } };
        project?: { getState: () => { currentProject: { id: string } | null } };
      };
    }).__zustandStores;
    const hasProject = Boolean(stores?.session && stores?.project?.getState().currentProject);
    return hasProject ? (stores?.session?.getState().sessions.length ?? 0) : 0;
  }), { timeout: 10000 }).toBe(2);

  await patchToastConfig(page, { durationSeconds: 60 });

  return { browser, page };
}

/**
 * The fixture's normal single project (used as the toast's own project) plus a
 * second, empty project to switch to. Used only by the "Open after a project
 * switch" test below, which needs somewhere else to go.
 */
async function launchWithSecondProjectState(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Idle Toast Test',
        path: '/mock/idle-toast-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.projects.push({
        id: '${OTHER_PROJECT_ID}',
        name: 'Somewhere Else',
        path: '/mock/idle-toast-other',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-idle-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 4242,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/idle-toast-test',
        startedAt: ts,
        exitCode: null,
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: '${TASK_TITLE}',
        description: 'Drives the idle toast',
        swimlane_id: laneIds['Code Review'],
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_ID}',
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
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
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  await patchToastConfig(page, { durationSeconds: 60 });

  return { browser, page };
}

/** Patch notifications.toasts.* in the renderer config store. */
async function patchToastConfig(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((toastPatch) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { setState: (fn: (s: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((s) => {
      const notifications = s.config.notifications as { toasts: Record<string, unknown> };
      return {
        config: {
          ...s.config,
          notifications: { ...notifications, toasts: { ...notifications.toasts, ...toastPatch } },
        },
      };
    });
  }, patch);
}

/** Stand in for main's SESSION_ACTIVITY broadcast, for an arbitrary session/task. */
async function fireActivityFor(
  page: Page,
  sessionId: string,
  taskId: string,
  state: 'thinking' | 'idle' | 'permission',
): Promise<void> {
  await page.evaluate(({ sessionId, activityState, projectId, taskId }) => {
    const fire = (window as unknown as {
      __mockFireActivity?: (s: string, st: string, r: unknown, p: string, t: string) => void;
    }).__mockFireActivity;
    if (!fire) throw new Error('__mockFireActivity not installed - is sessions.onActivity subscribed?');
    fire(sessionId, activityState, { kind: activityState, since: Date.now() }, projectId, taskId);
  }, { sessionId, activityState: state, projectId: PROJECT_ID, taskId });
}

/** Stand in for main's SESSION_ACTIVITY broadcast, for the fixture's one session. */
async function fireActivity(page: Page, state: 'thinking' | 'idle' | 'permission'): Promise<void> {
  await fireActivityFor(page, SESSION_ID, TASK_ID, state);
}

/** Give a toast that should not exist a chance to appear, then count it NOW. */
async function toastCountAfterBudget(page: Page): Promise<number> {
  await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
  return toastCountRightNow(page);
}

async function openTaskDetail(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { setDetailTaskId: (taskId: string | null) => void } } };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setDetailTaskId(id);
  }, TASK_ID);
}

/** `config.autoFocusIdleSession`. Top-level, unlike the notification toggles
 *  above, which live under `notifications.toasts`. */
async function setAutoFocusIdleSession(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((value) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { setState: (fn: (s: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((s) => ({ config: { ...s.config, autoFocusIdleSession: value } }));
  }, enabled);
}

/** The bottom panel's current tab, per the session store (not the DOM). */
async function getActiveSessionId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { activeSessionId: string | null } } };
    }).__zustandStores;
    return stores?.session?.getState().activeSessionId ?? null;
  });
}

/** The window claims its session a frame after it mounts, so wait for the claim
 *  itself rather than for the window's DOM. */
async function waitForSessionClaim(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate((id) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { dialogSessionIds: string[] } } };
    }).__zustandStores;
    return stores?.session?.getState().dialogSessionIds.includes(id) ?? false;
  }, SESSION_ID), { timeout: 10000 }).toBe(true);
}

test.describe('Agent Idle toast', () => {
  // The case the whole design turns on. SESSION_ACTIVITY carries a reason-only
  // refresh on the same channel as a real transition, roughly 180 of the former
  // against 3 of the latter across a long turn. A level check would toast
  // continuously for as long as the agent kept working.
  test('a repeated idle push raises exactly one toast', async () => {
    const { browser, page } = await launchWithState();
    try {
      await fireActivity(page, 'thinking');
      await fireActivity(page, 'idle');
      await expect(page.getByTestId('toast').first()).toBeVisible();

      await fireActivity(page, 'idle');
      await fireActivity(page, 'idle');
      expect(await toastCountAfterBudget(page)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('a session that finishes its turn names the task', async () => {
    const { browser, page } = await launchWithState();
    try {
      await fireActivity(page, 'thinking');
      await fireActivity(page, 'idle');

      const toast = page.getByTestId('toast');
      await expect(toast.first()).toBeVisible();
      await expect(toast.first()).toContainText(`"${TASK_TITLE}" finished its turn`);
      expect(await toastCountRightNow(page)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('a permission-blocked session says so instead', async () => {
    const { browser, page } = await launchWithState();
    try {
      await fireActivity(page, 'thinking');
      await fireActivity(page, 'permission');

      const toast = page.getByTestId('toast');
      await expect(toast.first()).toBeVisible();
      await expect(toast.first()).toContainText(`"${TASK_TITLE}" needs permission`);
      expect(await toastCountRightNow(page)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('no toast when the setting is off', async () => {
    const { browser, page } = await launchWithState();
    try {
      await patchToastConfig(page, { onAgentIdle: false });
      await fireActivity(page, 'thinking');
      await fireActivity(page, 'idle');

      expect(await toastCountAfterBudget(page)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  // The suppression that makes the toast worth having: the user is already
  // looking at this terminal, so telling them it stopped is noise.
  test('no toast while the task detail window owns the terminal', async () => {
    const { browser, page } = await launchWithState();
    try {
      await openTaskDetail(page);
      await waitForSessionClaim(page);

      await fireActivity(page, 'thinking');
      await fireActivity(page, 'idle');

      expect(await toastCountAfterBudget(page)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('the Open action opens the task detail', async () => {
    const { browser, page } = await launchWithState();
    try {
      await fireActivity(page, 'thinking');
      await fireActivity(page, 'idle');

      await page.getByTestId('toast').getByRole('button', { name: 'Open' }).click();

      await expect.poll(async () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { getState: () => { detailTaskId: string | null } } };
        }).__zustandStores;
        return stores?.session?.getState().detailTaskId ?? null;
      }), { timeout: 10000 }).toBe(TASK_ID);
    } finally {
      await browser.close();
    }
  });

  // Coverage hole found in review: `ownedByDetailSurface`'s docblock promises
  // suppression when "a streaming phone is already rendering this terminal", but
  // the App.tsx call site omitted `mobileTerminalStreamedSessionIds` from
  // `derivePanelSessions`, so a phone-streamed session toasted anyway. The
  // positive control (the fixture's ordinary session) runs FIRST and must toast on
  // its own, so this cannot pass by the activity pipeline silently not firing.
  test('a session streamed to a paired phone does not toast, unlike an unstreamed sibling', async () => {
    const { browser, page } = await launchWithMobileStreamedState();
    try {
      await fireActivityFor(page, SESSION_ID, TASK_ID, 'thinking');
      await fireActivityFor(page, SESSION_ID, TASK_ID, 'idle');
      await expect(page.getByTestId('toast').first()).toBeVisible();
      expect(await toastCountRightNow(page)).toBe(1);

      // Seed the mobile stream only now, so this write cannot be mistaken for
      // having suppressed the control toast above.
      await page.evaluate((sessionId) => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { setState: (patch: Record<string, unknown>) => void } };
        }).__zustandStores;
        if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
        stores.session.setState({ mobileTerminalStreamedSessionIds: [sessionId] });
      }, MOBILE_SESSION_ID);

      // Same project, no detail window open, no dialog claim - the only thing
      // that should suppress this one is the mobile stream. If App.tsx drops
      // `mobileTerminalStreamedSessionIds` from its `derivePanelSessions` call,
      // this session is no longer in `owned`, and a second toast lands (count 2).
      await fireActivityFor(page, MOBILE_SESSION_ID, MOBILE_TASK_ID, 'thinking');
      await fireActivityFor(page, MOBILE_SESSION_ID, MOBILE_TASK_ID, 'idle');

      expect(await toastCountAfterBudget(page)).toBe(1);
    } finally {
      await browser.close();
    }
  });
});

/**
 * App.tsx hoisted `derivePanelSessions(...).owned` out of the auto-focus
 * branch specifically so the toast above could read it too - and in doing so
 * started passing `mobileTerminalStreamedSessionIds` into the SAME call the
 * auto-focus branch consumes, which the old inline call (scoped to the
 * auto-focus `if`) omitted. That is a real behavior change, not just a
 * relocation: a phone-streamed session going idle used to steal the bottom
 * panel from whatever the user was looking at, and now it does not.
 *
 * Nothing else pins this. `resolveAutoFocusTarget`'s own unit tests
 * (tests/unit/auto-focus.test.ts) take `ownedSessionIds` as a direct input and
 * cannot see a wiring regression between App.tsx and `derivePanelSessions`;
 * the mobile-streamed toast test above only proves the toast side of the
 * shared value, not the auto-focus side.
 */
test.describe('Auto-focus reads the same ownedSessionIds as the toast', () => {
  test('a mobile-streamed session going idle does not steal the bottom panel, unlike the same session once unstreamed', async () => {
    const { browser, page } = await launchWithMobileStreamedState();
    try {
      await setAutoFocusIdleSession(page, true);

      // Seed a deterministic baseline directly, rather than relying on the
      // panel's own mount-time tab fallback: the viewed session must be
      // THINKING, not idle/permission. If it were idle, `resolveAutoFocusTarget`'s
      // "already viewing a paused session" guard would swallow the incoming
      // idle event on its own, and the test would pass whether or not the
      // mobile session is actually excluded from `ownedSessionIds`.
      await page.evaluate(({ sessionId, mobileSessionId }) => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { setState: (patch: Record<string, unknown>) => void } };
        }).__zustandStores;
        if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
        stores.session.setState({
          activeSessionId: sessionId,
          sessionActivity: { [sessionId]: 'thinking' },
          mobileTerminalStreamedSessionIds: [mobileSessionId],
        });
      }, { sessionId: SESSION_ID, mobileSessionId: MOBILE_SESSION_ID });

      // The stimulus: the STREAMED session finishes its turn. A broken wiring
      // (mobile stream omitted from ownedSessionIds) would switch the panel to
      // it - there is no "already viewing a paused session" guard to catch
      // that omission here, since the viewed session is thinking, not paused.
      await fireActivityFor(page, MOBILE_SESSION_ID, MOBILE_TASK_ID, 'thinking');
      await fireActivityFor(page, MOBILE_SESSION_ID, MOBILE_TASK_ID, 'idle');

      // Give a wrongly-triggered switch a chance to land, then read state now.
      // (Intentional fixed wait - "the tab did not change" cannot be polled for.)
      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await getActiveSessionId(page)).toBe(SESSION_ID);

      // Positive control, same page, same session: un-stream it and repeat the
      // exact same transition. If this does NOT now switch the panel, the
      // suppression above was never about ownership at all (auto-focus could
      // be silently broken by the `setAutoFocusIdleSession` call, an unrelated
      // gate, or the fixture), and the negative assertion means nothing.
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { setState: (patch: Record<string, unknown>) => void } };
        }).__zustandStores;
        stores?.session?.setState({ mobileTerminalStreamedSessionIds: [] });
      });
      await fireActivityFor(page, MOBILE_SESSION_ID, MOBILE_TASK_ID, 'thinking');
      await fireActivityFor(page, MOBILE_SESSION_ID, MOBILE_TASK_ID, 'idle');

      await expect.poll(() => getActiveSessionId(page), { timeout: 10000 }).toBe(MOBILE_SESSION_ID);
    } finally {
      await browser.close();
    }
  });
});

/**
 * `openTaskFromNotification`'s docblock (App.tsx) states the current project
 * is re-read at CLICK time rather than captured by the caller, because a toast
 * can sit for `durationSeconds` while the user switches projects. Nothing
 * exercised that through the toast's own Open action: the existing same-project
 * click test (above) never switches projects, and the existing cross-project
 * click test (sidebar-command-terminals.spec.ts) drives the OS-notification
 * caller, whose projects already differ the instant the click fires - it
 * cannot distinguish a live re-read from a value captured when the toast (or
 * notification) was first raised.
 */
test.describe('The Open action re-reads the current project at click time', () => {
  test('clicking Open after switching away from the toast\'s project reopens that project instead of opening the detail in place', async () => {
    const { browser, page } = await launchWithSecondProjectState();
    try {
      await fireActivity(page, 'thinking');
      await fireActivity(page, 'idle');

      const toast = page.getByTestId('toast');
      await expect(toast.first()).toBeVisible();

      // Leave the toast up (durationSeconds is 60) and switch to a different
      // project before clicking it - exactly the scenario the docblock names.
      await page.evaluate(async (otherProjectId) => {
        const stores = (window as unknown as {
          __zustandStores?: { project?: { getState: () => { openProject: (id: string) => Promise<void> } } };
        }).__zustandStores;
        if (!stores?.project) throw new Error('project store not exposed on __zustandStores');
        await stores.project.getState().openProject(otherProjectId);
      }, OTHER_PROJECT_ID);

      await expect.poll(async () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { project?: { getState: () => { currentProject: { id: string } | null } } };
        }).__zustandStores;
        return stores?.project?.getState().currentProject?.id ?? null;
      }), { timeout: 10000 }).toBe(OTHER_PROJECT_ID);

      const openCallsBeforeClick = await page.evaluate(
        () => (window.electronAPI.projects as unknown as { __openCalls: string[] }).__openCalls.slice(),
      );
      expect(openCallsBeforeClick).toEqual([OTHER_PROJECT_ID]);

      await toast.getByRole('button', { name: 'Open' }).click();

      // Primary assertion: it re-read the (now different) current project and
      // took the cross-project branch, which is the ONLY branch that calls
      // openProject again. A stale "was current when the toast was raised"
      // read would instead call setDetailTaskId directly and never touch
      // __openCalls a second time.
      await expect.poll(async () => page.evaluate(
        () => (window.electronAPI.projects as unknown as { __openCalls: string[] }).__openCalls,
      ), { timeout: 5000 }).toEqual([OTHER_PROJECT_ID, PROJECT_ID]);

      // End to end: the switch actually lands back on the toast's project...
      await expect.poll(async () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { project?: { getState: () => { currentProject: { id: string } | null } } };
        }).__zustandStores;
        return stores?.project?.getState().currentProject?.id ?? null;
      }), { timeout: 10000 }).toBe(PROJECT_ID);

      // ...and the detail opens there (via the parked pendingOpenTaskId), not
      // as a direct write against the project the user had switched to.
      await expect.poll(async () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { getState: () => { detailTaskId: string | null } } };
        }).__zustandStores;
        return stores?.session?.getState().detailTaskId ?? null;
      }), { timeout: 10000 }).toBe(TASK_ID);
    } finally {
      await browser.close();
    }
  });
});
