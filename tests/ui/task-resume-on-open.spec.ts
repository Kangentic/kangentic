/**
 * Opening a task asks main to resume it (`sessions.resumeOnOpen`), and only a
 * person's open asks. Main decides what the answer is
 * (`tests/unit/session-resume-on-open.test.ts`). This pins the half only a running
 * renderer shows: which gestures reach the bridge. A window an agent opened or a
 * restore rebuilt must not ask, or a project switch would start paused agents
 * and the pause would hold nothing across a restart.
 *
 * Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage } from './helpers';

test.describe.configure({ mode: 'parallel' });

const PROJECT_ID = 'proj-resume-on-open';
const PAUSED_TASK = 'task-paused';
const PAUSED_SESSION = 'session-paused';
const TODO_TASK = 'task-todo';
const PAUSED_TITLE = 'Retry the sync';

interface ResumeOnOpenCall {
  taskId: string;
  projectId: string | null;
}

interface WindowStores {
  __zustandStores?: {
    window: {
      getState: () => {
        applyWorkspace: (
          workspace: unknown,
          resolveSession: (anchor: string) => string | null,
          isKnownAnchor: (anchor: string) => boolean,
        ) => void;
      };
    };
  };
  __mockResumeOnOpenCalls?: ResumeOnOpenCall[];
}

async function launchWithPausedTask(): Promise<{ browser: Browser; page: Page }> {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => {
      await target.addInitScript(`
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Resume On Open',
            path: '/mock/resume-on-open',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          var laneIds = {};
          state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
            var id = 'lane-open-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
            laneIds[swimlane.name] = id;
            state.swimlanes.push(Object.assign({}, swimlane, { id: id, position: index, created_at: ts }));
          });
          state.sessions.push({
            id: '${PAUSED_SESSION}',
            taskId: '${PAUSED_TASK}',
            projectId: '${PROJECT_ID}',
            pid: null,
            status: 'suspended',
            shell: 'bash',
            cwd: '/mock/resume-on-open',
            startedAt: ts,
            exitCode: null,
          });
          function task(id, title, lane, sessionId) {
            return {
              id: id, title: title, description: 'Seeded for the open', swimlane_id: laneIds[lane], position: 0,
              agent: 'claude', session_id: sessionId, worktree_path: null, branch_name: null, pr_number: null,
              pr_url: null, base_branch: null, use_worktree: 0, labels: [], priority: 0, attachment_count: 0,
              archived_at: null, created_at: ts, updated_at: ts,
            };
          }
          state.tasks.push(task('${PAUSED_TASK}', '${PAUSED_TITLE}', 'Executing', null));
          state.tasks.push(task('${TODO_TASK}', 'Not started yet', 'To Do', null));
          return { currentProjectId: '${PROJECT_ID}' };
        });
      `);
    },
  });
  await page.locator(`[data-board-lanes] [data-task-id="${PAUSED_TASK}"]`).waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

function resumeOnOpenCalls(page: Page): Promise<ResumeOnOpenCall[]> {
  return page.evaluate(() => (window as unknown as WindowStores).__mockResumeOnOpenCalls ?? []);
}

function taskWindow(page: Page) {
  return page.locator('[data-testid="task-detail-dialog"]');
}

test.describe('Opening a task asks main to resume it', () => {
  test('a click on the card asks, with the open project', async () => {
    const { browser, page } = await launchWithPausedTask();
    try {
      await page.locator(`[data-board-lanes] [data-task-id="${PAUSED_TASK}"]`).click();

      await expect(taskWindow(page)).toBeVisible();
      await expect.poll(() => resumeOnOpenCalls(page)).toEqual([{ taskId: PAUSED_TASK, projectId: PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  // Red: `setDetailTaskId(null)` asks too. Closing a window is the user leaving,
  // and a task that was declined or is still paused must not be asked about again.
  test('closing the window does not ask again', async () => {
    const { browser, page } = await launchWithPausedTask();
    try {
      await page.locator(`[data-board-lanes] [data-task-id="${PAUSED_TASK}"]`).click();
      await expect(taskWindow(page)).toBeVisible();
      await expect.poll(() => resumeOnOpenCalls(page)).toEqual([{ taskId: PAUSED_TASK, projectId: PROJECT_ID }]);

      await page.keyboard.press('Escape');
      await expect(taskWindow(page)).toHaveCount(0);

      expect(await resumeOnOpenCalls(page)).toEqual([{ taskId: PAUSED_TASK, projectId: PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  test('a click on the Agent paused toast asks', async () => {
    const { browser, page } = await launchWithPausedTask();
    try {
      await page.evaluate(({ sessionId, taskId, projectId }) => {
        if (!window.__mockFireIdleTimeout) throw new Error('window.__mockFireIdleTimeout is not installed');
        window.__mockFireIdleTimeout(sessionId, taskId, 30, projectId);
      }, { sessionId: PAUSED_SESSION, taskId: PAUSED_TASK, projectId: PROJECT_ID });

      await page.getByText(`"${PAUSED_TITLE}" was idle for 30 minutes.`).click();

      await expect.poll(() => resumeOnOpenCalls(page)).toEqual([{ taskId: PAUSED_TASK, projectId: PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  // Fires the push and waits for the window, so the absence means something.
  test('the pause itself does not ask: a window open when it lands stays paused', async () => {
    const { browser, page } = await launchWithPausedTask();
    try {
      await page.locator(`[data-board-lanes] [data-task-id="${PAUSED_TASK}"]`).click();
      await expect.poll(() => resumeOnOpenCalls(page)).toHaveLength(1);

      await page.evaluate(({ sessionId, taskId, projectId }) => {
        window.__mockFireIdleTimeout?.(sessionId, taskId, 30, projectId);
      }, { sessionId: PAUSED_SESSION, taskId: PAUSED_TASK, projectId: PROJECT_ID });
      await expect(page.getByText(`"${PAUSED_TITLE}" was idle for 30 minutes.`)).toBeVisible();

      expect(await resumeOnOpenCalls(page)).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('a card that opens its edit form does not ask', async () => {
    const { browser, page } = await launchWithPausedTask();
    try {
      await page.locator(`[data-board-lanes] [data-task-id="${TODO_TASK}"]`).click();

      await expect(taskWindow(page)).toBeVisible();
      expect(await resumeOnOpenCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('an agent opening the task does not ask', async () => {
    const { browser, page } = await launchWithPausedTask();
    try {
      await page.evaluate(([projectId, taskId]) => window.__mockBrowser?.emitPaneOpenRequest(projectId, taskId), [PROJECT_ID, PAUSED_TASK]);

      await expect(taskWindow(page)).toBeVisible();
      expect(await resumeOnOpenCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test('a restored window does not ask', async () => {
    const { browser, page } = await launchWithPausedTask();
    try {
      await page.evaluate(({ taskId, title }) => {
        const stores = (window as unknown as WindowStores).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        stores.window.getState().applyWorkspace({
          version: 1,
          windows: [{ taskId, title, geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, restoreGeometry: null, state: 'floating' }],
          tileTree: null,
          tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
          focusedTaskId: taskId,
        }, () => null, (anchor) => anchor === taskId);
      }, { taskId: PAUSED_TASK, title: PAUSED_TITLE });

      await expect(taskWindow(page)).toBeVisible();
      expect(await resumeOnOpenCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
