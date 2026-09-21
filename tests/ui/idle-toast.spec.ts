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
