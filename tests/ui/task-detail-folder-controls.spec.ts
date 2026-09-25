/**
 * The task detail names which folder it opens.
 *
 * The header's folder button already flips between "Open Worktree" and "Open
 * Folder" from `task.worktree_path`; the kebab's folder item now says "Open
 * worktree" or "Open project folder" instead of a bare "Open folder", so a
 * task the spawn left in the SHARED project checkout is never mistaken for one
 * in its own worktree. Both are read from `worktree_path`, not from the
 * recorded skip reason.
 *
 * A card-level glyph that read the recorded reason was reviewed out: at 12px
 * the two folder icons were too alike to add anything. The main process still
 * records why a worktree was skipped (`Task.worktree_skip_reason`), ready for a
 * richer card row.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-folder-controls';
const PROJECT_PATH = '/mock/folder-controls-test';

const SHARED_TASK_ID = 'task-shared-disabled';
const SHARED_TASK_TITLE = 'Runs In The Project Folder';
const ISOLATED_TASK_ID = 'task-isolated-worktree';
const ISOLATED_TASK_TITLE = 'Runs In Its Own Worktree';

interface StoreWindow {
  __zustandStores: {
    session: { getState: () => { setDetailTaskId: (id: string) => void } };
    window: { getState: () => { windows: Record<string, { id: string; anchor: string }> } };
  };
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Folder Controls Test',
        path: '${PROJECT_PATH}',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-'),
          position: i,
          created_at: ts,
        }));
      });
      function makeTask(overrides) {
        return Object.assign({
          description: 'Fixture task',
          swimlane_id: 'lane-executing',
          position: 0,
          agent: 'claude',
          worktree_path: null,
          worktree_folder: null,
          worktree_skip_reason: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: null,
          use_worktree: null,
          labels: [],
          priority: 0,
          attachment_count: 0,
          archived_at: null,
          created_at: ts,
          updated_at: ts,
        }, overrides);
      }
      function makeSession(overrides) {
        return Object.assign({
          projectId: '${PROJECT_ID}',
          pid: 4242,
          status: 'running',
          shell: 'bash',
          cwd: '${PROJECT_PATH}',
          startedAt: ts,
          exitCode: null,
          resuming: false,
        }, overrides);
      }
      // The user chose Project: the main process recorded 'disabled'.
      state.tasks.push(makeTask({
        id: '${SHARED_TASK_ID}', title: '${SHARED_TASK_TITLE}', position: 0,
        session_id: 'sess-shared', use_worktree: 0, worktree_skip_reason: 'disabled',
      }));
      state.sessions.push(makeSession({ id: 'sess-shared', taskId: '${SHARED_TASK_ID}' }));
      // The default: its own worktree, nothing recorded.
      state.tasks.push(makeTask({
        id: '${ISOLATED_TASK_ID}', title: '${ISOLATED_TASK_TITLE}', position: 1,
        session_id: 'sess-isolated',
        worktree_path: '${PROJECT_PATH}/.kangentic/worktrees/2', worktree_folder: '2',
        branch_name: 'runs-in-its-own-worktree-ab12cd34',
      }));
      state.sessions.push(makeSession({
        id: 'sess-isolated', taskId: '${ISOLATED_TASK_ID}',
        cwd: '${PROJECT_PATH}/.kangentic/worktrees/2',
      }));
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="Executing"]').waitFor({ state: 'visible', timeout: 15000 });
  return { browser, page };
}

/** Open a task-detail window the way a card click does, and resolve its frame id. */
async function openDetailWindow(page: Page, taskId: string): Promise<string> {
  await page.evaluate((detailTaskId) => {
    (window as unknown as StoreWindow).__zustandStores.session.getState().setDetailTaskId(detailTaskId);
  }, taskId);
  let resolvedWindowId: string | null = null;
  await expect.poll(async () => {
    resolvedWindowId = await page.evaluate((anchorId) => {
      const windows = (window as unknown as StoreWindow).__zustandStores.window.getState().windows;
      return Object.values(windows).find((candidate) => candidate.anchor === anchorId)?.id ?? null;
    }, taskId);
    return resolvedWindowId;
  }, { timeout: 5000 }).not.toBeNull();
  return resolvedWindowId as string;
}

/** The kebab popover is portaled to document.body, so its items are located on the page. */
async function openKebab(page: Page, windowId: string): Promise<void> {
  await page.locator(`[data-testid="window-frame-${windowId}"] button[title="Actions"]`).click();
  await expect(page.locator('[data-testid="view-conversation-btn"]')).toBeVisible({ timeout: 5000 });
}

async function closeKebab(page: Page, windowId: string): Promise<void> {
  await page.locator(`[data-testid="window-frame-${windowId}"] button[title="Actions"]`).click();
  await expect(page.locator('[data-testid="view-conversation-btn"]')).toHaveCount(0);
}

test.describe('Task detail folder controls', () => {
  test('the folder button and the kebab item name which folder they open', async () => {
    const { browser, page } = await launch();
    const getPageErrors = collectPageErrors(page);
    try {
      const sharedWindowId = await openDetailWindow(page, SHARED_TASK_ID);
      const sharedFrame = page.locator(`[data-testid="window-frame-${sharedWindowId}"]`);
      await sharedFrame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      await expect(sharedFrame.locator('[data-testid="task-title-text"]')).toHaveText(SHARED_TASK_TITLE);
      await expect(sharedFrame.locator('[data-testid="branch-pill"]')).toHaveAttribute('title', 'Open Folder');

      await openKebab(page, sharedWindowId);
      await expect(page.locator('[role="menu"] button', { hasText: 'Open project folder' })).toHaveCount(1);
      await expect(page.locator('[role="menu"] button', { hasText: 'Open worktree' })).toHaveCount(0);
      await closeKebab(page, sharedWindowId);

      const isolatedWindowId = await openDetailWindow(page, ISOLATED_TASK_ID);
      const isolatedFrame = page.locator(`[data-testid="window-frame-${isolatedWindowId}"]`);
      await isolatedFrame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      await expect(isolatedFrame.locator('[data-testid="task-title-text"]')).toHaveText(ISOLATED_TASK_TITLE);
      await expect(isolatedFrame.locator('[data-testid="branch-pill"]')).toHaveAttribute('title', 'Open Worktree');

      await openKebab(page, isolatedWindowId);
      await expect(page.locator('[role="menu"] button', { hasText: 'Open worktree' })).toHaveCount(1);
      await expect(page.locator('[role="menu"] button', { hasText: 'Open project folder' })).toHaveCount(0);
      await closeKebab(page, isolatedWindowId);

      expect(getPageErrors()).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
