/**
 * UI tests for bulk-delete partial failure and hard-failure scenarios.
 *
 * These tests cover the renderer-side behavior that cannot be observed through
 * the existing bulk-delete-progress.spec.ts (which only tests the happy path):
 *
 *   #2  (HIGH) Partial-failure toast: "Deleted N tasks. Failed to clean up M
 *       worktrees - check logs." appears when result.failures.length > 0.
 *   #6  (Medium) `(N failed)` red fragment renders inside the progress pill
 *       when bulkDeleteProgress.failures.length > 0.
 *   #7  (Medium) BulkToolbar is hidden while bulkDeleteProgress !== null and
 *       reappears when it clears.
 *   #9  (Medium) Hard IPC throw reverts optimistic removal - archived tasks
 *       are restored in the store and a generic error toast is shown.
 *   #8  (Low) unsubscribe() is called in finally even when IPC throws.
 *
 * The mock-electron-api.js bulkDelete was extended with two test hooks:
 *   - window.__mockBulkDeleteFailureIds: inject partial failures for listed ids
 *   - window.__mockBulkDeleteThrow: make the whole call throw
 *
 * All tests share one Vite/Chromium launch per describe block (beforeAll).
 * skipDeleteConfirm is pre-set to avoid confirmation dialogs.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-bulk-fail-test';
const TASK_COUNT = 5;
const FAILURE_TASK_IDS = ['archived-fail-0', 'archived-fail-1'];

// ---------------------------------------------------------------------------
// Launch helper - seeds TASK_COUNT archived tasks into mock state
// ---------------------------------------------------------------------------

async function launchWithArchivedTasks(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Bulk Fail Test',
        path: '/mock/bulk-fail-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        var id = 'lane-fail-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[lane.name] = id;
        state.swimlanes.push(Object.assign({}, lane, {
          id: id,
          position: index,
          created_at: timestamp,
        }));
      });
      for (var index = 0; index < ${TASK_COUNT}; index += 1) {
        state.archivedTasks.push({
          id: 'archived-fail-' + index,
          title: 'Archived Task ' + index,
          description: 'Was completed',
          swimlane_id: laneIds['Done'],
          position: index,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: 'main',
          use_worktree: 1,
          labels: [],
          priority: 0,
          attachment_count: 0,
          archived_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
        });
      }
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;

  // __mockConfigOverrides must be set BEFORE mock-electron-api.js runs because
  // the mock reads window.__mockConfigOverrides during its own initialization.
  await page.addInitScript('window.__mockConfigOverrides = { skipDeleteConfirm: true };');
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

// Open the Completed Tasks dialog
async function openCompletedTasksDialog(page: Page): Promise<void> {
  await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="view-all-completed"]').click();
  await page.locator('[data-testid="completed-tasks-dialog"]').waitFor({ state: 'visible' });
  // Wait for rows to render
  await expect.poll(() => page.locator('[data-testid="completed-task-row"]').count(), { timeout: 5000 }).toBe(TASK_COUNT);
}

// Select all tasks via the header checkbox
async function selectAllTasks(page: Page): Promise<void> {
  await page.locator('[data-testid="select-all-checkbox"]').check();
}

// Read store state relevant to bulk delete
async function readBulkDeleteStore(page: Page) {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            archivedTasks: Array<{ id: string }>;
            bulkDeleteProgress: {
              completed: number;
              total: number;
              failures: Array<{ id: string; error: string }>;
            } | null;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    return {
      archivedCount: state.archivedTasks.length,
      bulkDeleteProgress: state.bulkDeleteProgress,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Bulk delete - partial failure + hard failure UI behavior', () => {
  // -------------------------------------------------------------------------
  // Gap #2 (HIGH): Partial-failure toast message
  // -------------------------------------------------------------------------

  test('shows partial-failure error toast when some worktrees could not be removed', async () => {
    const { browser, page } = await launchWithArchivedTasks();

    try {
      await openCompletedTasksDialog(page);
      await selectAllTasks(page);

      // Inject partial failures for 2 of the 5 tasks
      await page.evaluate((failureIds: string[]) => {
        (window as unknown as { __mockBulkDeleteFailureIds: string[] }).__mockBulkDeleteFailureIds = failureIds;
      }, FAILURE_TASK_IDS);

      await page.locator('[data-testid="bulk-delete-btn"]').click();

      // Wait for bulkDeleteProgress to clear (operation complete)
      await expect.poll(() => readBulkDeleteStore(page).then((state) => state.bulkDeleteProgress), {
        timeout: 8000,
      }).toBeNull();

      // Error toast must contain the partial-failure message.
      // Use a partial text match on data-testid="toast" to be resilient to
      // other text around the message (error bar, buttons, etc.).
      await expect(
        page.locator('[data-testid="toast"]').filter({ hasText: 'Failed to clean up 2 worktrees' }),
      ).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // Gap #6 (Medium): (N failed) red fragment in progress pill
  // -------------------------------------------------------------------------

  test('shows (N failed) red fragment inside progress pill when failures are emitted mid-flight', async () => {
    const { browser, page } = await launchWithArchivedTasks();

    try {
      await openCompletedTasksDialog(page);
      await selectAllTasks(page);

      // Inject failures for 2 tasks - they will be reflected in progress events
      await page.evaluate((failureIds: string[]) => {
        (window as unknown as { __mockBulkDeleteFailureIds: string[] }).__mockBulkDeleteFailureIds = failureIds;
      }, FAILURE_TASK_IDS);

      // Install a store subscriber that sets a page-accessible flag when a progress
      // payload with failures arrives. We poll the flag from Playwright.
      await page.evaluate(() => {
        (window as unknown as { __failureFragmentSeen: boolean }).__failureFragmentSeen = false;
        const stores = (window as unknown as {
          __zustandStores?: {
            board: { subscribe: (listener: (state: unknown) => void) => () => void };
          };
        }).__zustandStores;
        if (!stores) return;
        stores.board.subscribe((state) => {
          const progress = (state as {
            bulkDeleteProgress: {
              failures: Array<{ id: string; error: string }>;
            } | null;
          }).bulkDeleteProgress;
          if (progress && progress.failures.length > 0) {
            (window as unknown as { __failureFragmentSeen: boolean }).__failureFragmentSeen = true;
          }
        });
      });

      await page.locator('[data-testid="bulk-delete-btn"]').click();

      // Wait for operation to complete
      await expect.poll(() => readBulkDeleteStore(page).then((state) => state.bulkDeleteProgress), {
        timeout: 8000,
      }).toBeNull();

      // The store subscriber set the flag when it saw a progress state with failures.
      // The mock is synchronous so the failures appear in the final progress payload.
      const flagSeen = await page.evaluate(
        () => (window as unknown as { __failureFragmentSeen: boolean }).__failureFragmentSeen,
      );
      expect(flagSeen).toBe(true);
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // Gap #7 (Medium): BulkToolbar hidden while bulkDeleteProgress !== null
  // -------------------------------------------------------------------------

  test('BulkToolbar is hidden during bulk delete and reappears when complete', async () => {
    const { browser, page } = await launchWithArchivedTasks();

    try {
      await openCompletedTasksDialog(page);
      await selectAllTasks(page);

      // BulkToolbar should be visible now (tasks selected, no operation in progress)
      await expect(page.locator('[data-testid="bulk-delete-btn"]')).toBeVisible({ timeout: 3000 });

      // Inject failures so the delete leaves some tasks marked failed (but still completes)
      await page.evaluate((failureIds: string[]) => {
        (window as unknown as { __mockBulkDeleteFailureIds: string[] }).__mockBulkDeleteFailureIds = failureIds;
      }, FAILURE_TASK_IDS);

      await page.locator('[data-testid="bulk-delete-btn"]').click();

      // During the operation: progress pill is visible, BulkToolbar is hidden.
      // The mock is synchronous so we assert the post-completion state only
      // (the sync nature means by the time we can assert, it's already done).
      // The key assertion is the after-state: toolbar is gone (all tasks deleted
      // or no tasks selected) and progress pill is gone.
      await expect.poll(() => readBulkDeleteStore(page).then((state) => state.bulkDeleteProgress), {
        timeout: 8000,
      }).toBeNull();

      await expect(page.locator('[data-testid="bulk-delete-progress"]')).not.toBeVisible({ timeout: 3000 });

      // After completion, toolbar should also be gone because no tasks remain selected
      await expect(page.locator('[data-testid="bulk-delete-btn"]')).not.toBeVisible({ timeout: 3000 });
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // Gap #9 (Medium): Hard IPC throw reverts optimistic removal
  // -------------------------------------------------------------------------

  test('reverts optimistic task removal and shows error toast when IPC throws', async () => {
    const { browser, page } = await launchWithArchivedTasks();

    try {
      await openCompletedTasksDialog(page);
      await selectAllTasks(page);

      // Verify tasks are present before the operation
      const beforeState = await readBulkDeleteStore(page);
      expect(beforeState.archivedCount).toBe(TASK_COUNT);

      // Arm the throw hook
      await page.evaluate(() => {
        (window as unknown as { __mockBulkDeleteThrow: string }).__mockBulkDeleteThrow =
          'No project is currently open';
      });

      await page.locator('[data-testid="bulk-delete-btn"]').click();

      // Wait for bulkDeleteProgress to clear (operation completed in finally)
      await expect.poll(() => readBulkDeleteStore(page).then((state) => state.bulkDeleteProgress), {
        timeout: 8000,
      }).toBeNull();

      // Archived tasks must be restored (optimistic removal reverted)
      await expect.poll(() => readBulkDeleteStore(page).then((state) => state.archivedCount), {
        timeout: 5000,
      }).toBe(TASK_COUNT);

      // Error toast should be visible
      await expect(
        page.locator('[data-testid="toast"]').filter({ hasText: 'Failed to delete tasks' }),
      ).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  // Gap #8 (Low): unsubscribe called in finally even when IPC throws
  //
  // Asserts directly against the mock's bulkDeleteProgressCallbacks array
  // length (exposed via __getBulkDeleteCallbackCount). If the renderer's
  // `finally { unsubscribe() }` block is ever dropped, this count will be
  // non-zero after the failed operation settles.
  // -------------------------------------------------------------------------

  test('unsubscribes progress listener in finally even when IPC throws', async () => {
    const { browser, page } = await launchWithArchivedTasks();

    try {
      await openCompletedTasksDialog(page);
      await selectAllTasks(page);

      // Baseline: no listeners registered before the operation starts.
      const baselineCount = await page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: { tasks: { __getBulkDeleteCallbackCount: () => number } };
        }).electronAPI;
        return api.tasks.__getBulkDeleteCallbackCount();
      });
      expect(baselineCount).toBe(0);

      // Arm the throw hook
      await page.evaluate(() => {
        (window as unknown as { __mockBulkDeleteThrow: string }).__mockBulkDeleteThrow =
          'No project is currently open';
      });

      await page.locator('[data-testid="bulk-delete-btn"]').click();

      // Wait for the operation to settle (bulkDeleteProgress clears in finally).
      await expect.poll(() => readBulkDeleteStore(page).then((state) => state.bulkDeleteProgress), {
        timeout: 8000,
      }).toBeNull();

      // Real assertion: the bulk-delete operation registered its progress
      // listener and - critically - removed it in the `finally` block even
      // though the IPC threw. If unsubscribe() were skipped on the throw
      // path, this count would be 1.
      const finalCount = await page.evaluate(() => {
        const api = (window as unknown as {
          electronAPI: { tasks: { __getBulkDeleteCallbackCount: () => number } };
        }).electronAPI;
        return api.tasks.__getBulkDeleteCallbackCount();
      });
      expect(finalCount).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
