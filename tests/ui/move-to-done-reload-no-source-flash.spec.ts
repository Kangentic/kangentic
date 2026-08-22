/**
 * Regression test for the recurring "card flashes back to its SOURCE column
 * before disappearing into Done" bug.
 *
 * Root cause (distinct from the overlay snap-back covered by
 * move-to-done-no-snapback.spec.ts): a Done drop defers the DB move and flies
 * the card into the dropzone for ~700ms (setCompletingTask removes the task from
 * `tasks` and holds its id in `completingTaskIds`; finalizeCompletion runs the
 * move+archive only at the end). During that flight the backend still has the
 * task at its SOURCE lane. Any loadBoard() racing the flight - in production an
 * agent-driven `onUpdatedByAgent` / `onAutoMoved` reload - re-injects the task
 * into `tasks` at its source swimlane_id. The completingTaskIds guard was only
 * honored by DoneSwimlane, so the SOURCE Swimlane rendered the re-injected card
 * for a frame.
 *
 * The fix excludes completing tasks at the single lane-bucketing chokepoint
 * (KanbanBoard's tasksPerLane), so a completing task renders in no lane for the
 * whole flight. This spec drags a task to Done, fires loadBoard() mid-flight,
 * and asserts the dragged task never reappears in its source column across
 * sampled frames. It runs from multiple source columns, since the reporter saw
 * it "from any column" (most often the last pre-Done column, seeded as "Merge").
 *
 * Without the fix the re-injected card lingers in the source lane for the rest
 * of the flight, so the rAF sampler reliably catches it (red); with the fix the
 * source lane never shows it (green).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-done-reload-flash';

// One seeded task per source column. Titles are unique and are not substrings
// of any column name, so a textContent scan of a lane is unambiguous.
const SOURCES: Array<{ column: string; taskId: string; title: string }> = [
  { column: 'Executing', taskId: 'task-reload-flash-exec', title: 'Exec Reload Flash Probe' },
  { column: 'Merge', taskId: 'task-reload-flash-merge', title: 'Landing Reload Flash Probe' },
];

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Reload Flash Test',
        path: '/mock/reload-flash-test',
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
      ${JSON.stringify(SOURCES)}.forEach(function (src) {
        state.tasks.push({
          id: src.taskId,
          title: src.title,
          description: 'Dragged to Done with a racing reload',
          swimlane_id: laneIds[src.column],
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

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 10px shift satisfies dnd-kit's PointerSensor activation distance; poll the
  // board store's `activeTask` rather than the `.drag-overlay` element.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // Wait for DoneSwimlane's `.drop-zone-active` (dnd-kit isOver) so the drop
  // fires only once the hover state has registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
}

interface BoardSettleState {
  completingTask: boolean;
  completingTaskIdCount: number;
  taskIds: string[];
  archivedIds: string[];
}

async function readBoardSettleState(page: Page): Promise<BoardSettleState> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            completingTask: unknown;
            completingTaskIds: Set<string>;
            tasks: Array<{ id: string }>;
            archivedTasks: Array<{ id: string }>;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    return {
      completingTask: state.completingTask !== null && state.completingTask !== undefined,
      completingTaskIdCount: state.completingTaskIds.size,
      taskIds: state.tasks.map((task) => task.id),
      archivedIds: state.archivedTasks.map((task) => task.id),
    };
  });
}

test.describe('Move to Done - no source-column flash when a reload races the fly', () => {
  for (const source of SOURCES) {
    test(`reload mid-flight never re-shows the card in "${source.column}"`, async () => {
      const { browser, page } = await launch();

      try {
        await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });
        await expect(
          page.locator(`[data-swimlane-name="${source.column}"]`).locator(`text=${source.title}`),
        ).toBeVisible();

        await dragTaskToColumn(page, source.title, 'Done');

        // Wait for the live flight (FlyingCard mounted).
        await expect.poll(async () => page.evaluate(
          () => document.querySelector('.flying-card') !== null,
        ), { timeout: 3000 }).toBe(true);

        // Install a per-frame sampler that records whether the dragged task's
        // title ever reappears inside its SOURCE lane. The FlyingCard renders at
        // the board root (not inside any swimlane), so it cannot false-positive.
        await page.evaluate((args: { column: string; title: string }) => {
          const win = window as unknown as { __sawSourceFlash: boolean; __sourceFlashRaf: number };
          win.__sawSourceFlash = false;
          const sample = () => {
            const lane = document.querySelector(`[data-swimlane-name="${args.column}"]`);
            if (lane && lane.textContent && lane.textContent.includes(args.title)) {
              win.__sawSourceFlash = true;
            }
            win.__sourceFlashRaf = requestAnimationFrame(sample);
          };
          sample();
        }, { column: source.column, title: source.title });

        // Fire the production-capable trigger: a loadBoard() during the flight.
        // The mock archives the task only on the move IPC (run at finalize), so
        // tasks.list() here still returns it at its source lane and the reload
        // re-injects it into state.tasks at that lane.
        await page.evaluate(() => (window as unknown as {
          __zustandStores: { board: { getState: () => { loadBoard: () => Promise<void> } } };
        }).__zustandStores.board.getState().loadBoard());

        // Let the flight finish: the task lands in archived and the guard clears.
        await expect.poll(async () => {
          const state = await readBoardSettleState(page);
          return state.completingTask === false
            && state.completingTaskIdCount === 0
            && state.archivedIds.includes(source.taskId);
        }, { timeout: 5000 }).toBe(true);

        const sawSourceFlash = await page.evaluate(() => {
          const win = window as unknown as { __sawSourceFlash: boolean; __sourceFlashRaf: number };
          cancelAnimationFrame(win.__sourceFlashRaf);
          return win.__sawSourceFlash;
        });
        expect(sawSourceFlash).toBe(false);

        // Settled DOM: gone from the source lane, present in Done's archived list.
        await expect(
          page.locator(`[data-swimlane-name="${source.column}"]`).locator(`text=${source.title}`),
        ).toHaveCount(0);
        await expect(page.locator('.flying-card')).toHaveCount(0);

        // Lock the moveGeneration early-return edge: a post-settle reload must
        // not resurrect the task into any active lane.
        await page.evaluate(() => (window as unknown as {
          __zustandStores: { board: { getState: () => { loadBoard: () => Promise<void> } } };
        }).__zustandStores.board.getState().loadBoard());
        await expect.poll(async () => {
          const state = await readBoardSettleState(page);
          return !state.taskIds.includes(source.taskId) && state.archivedIds.includes(source.taskId);
        }, { timeout: 3000 }).toBe(true);
      } finally {
        await browser.close();
      }
    });
  }
});
