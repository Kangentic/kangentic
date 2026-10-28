/**
 * UI tests for the idle that ends a task agent's own call: App.tsx's
 * `sessions.onActivity` handler must raise no idle toast and must not move
 * auto-focus when the push's reason carries `inOwnCall: true`.
 *
 * Main flags an idle that way while the session's own `kangentic_move_task` or
 * `kangentic_pause_workflow` is still taking effect (`ipc/handlers/sessions.ts`).
 * That turn belongs to the call, which ends the session moments later, so a
 * toast would name an agent that is leaving and auto-focus would pull the bottom
 * panel to a terminal that is about to close.
 *
 * Two independent gates read the flag in App.tsx: the auto-focus branch
 * (`&& !endsOwnCall`) and the toast (`endsOwnCall` handed to `resolveIdleToast`).
 * Each has its own test so a revert of one fails exactly one of them. Each test
 * carries its control on the same page: the same thinking -> idle transition
 * WITHOUT the flag does toast and does move focus, so a suppression can never be
 * mistaken for the activity pipeline not firing.
 *
 * UI-tier (headless Chromium + mock API): the path is renderer store + App.tsx's
 * subscription. `window.__mockFireActivity` stands in for main's SESSION_ACTIVITY
 * broadcast. Fixtures mirror ./idle-toast.spec.ts; see its header for why every
 * "no toast" check counts through `toastCountRightNow` with a 60 s toast duration.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, toastCountRightNow, gotoVite } from './helpers';

// Each test owns its page (separate launch / goto), so the file can fan out
// across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-idle-own-call';

// The session the user is looking at, thinking the whole time.
const VIEWED_SESSION_ID = 'session-idle-own-call-viewed';
const VIEWED_TASK_ID = 'task-idle-own-call-viewed';
const VIEWED_TASK_TITLE = 'Keep watching this one';

// The session whose idle is under test.
const OWN_SESSION_ID = 'session-idle-own-call-subject';
const OWN_TASK_ID = 'task-idle-own-call-subject';
const OWN_TASK_TITLE = 'Move itself to review';

/** How long to let a toast or a focus change that should NOT happen have to show up. */
const NEGATIVE_ASSERTION_BUDGET_MS = 300;

/** A project with two running sessions on tasks in Code Review. */
async function launchWithTwoSessions(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Idle Own Call Test',
        path: '/mock/idle-own-call-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-own-call-' + s.name.toLowerCase().replace(/\\s+/g, '-');
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
          cwd: '/mock/idle-own-call-test',
          startedAt: ts,
          exitCode: null,
        });

        state.tasks.push({
          id: taskId,
          title: title,
          description: 'Drives the own-call idle',
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

      pushSessionAndTask('${VIEWED_SESSION_ID}', '${VIEWED_TASK_ID}', '${VIEWED_TASK_TITLE}');
      pushSessionAndTask('${OWN_SESSION_ID}', '${OWN_TASK_ID}', '${OWN_TASK_TITLE}');

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 10000 });

  // The swimlane rendering only proves loadBoard() landed. sessions.list() is a
  // SEPARATE async round trip in the mock, and the handler under test silently
  // drops a push for a session the store has not seen, so wait for both.
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

  // The default 4 s dismiss is inside the expect timeout, which is what made the
  // first version of every negative toast case in idle-toast.spec.ts pass
  // vacuously.
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { setState: (fn: (s: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((s) => {
      const notifications = s.config.notifications as { toasts: Record<string, unknown> };
      return {
        config: {
          ...s.config,
          notifications: { ...notifications, toasts: { ...notifications.toasts, durationSeconds: 60 } },
        },
      };
    });
  });

  return { browser, page };
}

/** `config.autoFocusIdleSession`, top-level in the config. */
async function enableAutoFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { setState: (fn: (s: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((s) => ({ config: { ...s.config, autoFocusIdleSession: true } }));
  });
}

/** Make the viewed session the bottom panel's tab, and thinking. */
async function viewSessionWhileThinking(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((viewedSessionId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { setState: (patch: Record<string, unknown>) => void } };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.setState({
      activeSessionId: viewedSessionId,
      sessionActivity: { [viewedSessionId]: 'thinking' },
    });
  }, sessionId);
}

/** Stand in for main's SESSION_ACTIVITY broadcast for the session under test. */
async function fireOwnSession(
  page: Page,
  state: 'thinking' | 'idle',
  options: { inOwnCall?: true } = {},
): Promise<void> {
  await page.evaluate(({ sessionId, taskId, projectId, activityState, inOwnCall }) => {
    const fire = (window as unknown as {
      __mockFireActivity?: (s: string, st: string, r: unknown, p: string, t: string) => void;
    }).__mockFireActivity;
    if (!fire) throw new Error('__mockFireActivity not installed - is sessions.onActivity subscribed?');
    const reason = inOwnCall
      ? { kind: activityState, since: Date.now(), inOwnCall: true }
      : { kind: activityState, since: Date.now() };
    fire(sessionId, activityState, reason, projectId, taskId);
  }, {
    sessionId: OWN_SESSION_ID,
    taskId: OWN_TASK_ID,
    projectId: PROJECT_ID,
    activityState: state,
    inOwnCall: options.inOwnCall === true,
  });
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

test.describe('The idle that ends a task agent\'s own call', () => {
  test('raises no toast, while the same idle without the flag does', async () => {
    const { browser, page } = await launchWithTwoSessions();
    try {
      // thinking first: the toast fires on the EDGE into idle, so an idle with no
      // prior thinking would be a no-op for the wrong reason.
      await fireOwnSession(page, 'thinking');
      await fireOwnSession(page, 'idle', { inOwnCall: true });

      // Intentional fixed wait: "no toast" cannot be polled for.
      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);

      // Control, same page and session: the same transition without the flag.
      await fireOwnSession(page, 'thinking');
      await fireOwnSession(page, 'idle');

      const toast = page.getByTestId('toast');
      await expect(toast.first()).toBeVisible();
      await expect(toast.first().getByTestId('toast-body')).toHaveText(`"${OWN_TASK_TITLE}" is waiting on you.`);
      expect(await toastCountRightNow(page)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  test('does not move auto-focus, while the same idle without the flag does', async () => {
    const { browser, page } = await launchWithTwoSessions();
    try {
      await enableAutoFocus(page);
      // A deterministic baseline: the viewed session is THINKING, not idle or
      // permission, so the resolver's "already viewing a paused session" guard
      // cannot swallow the incoming idle on its own and pass this vacuously.
      await viewSessionWhileThinking(page, VIEWED_SESSION_ID);
      expect(await getActiveSessionId(page)).toBe(VIEWED_SESSION_ID);

      await fireOwnSession(page, 'thinking');
      await fireOwnSession(page, 'idle', { inOwnCall: true });

      // Intentional fixed wait: "the tab did not change" cannot be polled for.
      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await getActiveSessionId(page)).toBe(VIEWED_SESSION_ID);

      // Control, same page and session: the same transition without the flag
      // must switch the panel. If it does not, the suppression above was never
      // about the flag (auto-focus off, the fixture, an unrelated gate).
      await fireOwnSession(page, 'thinking');
      await fireOwnSession(page, 'idle');

      await expect.poll(() => getActiveSessionId(page), { timeout: 10000 }).toBe(OWN_SESSION_ID);
    } finally {
      await browser.close();
    }
  });
});
