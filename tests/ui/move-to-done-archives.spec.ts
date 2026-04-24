/**
 * Regression test for the "completed task stops in Done dropzone" bug.
 *
 * After a drag-to-Done completes, the moved task must be absent from
 * state.tasks and present in state.archivedTasks. A prior race between
 * task-move.ts's tasks.move() and tasks.archive() could leave the card
 * painted in the Done dropzone until the next board reload. See the
 * completingTaskIds filter in board-store / DoneSwimlane for the fix.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-archives';
const TASK_ID = 'task-done-archives';

interface StoreProbe {
  tasks: Array<{ id: string }>;
  archivedTasks: Array<{ id: string }>;
  completingTask: unknown;
  completingTaskIds: string[];
}

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockConfigOverrides = Object.assign(
      window.__mockConfigOverrides || {},
      { skipDoneWorktreeConfirm: true }
    );
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.config) {
      void window.electronAPI.config.set({ skipDoneWorktreeConfirm: true });
    }
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Done Archives Test',
        path: '/mock/done-archives-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Archive Me',
        description: 'Dragged to Done',
        swimlane_id: laneIds['Executing'],
        position: 0,
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
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });
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

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((col: string) => {
    document.querySelector(`[data-swimlane-name="${col}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  // The .drag-overlay element is mounted by dnd-kit's DragOverlay component
  // only while activeTask is non-null (see KanbanBoard.tsx). Polling for it
  // between the activation move and the long move confirms dnd-kit's
  // PointerSensor picked up the drag before we start cursor travel - avoids
  // a race on slow machines where the long move could fire before the
  // sensor's activation listeners attached.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.locator('.drag-overlay').waitFor({ state: 'attached', timeout: 3000 });
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.mouse.up();
  // After release, wait for dnd-kit to tear down the overlay before returning
  // so downstream assertions don't observe mid-teardown state.
  await page.locator('.drag-overlay').waitFor({ state: 'detached', timeout: 3000 });
}

async function readStore(page: Page): Promise<StoreProbe> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            tasks: Array<{ id: string }>;
            archivedTasks: Array<{ id: string }>;
            completingTask: unknown;
            completingTaskIds: Set<string>;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const store = stores.board;
    const state = store.getState();
    return {
      tasks: state.tasks.map((t) => ({ id: t.id })),
      archivedTasks: state.archivedTasks.map((t) => ({ id: t.id })),
      completingTask: state.completingTask,
      completingTaskIds: Array.from(state.completingTaskIds),
    };
  });
}

test.describe('Move to Done - archive state consistency', () => {
  test('dragged task ends up in archivedTasks and not in tasks', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      await expect(executingColumn.locator('text=Archive Me')).toBeVisible();

      await dragTaskToColumn(page, 'Archive Me', 'Done');

      // Wait for the completion pipeline to fully settle: FlyingCard fallback
      // timer + moveTask IPC + reload. 2s is generous for a mocked IPC.
      await expect
        .poll(async () => {
          const state = await readStore(page);
          return state.completingTask === null && state.completingTaskIds.length === 0;
        }, { timeout: 3000 })
        .toBe(true);

      const state = await readStore(page);
      expect(state.tasks.find((t) => t.id === TASK_ID)).toBeUndefined();
      expect(state.archivedTasks.find((t) => t.id === TASK_ID)).toBeDefined();

      // And it shouldn't be rendered as an active card anywhere on the board
      const activeCard = page.locator('[data-done-drop-zone]').locator('text=Archive Me');
      await expect(activeCard).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a racing loadBoard during completion does not re-paint the card in the dropzone', async () => {
    // Simulates the main race: after setCompletingTask fires but before
    // moveTask's reload completes, something else triggers loadBoard().
    // The completingTaskIds filter should keep the task out of the dropzone.
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.locator('[data-swimlane-name="Executing"]').locator('text=Archive Me')).toBeVisible();

      // Fire the drag, then wait until completingTaskIds is non-empty before
      // injecting the racing loadBoard(). On slow CI the filter might not yet
      // be active if we call loadBoard() before setCompletingTask has fired.
      await dragTaskToColumn(page, 'Archive Me', 'Done');

      await expect.poll(async () => {
        const ids = await page.evaluate(() => {
          const stores = (window as unknown as {
            __zustandStores?: {
              board: {
                getState: () => {
                  completingTaskIds: Set<string>;
                };
              };
            };
          }).__zustandStores;
          if (!stores) return 0;
          return stores.board.getState().completingTaskIds.size;
        });
        return ids;
      }, { timeout: 3000 }).toBeGreaterThan(0);

      // Now inject the race: loadBoard() runs while the filter is active.
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { loadBoard: () => Promise<void> } } };
        }).__zustandStores;
        stores?.board.getState().loadBoard();
      });

      const dropZoneCard = page.locator('[data-done-drop-zone]').locator('text=Archive Me');
      // Must never render while the pipeline is active OR after it settles.
      await expect(dropZoneCard).toHaveCount(0);

      await expect
        .poll(async () => {
          const state = await readStore(page);
          return state.completingTask === null && state.completingTaskIds.length === 0;
        }, { timeout: 3000 })
        .toBe(true);

      await expect(dropZoneCard).toHaveCount(0);
      const state = await readStore(page);
      expect(state.archivedTasks.find((t) => t.id === TASK_ID)).toBeDefined();
    } finally {
      await browser.close();
    }
  });
});
