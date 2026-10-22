/**
 * The Workflow complete toast: App.tsx's `tasks.onWorkflowCompleted` handler
 * raises it when every task of a workflow reached Done.
 * `window.__mockFireWorkflowCompleted` stands in for main's `workflow:completed`
 * push (`announceWorkflowComplete`, src/main/workflows/workflow-complete.ts).
 *
 * - The toast names the workflow and says how many tasks are in Done.
 * - Its card opens nothing. Main marks the workflow done before it announces
 *   it, and a finished workflow leaves every list, so there is no workflow for
 *   a click to land on. The card is click-through, as every toast without an
 *   `onOpen` is (toast-click-through.spec.ts), and a click on it leaves the
 *   board where it was.
 *
 * Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage } from './helpers';

test.describe.configure({ mode: 'parallel' });

const PROJECT_ID = 'proj-workflow-complete';
const WORKFLOW_ID = 'wf-finished';
const WORKFLOW_TITLE = 'Usage budgets';

async function launchOnProject(): Promise<{ browser: Browser; page: Page }> {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => {
      await target.addInitScript(`
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Workflow Complete Test',
            path: '/mock/workflow-complete-test',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
            state.swimlanes.push(Object.assign({}, swimlane, { id: 'lane-workflow-complete-' + index, position: index, created_at: ts }));
          });
          return { currentProjectId: '${PROJECT_ID}' };
        });
      `);
    },
  });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 10000 });
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

/** Stand in for main's `workflow:completed` push, after the guard that App.tsx has subscribed. */
async function fireWorkflowCompleted(page: Page, taskCount: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof window.__mockFireWorkflowCompleted === 'function'), {
      message: 'App.tsx is not subscribed to tasks.onWorkflowCompleted',
    })
    .toBe(true);
  await page.evaluate((completed) => {
    if (!window.__mockFireWorkflowCompleted) throw new Error('window.__mockFireWorkflowCompleted is not installed');
    window.__mockFireWorkflowCompleted(completed);
  }, { workflowId: WORKFLOW_ID, title: WORKFLOW_TITLE, taskCount, projectId: PROJECT_ID });
}

test.describe('Workflow complete toast', () => {
  test('names the workflow and counts its tasks in Done', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await fireWorkflowCompleted(page, 3);

      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-title')).toHaveText('Workflow complete');
      await expect(toast.getByTestId('toast-body')).toHaveText(`All 3 tasks of "${WORKFLOW_TITLE}" are in Done.`);
      await expect(toast).toHaveAttribute('data-variant', 'success');
    } finally {
      await browser.close();
    }
  });

  test('a one-task workflow reads in the singular', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await fireWorkflowCompleted(page, 1);

      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);
      await expect(toast.getByTestId('toast-body')).toHaveText(`The task of "${WORKFLOW_TITLE}" is in Done.`);
    } finally {
      await browser.close();
    }
  });

  // elementFromPoint, as toast-click-through.spec.ts uses: boundingBox() and
  // toBeVisible() both ignore occlusion, and a card with an `onOpen` takes its
  // clicks, so the card being under the pointer is what tells the two apart.
  test('the card opens nothing: a click on its centre falls through and the board stays', async () => {
    const { browser, page } = await launchOnProject();
    try {
      await fireWorkflowCompleted(page, 3);
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveCount(1);

      const boardState = () => page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: { getState: () => { activeView: string } };
            workflow: { getState: () => { selectedWorkflowId: string | null } };
          };
        }).__zustandStores;
        if (!stores) throw new Error('__zustandStores is not exposed');
        return {
          activeView: stores.board.getState().activeView,
          selectedWorkflowId: stores.workflow.getState().selectedWorkflowId,
        };
      });
      expect(await boardState()).toEqual({ activeView: 'board', selectedWorkflowId: null });

      const box = await toast.boundingBox();
      if (!box) throw new Error('the toast has no bounding box');
      const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };

      const fallsThrough = await page.evaluate(({ x, y }) => {
        const card = document.querySelector('[data-testid="toast"]');
        const hit = document.elementFromPoint(x, y);
        return !!card && !!hit && !card.contains(hit);
      }, centre);
      expect(fallsThrough, 'the card took the click, so something opens from it').toBe(true);

      await page.mouse.click(centre.x, centre.y);

      // An openable card closes itself on the click, so it still being up says
      // the click went to what is under it. The view and the selection stay put.
      await expect(toast).toHaveCount(1);
      await expect(page.getByTestId('workflows-view')).toBeHidden();
      expect(await boardState()).toEqual({ activeView: 'board', selectedWorkflowId: null });
    } finally {
      await browser.close();
    }
  });
});
