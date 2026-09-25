/**
 * UI tests for the Plan Complete toast, raised by App.tsx's `tasks.onAutoMoved`
 * handler when the transition engine auto-moves a task on plan completion.
 *
 * The case that matters is the PROJECT GATE. The push is cross-project (main
 * sends it for whichever project auto-moved), and the toast used to fire
 * regardless, naming a task on a board the user was not looking at. The desktop
 * notification fires for precisely that background case, so one event raised two
 * alerts. The toast is now active-project only, like its siblings.
 *
 * Negative cases count through `toastCountRightNow` rather than `toHaveCount(0)`;
 * see that helper for why a retrying matcher passes against a raised toast.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, toastCountRightNow } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-plan-complete';
const OTHER_PROJECT_ID = 'proj-plan-complete-other';
const TASK_ID = 'task-plan-complete';
const TASK_TITLE = 'Draft the migration plan';

/** How long to let a toast that should NOT exist have to show up. */
const NEGATIVE_ASSERTION_BUDGET_MS = 300;

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
        name: 'Plan Complete Test',
        path: '/mock/plan-complete-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.projects.push({
        id: '${OTHER_PROJECT_ID}',
        name: 'Background Project',
        path: '/mock/plan-complete-other',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-plan-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      state.tasks.push({
        id: '${TASK_ID}',
        title: '${TASK_TITLE}',
        description: 'Drives the plan-complete toast',
        swimlane_id: laneIds['Planning'],
        position: 0,
        agent: 'claude',
        session_id: null,
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
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 10000 });

  // A toast auto-dismisses at durationSeconds (4s), inside Playwright's expect
  // timeout. Push it out so a vanished toast is never read as one never raised.
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

/** Stand in for main's TASK_AUTO_MOVED push. */
async function fireAutoMoved(page: Page, projectId: string): Promise<void> {
  await page.evaluate(({ taskId, title, movedProjectId }) => {
    const fire = (window as unknown as {
      __mockFireTaskAutoMoved?: (t: string, lane: string, title: string, projectId: string) => void;
    }).__mockFireTaskAutoMoved;
    if (!fire) throw new Error('__mockFireTaskAutoMoved not installed - is tasks.onAutoMoved subscribed?');
    fire(taskId, 'lane-plan-executing', title, movedProjectId);
  }, { taskId: TASK_ID, title: TASK_TITLE, movedProjectId: projectId });
}

test.describe('Plan Complete toast', () => {
  test('an auto-move on the open project toasts, naming the task', async () => {
    const { browser, page } = await launchWithState();
    try {
      await fireAutoMoved(page, PROJECT_ID);

      const toast = page.getByTestId('toast');
      await expect(toast.first()).toBeVisible();
      await expect(toast.first()).toContainText(`Plan complete. Moved "${TASK_TITLE}" to next column`);
    } finally {
      await browser.close();
    }
  });

  // The regression this file exists for. The desktop notification covers a
  // background auto-move; a toast about a board you cannot see is noise on top
  // of it.
  test('an auto-move on a background project raises no toast', async () => {
    const { browser, page } = await launchWithState();
    try {
      await fireAutoMoved(page, OTHER_PROJECT_ID);

      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);

      // Positive control on the same page: the handler IS subscribed and does
      // toast, so the zero above is the gate and not a dead listener.
      await fireAutoMoved(page, PROJECT_ID);
      await expect(page.getByTestId('toast').first()).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('no toast when the setting is off', async () => {
    const { browser, page } = await launchWithState();
    try {
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { config: { setState: (fn: (s: { config: Record<string, unknown> }) => unknown) => void } };
        }).__zustandStores;
        stores?.config.setState((s) => {
          const notifications = s.config.notifications as { toasts: Record<string, unknown> };
          return {
            config: {
              ...s.config,
              notifications: { ...notifications, toasts: { ...notifications.toasts, onPlanComplete: false } },
            },
          };
        });
      });

      await fireAutoMoved(page, PROJECT_ID);

      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
