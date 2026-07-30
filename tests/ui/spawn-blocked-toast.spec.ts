/**
 * UI coverage for the `task:spawnBlocked` push.
 *
 * Create, promote, unarchive and MCP auto-spawn deliberately KEEP the task when
 * its branch checkout is blocked, and skip only the spawn. That makes "created
 * and silently not spawned" look identical to a healthy spawn, which is why the
 * main process pushes this event and the renderer toasts it.
 *
 * The task-MOVE path does not use this channel: it rejects the in-flight invoke
 * instead, which the board store already toasts. That half was verified by hand
 * in a preview against a real agent holding the checkout; this spec covers the
 * push half, which no other tier exercises.
 *
 * Tier: UI (headless Chromium). No PTY, no Electron main process.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const CURRENT_PROJECT_ID = 'proj-blocked-current';
const OTHER_PROJECT_ID = 'proj-blocked-other';

const PRE_CONFIG = `
  window.__mockPreConfigure(function (state) {
    var ts = new Date().toISOString();
    state.projects.push({
      id: '${CURRENT_PROJECT_ID}',
      name: 'Blocked Current',
      path: '/mock/blocked-current',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.projects.push({
      id: '${OTHER_PROJECT_ID}',
      name: 'Blocked Other',
      path: '/mock/blocked-other',
      github_url: null,
      default_agent: 'claude',
      last_opened: ts,
      created_at: ts,
    });
    state.DEFAULT_SWIMLANES.forEach(function (s, i) {
      state.swimlanes.push(Object.assign({}, s, { id: 'blocked-lane-' + i, position: i, created_at: ts }));
    });
    return { currentProjectId: '${CURRENT_PROJECT_ID}' };
  });
`;

const BLOCK_MESSAGE =
  'Cannot switch branches in /mock/blocked-current: "Task A" is already running an agent there. '
  + 'Stop that task, or enable worktree mode so each task gets its own checkout.';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(PRE_CONFIG);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

function fireSpawnBlocked(page: Page, projectId: string) {
  return page.evaluate(
    ([message, targetProjectId]) => {
      (window as unknown as {
        __mockFireTaskSpawnBlocked: (taskId: string, taskTitle: string, message: string, projectId: string) => void;
      }).__mockFireTaskSpawnBlocked('task-blocked-1', 'Task B', message, targetProjectId);
    },
    [BLOCK_MESSAGE, projectId] as const,
  );
}

test.describe('task:spawnBlocked push', () => {
  test('toasts for the current project, naming the task and the reason', async () => {
    const { browser, page } = await launch();
    try {
      await fireSpawnBlocked(page, CURRENT_PROJECT_ID);

      // The task name matters: the user is looking at a board where the task
      // exists and looks normal, so the toast has to say which one did not start.
      const toast = page.locator('text=/Task B.*was created but its agent did not start/');
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(page.locator('text=/is already running an agent there/')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('stays silent for a background project', async () => {
    const { browser, page } = await launch();
    try {
      // MCP auto-spawn targets whichever project the tool named, so this push
      // routinely arrives for a project the user is not looking at. Its message
      // names a task on another board, so showing it here would be noise.
      await fireSpawnBlocked(page, OTHER_PROJECT_ID);
      await page.waitForTimeout(800);

      await expect(page.locator('text=/was created but its agent did not start/')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('toasts when the push carries no project id', async () => {
    const { browser, page } = await launch();
    try {
      // An emitter with no project context in scope falls back to undefined
      // rather than guessing. Suppressing those would silently drop the notice.
      await page.evaluate((message) => {
        (window as unknown as {
          __mockFireTaskSpawnBlocked: (taskId: string, taskTitle: string, message: string, projectId?: string) => void;
        }).__mockFireTaskSpawnBlocked('task-blocked-2', 'Task C', message, undefined);
      }, BLOCK_MESSAGE);

      await expect(page.locator('text=/Task C.*was created but its agent did not start/'))
        .toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
