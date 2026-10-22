/**
 * The Agent paused toast: App.tsx's `sessions.onIdleTimeout` handler raises it
 * when a session on the open project was auto-suspended after N idle minutes
 * (the Pausing agents setting). `window.__mockFireIdleTimeout` stands in for
 * main's `session:idleTimeout` push and carries its four arguments
 * (session id, task id, minutes, project id).
 *
 * - The body names the task on the board and the idle time, "1 minute" in the
 *   singular and "N minutes" otherwise.
 * - The card opens that task's detail on a click.
 *
 * This sits beside idle-toast.spec.ts (the activity-driven Agent idle toast)
 * because it is a different push with its own copy; the fixture is the same
 * project with one running session on a task in Code Review.
 *
 * Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage } from './helpers';

test.describe.configure({ mode: 'parallel' });

const PROJECT_ID = 'proj-idle-timeout';
const TASK_ID = 'task-idle-timeout';
const SESSION_ID = 'session-idle-timeout';
const TASK_TITLE = 'Fix the drag ghost';

async function launchWithRunningSession(): Promise<{ browser: Browser; page: Page }> {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => {
      await target.addInitScript(`
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Idle Timeout Test',
            path: '/mock/idle-timeout-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          var laneIds = {};
          state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
            var id = 'lane-idle-timeout-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
            laneIds[swimlane.name] = id;
            state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
          });
          state.sessions.push({
            id: '${SESSION_ID}',
            taskId: '${TASK_ID}',
            projectId: '${PROJECT_ID}',
            pid: 4242,
            status: 'running',
            shell: 'bash',
            cwd: '/mock/idle-timeout-test',
            startedAt: ts,
            exitCode: null,
          });
          state.tasks.push({
            id: '${TASK_ID}',
            title: '${TASK_TITLE}',
            description: 'Drives the idle timeout toast',
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
    },
  });
  // The lane renders once loadBoard() landed, so the task is in the board store
  // the handler reads its title from.
  await page.locator(`[data-board-lanes] [data-task-id="${TASK_ID}"]`).waitFor({ state: 'visible', timeout: 10000 });
  // A timed toast closes at durationSeconds (4s by default); keep it up for the click.
  await page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { setState: (update: (state: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((state) => {
      const notifications = state.config.notifications as { toasts: Record<string, unknown> };
      return {
        config: {
          ...state.config,
          notifications: { ...notifications, toasts: { ...notifications.toasts, durationSeconds: 60 } },
        },
      };
    });
  });
  return { browser, page };
}

/** Stand in for main's `session:idleTimeout` push, after the guard that App.tsx has subscribed. */
async function fireIdleTimeout(page: Page, minutes: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__mockFireIdleTimeout === 'function'), {
      message: 'App.tsx is not subscribed to sessions.onIdleTimeout',
    })
    .toBe(true);
  await page.evaluate(({ sessionId, taskId, idleMinutes, projectId }) => {
    if (!window.__mockFireIdleTimeout) throw new Error('window.__mockFireIdleTimeout is not installed');
    window.__mockFireIdleTimeout(sessionId, taskId, idleMinutes, projectId);
  }, { sessionId: SESSION_ID, taskId: TASK_ID, idleMinutes: minutes, projectId: PROJECT_ID });
}

async function detailTaskId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { session?: { getState: () => { detailTaskId: string | null } } };
    }).__zustandStores;
    return stores?.session?.getState().detailTaskId ?? null;
  });
}

test.describe('Agent paused toast (idle timeout)', () => {
  test('one idle minute reads "1 minute", and the card opens the task', async () => {
    const { browser, page } = await launchWithRunningSession();
    try {
      await fireIdleTimeout(page, 1);

      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Agent paused');
      await expect(toast.getByTestId('toast-body')).toHaveText(`"${TASK_TITLE}" was idle for 1 minute.`);
      await expect(toast).toHaveAttribute('data-variant', 'info');

      // A timed toast has no button: the card itself opens the task.
      expect(await detailTaskId(page)).toBeNull();
      await toast.getByTestId('toast-body').click({ timeout: 3000 });
      await expect.poll(() => detailTaskId(page), { timeout: 10000 }).toBe(TASK_ID);
    } finally {
      await browser.close();
    }
  });

  test('several idle minutes read "N minutes"', async () => {
    const { browser, page } = await launchWithRunningSession();
    try {
      await fireIdleTimeout(page, 5);

      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Agent paused');
      await expect(toast.getByTestId('toast-body')).toHaveText(`"${TASK_TITLE}" was idle for 5 minutes.`);
    } finally {
      await browser.close();
    }
  });
});
