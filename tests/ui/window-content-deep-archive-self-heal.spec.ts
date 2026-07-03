/**
 * UI tests for the deep-archive self-heal effect in WindowContent
 * (src/renderer/window-manager/components/WindowContent.tsx).
 *
 * Contract: a task-detail window's anchor can fall out of BOTH `tasks` (not on
 * the live board) and `archivedTasks` (only the newest-N preview is normally
 * loaded) when OTHER tasks get archived while this window stays open - the
 * window was opened while its task was still inside the preview, but enough
 * newer archivals since have pushed it past the preview's newest-N cutoff.
 * When that happens, `TaskDetailContent`'s effect:
 *   1. acquires an archive viewer (`archiveViewers += 1`) so board hydration
 *      keeps holding the full list once it loads,
 *   2. triggers `loadArchivedTasks()` (the full-archive fetch) if the full
 *      archive isn't already loaded,
 *   3. releases the archive viewer the instant the anchor resolves again OR
 *      the window unmounts - whichever comes first.
 *
 * `useWindowAutoCloseOnDone` does NOT interfere here: a window opened directly
 * on an already-archived task carries `openedDone: true` (set by
 * useTaskDetailWindowBridge), and that bridge explicitly skips such windows.
 * So the window under test stays open the whole time, and its content
 * transitions cleanly resolved -> unresolved -> resolved via the self-heal
 * effect, never auto-closing.
 *
 * Tier: UI (headless Chromium). Entirely renderer-state-driven (Zustand +
 * React effects); no PTY or real IPC is involved, so this cannot regress via
 * anything the unit or E2E tiers would catch on their own.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, collectPageErrors } from './helpers';
import type { Task } from '../../src/shared/types';

// Each test launches its own browser/page, so the file's tests can fan out
// across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-deep-archive-self-heal';
const PREVIEW_LIMIT = 15;
const TARGET_TASK_ID = 'arch-14';
const TARGET_TASK_TITLE = 'Deep Archived Task 14';
const EXTRA_TODO_TASK_ID = 'extra-todo';
const DONE_LANE_ID = 'lane-das-done';
const TODO_LANE_ID = 'lane-das-to-do';

async function launchWithFixture(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Deep Archive Self-Heal Test',
        path: '/mock/deep-archive-self-heal',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-das-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
      });

      // ${PREVIEW_LIMIT} archived tasks, each a minute further in the past.
      // arch-14 (the last / oldest) sits right at the tail of the preview - the
      // first one to fall out once a newer task is archived.
      for (var i = 0; i < ${PREVIEW_LIMIT}; i += 1) {
        var archivedAt = new Date(Date.now() - (i + 1) * 60000).toISOString();
        state.archivedTasks.push({
          id: 'arch-' + i,
          display_id: i + 1,
          title: 'Deep Archived Task ' + i,
          description: 'Archived fixture task ' + i,
          swimlane_id: '${DONE_LANE_ID}',
          position: 0,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: 'main',
          use_worktree: 0,
          labels: [],
          priority: 0,
          attachment_count: 0,
          archived_at: archivedAt,
          created_at: ts,
          updated_at: ts,
        });
      }

      // A live To Do task the test moves to Done to push the tail archived
      // task (arch-14) out of the newest-15 preview.
      state.tasks.push({
        id: '${EXTRA_TODO_TASK_ID}',
        display_id: 100,
        title: 'Extra To Do Task',
        description: '',
        swimlane_id: '${TODO_LANE_ID}',
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
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
  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

/** Open the task-detail window the same way CompletedTasksDialog's "View
 *  Details" row action does: drive the session store directly rather than
 *  clicking a card (the target task is never rendered as a board card). */
async function openDetailWindow(page: Page, taskId: string): Promise<void> {
  await page.evaluate((detailTaskId) => {
    const stores = (window as unknown as {
      __zustandStores?: { session: { getState: () => { setDetailTaskId: (id: string) => void } } };
    }).__zustandStores;
    if (!stores?.session) throw new Error('session store not exposed on __zustandStores');
    stores.session.getState().setDetailTaskId(detailTaskId);
  }, taskId);
}

/** Resolve the live window id for a given anchor (taskId), polling until
 *  useTaskDetailWindowBridge has opened it. */
async function waitForWindowId(page: Page, anchorTaskId: string): Promise<string> {
  let resolvedWindowId: string | null = null;
  await expect.poll(async () => {
    resolvedWindowId = await page.evaluate((anchorId) => {
      const stores = (window as unknown as {
        __zustandStores?: { window: { getState: () => { windows: Record<string, { id: string; anchor: string }> } } };
      }).__zustandStores;
      if (!stores?.window) throw new Error('window store not exposed on __zustandStores');
      const found = Object.values(stores.window.getState().windows).find((candidate) => candidate.anchor === anchorId);
      return found?.id ?? null;
    }, anchorTaskId);
    return resolvedWindowId;
  }, { timeout: 5000 }).not.toBeNull();
  return resolvedWindowId as string;
}

interface BoardArchiveDebugState {
  archiveViewers: number;
  archivedFullyLoaded: boolean;
  archivedTotalCount: number;
  hasTargetInArchivedTasks: boolean;
}

async function readBoardArchiveState(page: Page, targetTaskId: string): Promise<BoardArchiveDebugState> {
  return page.evaluate((taskId) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            archiveViewers: number;
            archivedFullyLoaded: boolean;
            archivedTotalCount: number;
            archivedTasks: Array<{ id: string }>;
          };
        };
      };
    }).__zustandStores;
    if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
    const state = stores.board.getState();
    return {
      archiveViewers: state.archiveViewers,
      archivedFullyLoaded: state.archivedFullyLoaded,
      archivedTotalCount: state.archivedTotalCount,
      hasTargetInArchivedTasks: state.archivedTasks.some((candidate) => candidate.id === taskId),
    };
  }, targetTaskId);
}

/** Replace tasks.listArchived with a version the test controls: the returned
 *  promise never settles until window.__releaseDeferredListArchived() runs,
 *  at which point it resolves with the ORIGINAL (real) full archive. Lets the
 *  test observe the "unresolved, fetch in flight" window deterministically
 *  instead of racing the mock's normally-instant resolution. */
async function installDeferredListArchived(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = window.electronAPI.tasks.listArchived;
    let release: (() => void) | null = null;
    (window as unknown as { __releaseDeferredListArchived?: () => void }).__releaseDeferredListArchived = () => release?.();
    window.electronAPI.tasks.listArchived = (): Promise<Task[]> => new Promise<Task[]>((resolve) => {
      release = () => { void original().then(resolve); };
    });
  });
}

async function releaseDeferredListArchived(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __releaseDeferredListArchived?: () => void }).__releaseDeferredListArchived?.();
  });
}

/** Move the extra To Do task into Done, archiving it as the newest entry and
 *  pushing arch-14 (the prior oldest-of-15) out of the newest-15 preview -
 *  through the real `moveTask` store action, the same path a drag-to-Done
 *  takes. */
async function triggerFallout(page: Page): Promise<void> {
  await page.evaluate(
    async ({ taskId, targetSwimlaneId }) => {
      const stores = (window as unknown as {
        __zustandStores?: {
          board: {
            getState: () => {
              moveTask: (
                input: { taskId: string; targetSwimlaneId: string; targetPosition: number },
                skipConfirmation?: boolean,
              ) => Promise<{ ok: boolean }>;
            };
          };
        };
      }).__zustandStores;
      if (!stores?.board) throw new Error('board store not exposed on __zustandStores');
      await stores.board.getState().moveTask({ taskId, targetSwimlaneId, targetPosition: 0 }, true);
    },
    { taskId: EXTRA_TODO_TASK_ID, targetSwimlaneId: DONE_LANE_ID },
  );
}

test.describe('WindowContent deep-archive self-heal', () => {
  test('resolves via the full archive once the anchor falls out of the preview, and releases the archive viewer on resolve', async () => {
    const { browser, page } = await launchWithFixture();
    const getPageErrors = collectPageErrors(page);
    try {
      await openDetailWindow(page, TARGET_TASK_ID);
      const windowId = await waitForWindowId(page, TARGET_TASK_ID);
      const frame = page.locator(`[data-testid="window-frame-${windowId}"]`);

      // Sanity: the window opens resolved (arch-14 is still in the initial
      // preview) and holds no archive viewer yet.
      await frame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      await expect(frame.locator('[data-testid="task-title-text"]')).toHaveText(TARGET_TASK_TITLE);
      expect((await readBoardArchiveState(page, TARGET_TASK_ID)).archiveViewers).toBe(0);

      // Hold the self-heal's fetch open so the unresolved window is observable.
      await installDeferredListArchived(page);

      // Archive a 16th, newer task - arch-14 now falls out of the newest-15
      // preview on the reconcile that follows.
      await triggerFallout(page);

      // The window is still open (openedDone skips it in useWindowAutoCloseOnDone),
      // but its anchor no longer resolves: the placeholder shows, and the
      // self-heal effect has acquired an archive viewer and is fetching.
      await expect(frame.getByText('This task is no longer available.')).toBeVisible({ timeout: 5000 });
      await expect
        .poll(async () => (await readBoardArchiveState(page, TARGET_TASK_ID)).archiveViewers, { timeout: 5000 })
        .toBe(1);

      // Let the fetch resolve with the real (full) archive.
      await releaseDeferredListArchived(page);

      // The window resolves again, showing the same task; the viewer is
      // released the instant the anchor resolves - the window stays open the
      // whole time, but archiveViewers drops back to 0 without it closing.
      await frame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      await expect(frame.locator('[data-testid="task-title-text"]')).toHaveText(TARGET_TASK_TITLE);
      await expect
        .poll(async () => (await readBoardArchiveState(page, TARGET_TASK_ID)).archiveViewers, { timeout: 5000 })
        .toBe(0);

      const finalState = await readBoardArchiveState(page, TARGET_TASK_ID);
      expect(finalState.archivedFullyLoaded).toBe(true);
      expect(finalState.hasTargetInArchivedTasks).toBe(true);
      expect(finalState.archivedTotalCount).toBe(PREVIEW_LIMIT + 1);

      expect(getPageErrors()).toHaveLength(0);
    } finally {
      await browser.close();
    }
  });

  test('releases the archive viewer on unmount when the window closes before the self-heal resolves', async () => {
    const { browser, page } = await launchWithFixture();
    try {
      await openDetailWindow(page, TARGET_TASK_ID);
      const windowId = await waitForWindowId(page, TARGET_TASK_ID);
      const frame = page.locator(`[data-testid="window-frame-${windowId}"]`);
      await frame.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

      // Hold the self-heal fetch open and never release it - the window must
      // close cleanly (releasing the viewer) without waiting on the fetch.
      await installDeferredListArchived(page);
      await triggerFallout(page);

      await expect
        .poll(async () => (await readBoardArchiveState(page, TARGET_TASK_ID)).archiveViewers, { timeout: 5000 })
        .toBe(1);
      await expect(frame.getByText('This task is no longer available.')).toBeVisible({ timeout: 5000 });

      // Close the window directly (mirrors Ctrl+Shift+W / the title bar close)
      // while the fetch is still in flight and unresolved.
      await page.evaluate((targetWindowId) => {
        const stores = (window as unknown as {
          __zustandStores?: { window: { getState: () => { closeWindow: (id: string) => void } } };
        }).__zustandStores;
        if (!stores?.window) throw new Error('window store not exposed on __zustandStores');
        stores.window.getState().closeWindow(targetWindowId);
      }, windowId);

      await expect(frame).toBeHidden({ timeout: 5000 });
      await expect
        .poll(async () => (await readBoardArchiveState(page, TARGET_TASK_ID)).archiveViewers, { timeout: 5000 })
        .toBe(0);
    } finally {
      await browser.close();
    }
  });
});
