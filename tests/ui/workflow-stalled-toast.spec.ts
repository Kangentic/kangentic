/**
 * The Workflow stalled toast: App.tsx's `tasks.onWorkflowStalled` handler raises
 * it when a running workflow stalls on a task. `window.__mockFireWorkflowStalled`
 * stands in for main's `workflow:stalled` push (a `WorkflowStalledEvent`).
 *
 * - The toast is titled "Workflow stalled", its body names the task and says why
 *   (`"<task>": <reason>`, or just the reason when the title is empty), and it
 *   is a warning.
 * - It is for the project on screen only. Main raises the desktop notification
 *   itself, so a stall on another board gets no toast.
 * - `notifications.toasts.onWorkflowStalled` turns it off.
 * - A click on the card opens the task.
 *
 * Negative cases count through `toastCountRightNow` rather than `toHaveCount(0)`
 * (see that helper for why a retrying matcher passes against a raised toast),
 * and each one ends in a positive control on the same page, so a zero reads as
 * the gate and not as a listener that never subscribed.
 *
 * Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, toastCountRightNow } from './helpers';

test.describe.configure({ mode: 'parallel' });

const PROJECT_ID = 'proj-workflow-stalled';
const OTHER_PROJECT_ID = 'proj-workflow-stalled-other';
const WORKFLOW_ID = 'wf-stalled';
const TASK_ID = 'task-workflow-stalled';
const TASK_TITLE = 'Refuse to spawn past the hard cap';
const REASON = 'the step check could not run.';

/**
 * How long to let a toast that should NOT exist have to show up. A negative
 * assertion cannot poll: it passes at once on "nothing yet". The push is
 * delivered and rendered in the same tick the fire call returns, so this is a
 * generous budget, not a wait for the toast to arrive.
 */
const NEGATIVE_ASSERTION_BUDGET_MS = 300;

async function launchOnProject(): Promise<{ browser: Browser; page: Page }> {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => {
      await target.addInitScript(`
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Workflow Stalled Test',
            path: '/mock/workflow-stalled-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.projects.push({
            id: '${OTHER_PROJECT_ID}',
            name: 'Background Project',
            path: '/mock/workflow-stalled-other',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          var laneIds = {};
          state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
            var id = 'lane-workflow-stalled-' + index;
            laneIds[swimlane.name] = id;
            state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
          });
          state.tasks.push({
            id: '${TASK_ID}',
            title: '${TASK_TITLE}',
            description: 'The task a stalled workflow names.',
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
    },
  });
  await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 10000 });
  // A timed toast closes at durationSeconds (4s by default), inside Playwright's
  // expect timeout. Push it out so a vanished toast is never read as one that was
  // never raised.
  await patchToastSettings(page, { durationSeconds: 60 });
  return { browser, page };
}

/** Patch `notifications.toasts.*` in the renderer's config store, which App.tsx's handler reads at fire time. */
async function patchToastSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((toastPatch) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { setState: (update: (state: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((state) => {
      const notifications = state.config.notifications as { toasts: Record<string, unknown> };
      return {
        config: {
          ...state.config,
          notifications: { ...notifications, toasts: { ...notifications.toasts, ...toastPatch } },
        },
      };
    });
  }, patch);
}

/** Stand in for main's `workflow:stalled` push, after the guard that App.tsx has subscribed. */
async function fireWorkflowStalled(
  page: Page,
  stalled: { projectId?: string; taskTitle?: string; reason?: string } = {},
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__mockFireWorkflowStalled === 'function'), {
      message: 'App.tsx is not subscribed to tasks.onWorkflowStalled',
    })
    .toBe(true);
  await page.evaluate((event) => {
    if (!window.__mockFireWorkflowStalled) throw new Error('window.__mockFireWorkflowStalled is not installed');
    window.__mockFireWorkflowStalled(event);
  }, {
    workflowId: WORKFLOW_ID,
    projectId: stalled.projectId ?? PROJECT_ID,
    taskId: TASK_ID,
    taskTitle: stalled.taskTitle ?? TASK_TITLE,
    reason: stalled.reason ?? REASON,
  });
}

test.describe('Workflow stalled toast', () => {
  test('a stall on the open project toasts, naming the task and why', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await fireWorkflowStalled(page);

      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Workflow stalled');
      await expect(toast.getByTestId('toast-body')).toHaveText(`"${TASK_TITLE}": ${REASON}`);
      await expect(toast).toHaveAttribute('data-variant', 'warning');
    } finally {
      await browser.close();
    }
  });

  test('a stall on a task with no title reads as the reason alone', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await fireWorkflowStalled(page, { taskTitle: '' });

      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-body')).toHaveText(REASON);
    } finally {
      await browser.close();
    }
  });

  // Main raises the desktop notification for a board you cannot see, so a toast
  // about it would be noise on top of that alert.
  test('a stall on another project raises no toast', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await fireWorkflowStalled(page, { projectId: OTHER_PROJECT_ID });

      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);

      // Positive control on the same page: the handler IS subscribed and does
      // toast, so the zero above is the project gate and not a dead listener.
      await fireWorkflowStalled(page);
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Workflow stalled');
    } finally {
      await browser.close();
    }
  });

  test('no toast while the setting is off, and one again once it is back on', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await patchToastSettings(page, { onWorkflowStalled: false });
      await fireWorkflowStalled(page);

      await page.waitForTimeout(NEGATIVE_ASSERTION_BUDGET_MS);
      expect(await toastCountRightNow(page)).toBe(0);

      // Positive control on the same page: switch the setting back on and the
      // same push toasts, so the zero above is the setting and not a dead listener.
      await patchToastSettings(page, { onWorkflowStalled: true });
      await fireWorkflowStalled(page);
      await expect(page.getByTestId('toast')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a click on the toast opens the task it names', async () => {
    const { browser, page } = await launchOnProject();
    try {
      const detailTaskId = () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { session?: { getState: () => { detailTaskId: string | null } } };
        }).__zustandStores;
        if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
        return stores.session.getState().detailTaskId;
      });
      expect(await detailTaskId()).toBeNull();

      await fireWorkflowStalled(page);
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await toast.getByTestId('toast-body').click();

      await expect.poll(detailTaskId, { timeout: 10000 }).toBe(TASK_ID);
    } finally {
      await browser.close();
    }
  });
});
