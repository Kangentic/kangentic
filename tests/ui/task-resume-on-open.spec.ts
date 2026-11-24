/**
 * Opening a task asks main to resume it (`sessions.resumeOnOpen`), and only a
 * person's open asks. Main decides what the answer is
 * (`tests/unit/session-resume-on-open.test.ts`). This pins the half only a running
 * renderer shows: which gestures reach the bridge. Switching back to a project asks
 * for the windows it left open there. A window an agent opened must not ask, nor one
 * a launch restored, or the pause would hold nothing across a restart.
 *
 * Each case owns its page.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage } from './helpers';

test.describe.configure({ mode: 'parallel' });

const PROJECT_ID = 'proj-resume-on-open';
const OTHER_PROJECT_ID = 'proj-resume-on-open-other';
const PAUSED_TASK = 'task-paused';
const PAUSED_SESSION = 'session-paused';
const TODO_TASK = 'task-todo';
const PAUSED_TITLE = 'Retry the sync';

interface ResumeOnOpenCall {
  taskId: string;
  projectId: string | null;
}

/** A saved layout with the paused task's window left open. */
const SAVED_LAYOUT = {
  version: 1,
  windows: [{ taskId: PAUSED_TASK, title: PAUSED_TITLE, geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, restoreGeometry: null, state: 'floating' }],
  tileTree: null,
  tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
  focusedTaskId: PAUSED_TASK,
};

interface WindowStores {
  __zustandStores?: {
    project: { getState: () => { openProject: (id: string) => Promise<void> } };
  };
  __mockResumeOnOpenCalls?: ResumeOnOpenCall[];
}

/** Launch on the paused task's project, or on the other one, with its window in the saved layout or not. */
async function launchWithPausedTask(
  options: { onOtherProject?: boolean; savedLayout?: boolean } = {},
): Promise<{ browser: Browser; page: Page }> {
  const startProjectId = options.onOtherProject ? OTHER_PROJECT_ID : PROJECT_ID;
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
          state.projects.push({
            id: '${OTHER_PROJECT_ID}',
            name: 'Somewhere else',
            path: '/mock/somewhere-else',
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
              archived_at: null, created_at: ts, updated_at: ts, projectId: '${PROJECT_ID}',
            };
          }
          state.tasks.push(task('${PAUSED_TASK}', '${PAUSED_TITLE}', 'Executing', null));
          state.tasks.push(task('${TODO_TASK}', 'Not started yet', 'To Do', null));
          if (${options.savedLayout === true}) {
            state.config.workspaceByProject = { '${PROJECT_ID}': ${JSON.stringify(SAVED_LAYOUT)} };
          }
          return { currentProjectId: '${startProjectId}' };
        });
      `);
    },
  });
  const ready = options.onOtherProject
    ? page.locator('[data-swimlane-name="Executing"]')
    : page.locator(`[data-board-lanes] [data-task-id="${PAUSED_TASK}"]`);
  await ready.waitFor({ state: 'visible', timeout: 10000 });
  return { browser, page };
}

/** Switch projects through the store's own action, as a click in the sidebar does. */
async function openProject(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const stores = (window as unknown as WindowStores).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    await stores.project.getState().openProject(id);
  }, projectId);
}

function resumeOnOpenCalls(page: Page): Promise<ResumeOnOpenCall[]> {
  return page.evaluate(() => (window as unknown as WindowStores).__mockResumeOnOpenCalls ?? []);
}

function taskWindow(page: Page) {
  return page.locator('[data-testid="task-detail-dialog"]');
}

test.describe('Opening a task asks main to resume it', () => {
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
  test('the pause itself does not ask, should one land on an open window', async () => {
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

  // A window in a project nobody is looking at does not count as open, so its agent
  // can be paused meanwhile. Coming back to it is opening it again.
  test('switching back to a project asks for the window left open there, every time', async () => {
    const { browser, page } = await launchWithPausedTask();
    const asked = { taskId: PAUSED_TASK, projectId: PROJECT_ID };
    try {
      await page.locator(`[data-board-lanes] [data-task-id="${PAUSED_TASK}"]`).click();
      await expect.poll(() => resumeOnOpenCalls(page)).toEqual([asked]);

      // Both switches back are warm. The second says it is not a one-off.
      for (const expected of [[asked, asked], [asked, asked, asked]]) {
        await openProject(page, OTHER_PROJECT_ID);
        await expect(taskWindow(page)).toHaveCount(0);
        await openProject(page, PROJECT_ID);
        await expect(taskWindow(page)).toBeVisible();
        await expect.poll(() => resumeOnOpenCalls(page)).toEqual(expected);
      }
    } finally {
      await browser.close();
    }
  });

  test('a first switch to a project asks for the windows its saved layout brings back', async () => {
    const { browser, page } = await launchWithPausedTask({ onOtherProject: true, savedLayout: true });
    try {
      await openProject(page, PROJECT_ID);

      await expect(taskWindow(page)).toBeVisible();
      await expect.poll(() => resumeOnOpenCalls(page)).toEqual([{ taskId: PAUSED_TASK, projectId: PROJECT_ID }]);
    } finally {
      await browser.close();
    }
  });

  test('the window a launch restores does not ask', async () => {
    const { browser, page } = await launchWithPausedTask({ savedLayout: true });
    try {
      await expect(taskWindow(page)).toBeVisible();
      expect(await resumeOnOpenCalls(page)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
