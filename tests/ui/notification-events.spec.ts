/**
 * How App.tsx wires the notification settings into the events it hears: Mute gates
 * the toasts and the sounds, a desktop notice's sound push plays here, and a desktop
 * notice carries its event key so main can pick its sound. Which setting means what
 * is unit-tested (notification-settings.test.ts); this proves the three call sites
 * read it.
 *
 * `Audio` is replaced before the app loads so a test can see which file a sound
 * started, and a negative is proved by a later positive that the same handlers ran.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { launchPage, settleFrames, toastCountRightNow } from './helpers';

test.describe.configure({ mode: 'parallel' });

const PROJECT_ID = 'proj-notification-events';
const TASK_ID = 'task-notification-events';
const SESSION_ID = 'session-notification-events';
const TASK_TITLE = 'Tune the board';

interface NotificationPatch {
  muted?: boolean;
  sounds?: Record<string, string>;
}

async function launchWithRunningSession(): Promise<{ browser: Browser; page: Page }> {
  const { browser, page } = await launchPage({
    beforeLoad: async (target) => {
      await target.addInitScript(`
        window.__audioCreated = [];
        window.Audio = class {
          constructor(source) { window.__audioCreated.push(String(source)); }
          play() { return Promise.resolve(); }
          pause() {}
          addEventListener() {}
          removeEventListener() {}
        };
        window.__mockPreConfigure(function (state) {
          var ts = new Date().toISOString();
          state.projects.push({
            id: '${PROJECT_ID}',
            name: 'Notification Events',
            path: '/mock/notification-events',
            github_url: null,
            default_agent: 'claude',
            last_opened: ts,
            created_at: ts,
          });
          var laneIds = {};
          state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
            var id = 'lane-notification-events-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
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
            cwd: '/mock/notification-events',
            startedAt: ts,
            exitCode: null,
          });
          state.tasks.push({
            id: '${TASK_ID}',
            title: '${TASK_TITLE}',
            description: 'Drives the notification events',
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
  await page.locator(`[data-board-lanes] [data-task-id="${TASK_ID}"]`).waitFor({ state: 'visible', timeout: 10000 });
  // A timed toast closes at durationSeconds; keep it up for the assertion.
  await patchNotifications(page, {});
  return { browser, page };
}

/** Writes the renderer's config store, which is what App.tsx reads at each event. */
async function patchNotifications(page: Page, patch: NotificationPatch): Promise<void> {
  await page.evaluate((change) => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { setState: (update: (state: { config: Record<string, unknown> }) => unknown) => void } };
    }).__zustandStores;
    if (!stores?.config) throw new Error('config store not exposed on __zustandStores');
    stores.config.setState((state) => {
      const notifications = state.config.notifications as { toasts: Record<string, unknown>; sounds: Record<string, string>; muted: boolean };
      return {
        config: {
          ...state.config,
          notifications: {
            ...notifications,
            muted: change.muted ?? notifications.muted,
            sounds: { ...notifications.sounds, ...change.sounds },
            toasts: { ...notifications.toasts, durationSeconds: 60 },
          },
        },
      };
    });
  }, patch);
}

async function waitForListener(page: Page, hookName: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((name) => typeof (window as unknown as Record<string, unknown>)[name] === 'function', hookName), {
      message: `App.tsx has not subscribed, so window.${hookName} is not installed`,
    })
    .toBe(true);
}

async function fireIdleTimeout(page: Page): Promise<void> {
  await waitForListener(page, '__mockFireIdleTimeout');
  await page.evaluate(({ sessionId, taskId, projectId }) => {
    (window as unknown as { __mockFireIdleTimeout: (...args: unknown[]) => void }).__mockFireIdleTimeout(sessionId, taskId, 5, projectId);
  }, { sessionId: SESSION_ID, taskId: TASK_ID, projectId: PROJECT_ID });
}

async function fireWorkflowCompleted(page: Page): Promise<void> {
  await waitForListener(page, '__mockFireWorkflowCompleted');
  await page.evaluate((projectId) => {
    (window as unknown as { __mockFireWorkflowCompleted: (completed: unknown) => void }).__mockFireWorkflowCompleted({
      workflowId: 'workflow-notification-events',
      title: 'Ship the release',
      taskCount: 3,
      projectId,
    });
  }, PROJECT_ID);
}

/** The sound file each `Audio` started, by name ("chime" for chime.wav). */
async function startedSounds(page: Page): Promise<string[]> {
  const sources = await page.evaluate(() => (window as unknown as { __audioCreated: string[] }).__audioCreated);
  return sources.map((source) => /([a-z]+)\.wav/.exec(source)?.[1] ?? source);
}

test.describe('Mute reaches the toasts and the sounds', () => {
  test('a muted Agent paused toast stays down, and comes back unmuted', async () => {
    const { browser, page } = await launchWithRunningSession();
    try {
      await patchNotifications(page, { muted: true });
      await fireIdleTimeout(page);
      await settleFrames(page);
      expect(await toastCountRightNow(page)).toBe(0);

      // The same push, unmuted: proves the handler ran and only Mute held the toast back.
      await patchNotifications(page, { muted: false });
      await fireIdleTimeout(page);
      await expect(page.getByTestId('toast').getByTestId('toast-title')).toHaveText('Agent paused');
    } finally {
      await browser.close();
    }
  });

  test('a muted event raises no toast and no sound, and an unmuted one plays its own sound once', async () => {
    const { browser, page } = await launchWithRunningSession();
    try {
      await patchNotifications(page, { muted: true, sounds: { onWorkflowComplete: 'chime' } });
      await fireWorkflowCompleted(page);
      await settleFrames(page);
      expect(await toastCountRightNow(page)).toBe(0);
      expect(await startedSounds(page)).toEqual([]);

      await patchNotifications(page, { muted: false });
      await fireWorkflowCompleted(page);
      await expect(page.getByTestId('toast').getByTestId('toast-title')).toHaveText('Workflow complete');
      await expect.poll(() => startedSounds(page)).toEqual(['chime']);
    } finally {
      await browser.close();
    }
  });
});

test.describe('A desktop notice leaves its sound to this window', () => {
  test('main\'s play-sound push starts that event\'s chosen sound', async () => {
    const { browser, page } = await launchWithRunningSession();
    try {
      await patchNotifications(page, { sounds: { onAgentIdle: 'rise' } });
      await waitForListener(page, '__mockFirePlaySound');
      await page.evaluate(() => {
        (window as unknown as { __mockFirePlaySound: (eventKey: string) => void }).__mockFirePlaySound('onAgentIdle');
      });
      await expect.poll(() => startedSounds(page)).toEqual(['rise']);
    } finally {
      await browser.close();
    }
  });

  test('a desktop notice carries its event key, for the plan and workflow paths', async () => {
    const { browser, page } = await launchWithRunningSession();
    try {
      await page.evaluate(() => {
        const api = window.electronAPI as unknown as {
          window: { isFocused: () => Promise<boolean> };
          notifications: { show: (notice: unknown) => void };
        };
        const shown: unknown[] = [];
        (window as unknown as { __shownNotices: unknown[] }).__shownNotices = shown;
        // Away from the window, so main-side gating lets the notice through.
        api.window.isFocused = async () => false;
        api.notifications.show = (notice) => { shown.push(notice); };
      });
      const shownEvents = () => page.evaluate(() => (window as unknown as { __shownNotices: Array<{ event?: string }> }).__shownNotices.map((notice) => notice.event));

      await waitForListener(page, '__mockFireTaskAutoMoved');
      await page.evaluate(({ taskId, projectId }) => {
        (window as unknown as { __mockFireTaskAutoMoved: (...args: unknown[]) => void }).__mockFireTaskAutoMoved(taskId, 'lane-notification-events-done', 'Tune the board', projectId);
      }, { taskId: TASK_ID, projectId: PROJECT_ID });
      await expect.poll(shownEvents).toEqual(['onPlanComplete']);

      await fireWorkflowCompleted(page);
      await expect.poll(shownEvents).toEqual(['onPlanComplete', 'onWorkflowComplete']);
    } finally {
      await browser.close();
    }
  });
});
