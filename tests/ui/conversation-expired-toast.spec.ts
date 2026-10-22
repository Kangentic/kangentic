/**
 * UI coverage for the `task:conversationExpired` notice.
 *
 * A resume that found the agent had deleted the task's conversation (Claude
 * Code removes transcripts older than its `cleanupPeriodDays`) starts a new one
 * from a recap. A task startup recovery resumes in the background would
 * otherwise start over with nobody told, so main queues a notice and pushes a
 * signal, and the renderer takes the queue (`tasks.takeConversationExpired`)
 * when the signal names the current project and whenever a project becomes
 * current. Startup recovery runs before the renderer knows which project is
 * current, so a notice for a project that is not current must wait for it
 * rather than be dropped. The mock's `__mockFireConversationExpired` queues
 * before it signals, as main does. The spawn itself is covered in the unit
 * tier; this spec covers the renderer half.
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, toastCountRightNow } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const CURRENT_PROJECT_ID = 'proj-expired-current';
const OTHER_PROJECT_ID = 'proj-expired-other';

const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${CURRENT_PROJECT_ID}',
      name: 'Expired Current',
      path: '/mock/expired-current',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.projects.push({
      id: '${OTHER_PROJECT_ID}',
      name: 'Expired Other',
      path: '/mock/expired-other',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'expired-lane-' + i, position: i, created_at: ts }));
    });
    return { currentProjectId: '${CURRENT_PROJECT_ID}' };
  });
`;

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);
  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

function fireConversationExpired(page: Page, notice: {
  projectId: string;
  taskTitle: string;
  lastActiveAt: string | null;
}) {
  return page.evaluate((payload) => {
    (window as unknown as {
      __mockFireConversationExpired: (notice: Record<string, unknown>) => void;
    }).__mockFireConversationExpired({ taskId: `task-${payload.taskTitle}`, ...payload });
  }, notice);
}

test.describe('task:conversationExpired push', () => {
  test('shows one sentence naming the task and when its old conversation last ran', async () => {
    const { browser, page } = await launch();
    try {
      await fireConversationExpired(page, {
        projectId: CURRENT_PROJECT_ID,
        taskTitle: 'Fix login redirect',
        lastActiveAt: '2026-08-16T14:00:00.000Z',
      });

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Fix login redirect' });
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast.getByTestId('toast-title')).toHaveText('New conversation');
      // The date is formatted for the runner's locale and zone, so only the
      // fixed parts of the sentence are pinned.
      const body = toast.getByTestId('toast-body');
      await expect(body).toContainText('"Fix login redirect" started fresh because its conversation from ');
      await expect(body).toContainText(' expired.');
      await expect(toast).not.toContainText('pending message');
    } finally {
      await browser.close();
    }
  });

  test('stays silent for a background project', async () => {
    const { browser, page } = await launch();
    try {
      await fireConversationExpired(page, {
        projectId: OTHER_PROJECT_ID, taskTitle: 'Background Task', lastActiveAt: null,
      });
      // Both pushes cross the same channel in order, so once the second has
      // rendered the first has definitively been handled and held.
      await fireConversationExpired(page, {
        projectId: CURRENT_PROJECT_ID, taskTitle: 'Foreground Task', lastActiveAt: null,
      });
      await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Foreground Task' }))
        .toBeVisible({ timeout: 5000 });
      expect(await toastCountRightNow(page, 'Background Task')).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test('shows a held notice once its project becomes current', async () => {
    const { browser, page } = await launch();
    try {
      await fireConversationExpired(page, {
        projectId: OTHER_PROJECT_ID, taskTitle: 'Held Task', lastActiveAt: null,
      });
      await fireConversationExpired(page, {
        projectId: CURRENT_PROJECT_ID, taskTitle: 'Barrier Task', lastActiveAt: null,
      });
      await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Barrier Task' }))
        .toBeVisible({ timeout: 5000 });
      expect(await toastCountRightNow(page, 'Held Task')).toBe(0);

      // The launch-time auto-open path: the project becomes current after its
      // recovery already reported the start-over.
      await openProjectProgrammatically(page, OTHER_PROJECT_ID);

      await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'Held Task' }))
        .toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('does not show a notice again when its project becomes current again', async () => {
    const { browser, page } = await launch();
    try {
      await fireConversationExpired(page, {
        projectId: CURRENT_PROJECT_ID, taskTitle: 'Shown Once Task', lastActiveAt: null,
      });
      const shownOnce = page.locator('[data-testid="toast"]').filter({ hasText: 'Shown Once Task' });
      await expect(shownOnce).toBeVisible({ timeout: 5000 });

      await openProjectProgrammatically(page, OTHER_PROJECT_ID);
      await openProjectProgrammatically(page, CURRENT_PROJECT_ID);
      // A take that would repeat the first notice runs no later than this
      // one's, so once this toast is up a repeat would be too.
      await fireConversationExpired(page, {
        projectId: CURRENT_PROJECT_ID, taskTitle: 'After Return Task', lastActiveAt: null,
      });
      await expect(page.locator('[data-testid="toast"]').filter({ hasText: 'After Return Task' }))
        .toBeVisible({ timeout: 5000 });

      await expect(shownOnce).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('shows several held notices as one toast each, with no summary', async () => {
    const { browser, page } = await launch();
    try {
      const taskTitles = ['First Held', 'Second Held', 'Third Held'];
      for (const taskTitle of taskTitles) {
        await fireConversationExpired(page, {
          projectId: OTHER_PROJECT_ID, taskTitle, lastActiveAt: null,
        });
      }

      await openProjectProgrammatically(page, OTHER_PROJECT_ID);

      for (const taskTitle of taskTitles) {
        await expect(page.locator('[data-testid="toast"]').filter({ hasText: taskTitle }))
          .toHaveCount(1, { timeout: 5000 });
      }
      await expect(page.locator('[data-testid="toast"]')).toHaveCount(3);
      // No summary card: all three are the per-task toast.
      await expect(page.getByTestId('toast-title')).toHaveText(['New conversation', 'New conversation', 'New conversation']);
    } finally {
      await browser.close();
    }
  });
});

/** Make a project current the way a launch-time auto-open does. */
async function openProjectProgrammatically(page: Page, projectId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as { __mockFireProjectAutoOpened: (projectId: string) => void })
      .__mockFireProjectAutoOpened(id);
  }, projectId);
}
