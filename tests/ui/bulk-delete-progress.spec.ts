/**
 * Regression test for bulk task delete progress UI.
 *
 * Verifies that when many archived tasks are bulk-deleted from the Completed
 * Tasks dialog:
 *  - a progress indicator becomes visible during the operation
 *  - every selected task is removed from archivedTasks
 *  - the progress indicator disappears when done
 *
 * Backstop for the "bulk delete freezes app + orphans worktrees" bug: if a
 * future change re-introduces a synchronous blocking loop, the progress
 * counter will never tick (we never see a mid-flight "Deleting X of N"
 * string on the last emitted progress event).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-bulk-delete-progress';
const TASK_COUNT = 10;

interface StoreProbe {
  archivedIds: string[];
  bulkDeleteProgress: { completed: number; total: number } | null;
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockConfigOverrides = Object.assign(
      window.__mockConfigOverrides || {},
      { skipDeleteConfirm: true }
    );
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.config) {
      void window.electronAPI.config.set({ skipDeleteConfirm: true });
    }
    window.__mockPreConfigure(function (state) {
      var timestamp = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Bulk Delete Test',
        path: '/mock/bulk-delete-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: timestamp,
        created_at: timestamp,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (lane, index) {
        var id = 'lane-' + lane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[lane.name] = id;
        state.swimlanes.push(Object.assign({}, lane, {
          id: id,
          position: index,
          created_at: timestamp,
        }));
      });
      for (var index = 0; index < ${TASK_COUNT}; index += 1) {
        state.archivedTasks.push({
          id: 'archived-task-' + index,
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

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);
  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return { browser, page };
}

async function readStore(page: Page): Promise<StoreProbe> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            archivedTasks: Array<{ id: string }>;
            bulkDeleteProgress: { completed: number; total: number } | null;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    return {
      archivedIds: state.archivedTasks.map((archivedTask) => archivedTask.id),
      bulkDeleteProgress: state.bulkDeleteProgress,
    };
  });
}

test.describe('Bulk delete - progress UI + partial-failure semantics', () => {
  test('progress indicator appears during bulk delete and all tasks are removed', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('[data-testid="view-all-completed"]').click();
      await page.locator('[data-testid="completed-tasks-dialog"]').waitFor({ state: 'visible' });

      const rows = page.locator('[data-testid="completed-task-row"]');
      await expect.poll(() => rows.count(), { timeout: 5000 }).toBe(TASK_COUNT);

      const progressEvents: Array<{ completed: number; total: number }> = [];
      await page.exposeFunction(
        '__recordProgress',
        (completed: number, total: number) => {
          progressEvents.push({ completed, total });
        },
      );
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: { subscribe: (listener: (state: unknown) => void) => () => void };
          };
        }).__zustandStores;
        if (!stores) return;
        const recorder = (window as unknown as {
          __recordProgress: (completed: number, total: number) => void;
        }).__recordProgress;
        stores.board.subscribe((state) => {
          const progress = (state as { bulkDeleteProgress: { completed: number; total: number } | null }).bulkDeleteProgress;
          if (progress) recorder(progress.completed, progress.total);
        });
      });

      await page.locator('[data-testid="select-all-checkbox"]').check();

      await page.locator('[data-testid="bulk-delete-btn"]').click();

      await expect.poll(async () => {
        const state = await readStore(page);
        return state.archivedIds.length;
      }, { timeout: 10000 }).toBe(0);

      await expect.poll(async () => {
        const state = await readStore(page);
        return state.bulkDeleteProgress;
      }, { timeout: 5000 }).toBeNull();

      expect(progressEvents.length).toBeGreaterThan(0);
      const finalEvent = progressEvents[progressEvents.length - 1];
      expect(finalEvent.total).toBe(TASK_COUNT);
      expect(finalEvent.completed).toBe(TASK_COUNT);
      expect(progressEvents.some((event) => event.completed > 0 && event.completed < TASK_COUNT)).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
