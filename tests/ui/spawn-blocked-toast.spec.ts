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

function fireSpawnBlocked(page: Page, projectId: string, taskTitle = 'Task B') {
  return page.evaluate(
    ([message, targetProjectId, title]) => {
      (window as unknown as {
        __mockFireTaskSpawnBlocked: (taskId: string, taskTitle: string, message: string, projectId: string) => void;
      }).__mockFireTaskSpawnBlocked(`task-blocked-${title}`, title, message, targetProjectId);
    },
    [BLOCK_MESSAGE, projectId, taskTitle] as const,
  );
}

test.describe('task:spawnBlocked push', () => {
  test('toasts for the current project, naming the task and the reason', async () => {
    const { browser, page } = await launch();
    try {
      await fireSpawnBlocked(page, CURRENT_PROJECT_ID);

      // The task name matters: the user is looking at a board where the task
      // exists and looks normal, so the toast has to say which one did not start.
      const toast = page.locator('text=/Task B.*did not start its agent/');
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
      await fireSpawnBlocked(page, OTHER_PROJECT_ID, 'Background Task');

      // Then fire one for the CURRENT project and wait for it. Both pushes cross
      // the same channel in order, so once the second has rendered the first has
      // definitively been handled and dropped. That is the signal a bare
      // waitForTimeout only guesses at, and it does not get slower under CI load.
      await fireSpawnBlocked(page, CURRENT_PROJECT_ID, 'Foreground Task');
      await expect(page.locator('text=/Foreground Task.*did not start its agent/'))
        .toBeVisible({ timeout: 5000 });

      await expect(page.locator('text=/Background Task/')).toHaveCount(0);
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

      await expect(page.locator('text=/Task C.*did not start its agent/'))
        .toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('wraps a long unbroken token instead of growing the toast past its width cap', async () => {
    const { browser, page } = await launch();
    try {
      // A spaced message - or even a slash/backslash-separated path - wraps at
      // its natural break points regardless of the CSS below (Chromium treats
      // both '/' and '\' as line-break opportunities per the Unicode line-
      // breaking rules), and proves nothing about `break-words` /
      // `overflow-wrap`. The bug this guards needs one long, GENUINELY
      // unbreakable run - no space, slash, backslash, or hyphen anywhere in
      // it - which only wraps mid-token if `overflow-wrap` (`break-words`) is
      // applied, and only wraps INSIDE a bounded box if every flex ancestor
      // can actually shrink below its content size (`min-w-0`). Without both,
      // a real failure reached ~1800px on a wide monitor and still lost its
      // tail - either the toast grows past its cap, or its content overflows
      // the cap invisibly.
      const longUnbrokenToken = 'a1b2c3d4e5f6'.repeat(30);
      const longPathMessage =
        `Cannot switch branches in a checkout named ${longUnbrokenToken}: "Task A" is already `
        + 'running an agent there. Stop that task, or enable worktree mode so each task gets its own checkout.';

      await page.evaluate(
        ([message, projectId, title]) => {
          (window as unknown as {
            __mockFireTaskSpawnBlocked: (taskId: string, taskTitle: string, message: string, projectId: string) => void;
          }).__mockFireTaskSpawnBlocked(`task-blocked-${title}`, title, message, projectId);
        },
        [longPathMessage, CURRENT_PROJECT_ID, 'Long Path Task'] as const,
      );

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: 'Long Path Task' });
      await expect(toast).toBeVisible({ timeout: 5000 });

      // The CSS cap is 34rem (544px at the default 16px root font-size - index.css
      // carries no root-level font-size override). 600 leaves headroom for the
      // border and accent bar without being loose enough to pass a broken cap.
      // This alone only proves the max-w cap holds on the toast's OWN box -
      // removing `min-w-0` / `break-words` does not move this number, because
      // the root also carries `overflow-hidden`, so an unbreakable child that
      // cannot shrink overflows invisibly rather than growing the box. The
      // overflow check below is what actually exercises those two classes.
      const box = await toast.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThan(600);

      // `min-w-0` (every flex ancestor down to the message span can shrink
      // below its content's intrinsic width) and `break-words` (the token
      // wraps mid-run instead of demanding room for the whole thing) are what
      // keep the message from overflowing once the box itself is capped.
      // Measured on the ROOT (the element carrying `overflow-hidden`, not the
      // span): a flex item's rendered box sizes itself to fit its own
      // min-content and so never reports self-overflow, even when it cannot
      // wrap - the overflow instead shows up here, as the root's scrollWidth
      // (the true content extent) exceeding its max-w-capped clientWidth. An
      // overflow boolean, not a pixel-exact metric, so it stays inside the
      // geometry-tolerance rule for cross-platform tests.
      const rootOverflow = await toast.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
      expect(rootOverflow.scrollWidth).toBeLessThanOrEqual(rootOverflow.clientWidth + 2);
    } finally {
      await browser.close();
    }
  });
});
