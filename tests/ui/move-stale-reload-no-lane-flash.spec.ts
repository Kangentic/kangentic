/**
 * Regression test for "a card snaps back to its source column mid-move".
 *
 * Reported as: drag two active tasks from Executing to To Do in quick
 * succession; both land, then one visibly returns to Executing for a moment
 * before settling back in To Do.
 *
 * Mechanism (all proven from source, none of it timing-dependent):
 *   - `loadBoard()` has NO staleness guard. It replaces `tasks` wholesale with
 *     whatever `tasks.list()` returned, however long ago that call was issued.
 *   - `applyStructuralSharing` cannot save it: `taskContentsMatch` compares
 *     `swimlane_id` explicitly, so when the server row says Executing and the
 *     optimistic row says To Do the match fails and the SERVER object wins.
 *   - `endBoardDrag()` runs at the top of `handleDragEnd`, ~190 lines before
 *     `moveTask` is called, and drains parked reloads synchronously. So a
 *     reload's `tasks.list()` is issued BEFORE the optimistic update is applied
 *     and before the move's DB write lands.
 *
 * The fix pins the destination lane at KanbanBoard's `tasksPerLane` chokepoint
 * (the single place tasks are bucketed into lanes), so the card renders at its
 * destination until a payload actually reports the move landed.
 *
 * This spec forces the exact production interleaving deterministically:
 * a `tasks.list()` is issued and frozen BEFORE the move, the move IPC is held
 * open, the stale payload is delivered while the move is still in flight, and
 * the card must not move. Releasing the move then settles it for real.
 *
 * Without the fix the stale payload puts the card back in Executing and the rAF
 * sampler catches it. With the fix the source lane never shows it again.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-stale-reload-lane';
const SOURCE_COLUMN = 'Executing';
const TARGET_COLUMN = 'To Do';
// Unique, and not a substring of any column name, so a lane textContent scan is
// unambiguous.
const TASK_ID = 'task-stale-reload-probe';
const TASK_TITLE = 'Stale Reload Lane Probe';

interface BoardWindow {
  __zustandStores: {
    board: {
      getState: () => {
        loadBoard: () => Promise<void>;
        activeTask: { id: string } | null;
        tasks: Array<{ id: string; swimlane_id: string }>;
        lanePins: ReadonlyMap<string, { laneId: string }>;
      };
    };
  };
  __mockHoldNextTaskList?: boolean;
  __mockReleaseTaskList?: () => void;
  __mockTaskMoveDeferred?: boolean;
  __mockTaskMoveResolve?: () => void;
}

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
        name: 'Stale Reload Test',
        path: '/mock/stale-reload-test',
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
        title: '${TASK_TITLE}',
        description: 'Moved while a pre-write tasks.list() is in flight',
        swimlane_id: laneIds['${SOURCE_COLUMN}'],
        position: 0,
        agent: 'claude',
        session_id: null,
        // No worktree and no branch, so the destructive move-to-To-Do
        // confirmation never fires and the move runs straight through.
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

/** Drag the seeded card into a normal (non-Done) column and release. */
async function dragCardToColumn(page: Page, targetColumn: string): Promise<void> {
  const card = page.locator(`[data-swimlane-name="${SOURCE_COLUMN}"]`).locator(`text=${TASK_TITLE}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  // Past dnd-kit's PointerSensor activation distance; poll the store rather than
  // a class, so this does not depend on overlay render timing.
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 12, cardBox.y + cardBox.height / 2, { steps: 3 });
  await expect.poll(async () => page.evaluate(
    () => (window as unknown as BoardWindow).__zustandStores.board.getState().activeTask !== null,
  ), { timeout: 3000 }).toBe(true);

  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 140, { steps: 15 });
  await page.mouse.up();
}

/** Which lane the board store believes the task is in, per the raw server row. */
async function readTaskLane(page: Page): Promise<string | undefined> {
  return page.evaluate((taskId) => {
    const state = (window as unknown as BoardWindow).__zustandStores.board.getState();
    return state.tasks.find((task) => task.id === taskId)?.swimlane_id;
  }, TASK_ID);
}

test.describe('Move to another column - no source-lane flash when a pre-write reload lands', () => {
  test('a tasks.list() issued before the write cannot pull the card back to its source lane', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator(`[data-swimlane-name="${TARGET_COLUMN}"]`).waitFor({ state: 'visible', timeout: 15000 });
      await expect(
        page.locator(`[data-swimlane-name="${SOURCE_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toBeVisible();

      // 1. Freeze a payload from BEFORE the move and hold the move IPC open, so
      //    the stale payload can be delivered while the move is still in flight.
      //    That ordering is what production produces: endBoardDrag() flushes the
      //    parked reload at the top of handleDragEnd, so its tasks.list() is
      //    issued well before the move's own reload is even requested.
      await page.evaluate(() => {
        const win = window as unknown as BoardWindow;
        win.__mockHoldNextTaskList = true;
        win.__mockTaskMoveDeferred = true;
        // Not awaited: this is the reload whose payload must lose.
        void win.__zustandStores.board.getState().loadBoard();
      });

      // 2. Drop the card in the target column. moveTask applies its optimistic
      //    update and pins the lane, then parks on the held move IPC.
      await dragCardToColumn(page, TARGET_COLUMN);
      await expect(
        page.locator(`[data-swimlane-name="${TARGET_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toBeVisible({ timeout: 3000 });

      // 3. Only now start sampling every frame - before the drop the card is
      //    legitimately in its source lane. Sampling (rather than asserting the
      //    final state) is the point: with the bug present the move's own reload
      //    corrects the clobber a moment later, so a settled-state check passes
      //    while the user still sees the card jump. That is exactly why this
      //    shipped. Armed BEFORE the stale payload is released, so it cannot
      //    miss the clobber it exists to catch.
      await page.evaluate((args: { column: string; title: string }) => {
        const win = window as unknown as { __sawSourceFlash: boolean; __sourceFlashRaf: number };
        win.__sawSourceFlash = false;
        const sample = () => {
          const lane = document.querySelector(`[data-swimlane-name="${args.column}"]`);
          if (lane?.textContent?.includes(args.title)) win.__sawSourceFlash = true;
          win.__sourceFlashRaf = requestAnimationFrame(sample);
        };
        sample();
      }, { column: SOURCE_COLUMN, title: TASK_TITLE });

      // 4. Deliver the stale payload. It legitimately wins on `tasks` (structural
      //    sharing is not a merge), so the store's raw row goes back to the source
      //    lane - and the card must STILL render at its destination.
      await page.evaluate(() => {
        (window as unknown as BoardWindow).__mockReleaseTaskList?.();
      });
      await expect.poll(async () => readTaskLane(page), { timeout: 3000 })
        .toBe(`lane-${SOURCE_COLUMN.toLowerCase()}`);

      // Give the clobber several frames to paint if it is going to.
      await expect(
        page.locator(`[data-swimlane-name="${TARGET_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toBeVisible();

      // 5. Let the move complete. Its reload reports the new lane and a fresh
      //    updated_at, which is what legitimately drops the pin.
      await page.evaluate(() => {
        (window as unknown as BoardWindow).__mockTaskMoveResolve?.();
      });

      await expect.poll(async () => readTaskLane(page), { timeout: 5000 })
        .toBe(`lane-${TARGET_COLUMN.toLowerCase().replace(/\s+/g, '-')}`);

      // The card never appeared in its source lane at any sampled frame.
      const sawSourceFlash = await page.evaluate(() => {
        const win = window as unknown as { __sawSourceFlash: boolean; __sourceFlashRaf: number };
        cancelAnimationFrame(win.__sourceFlashRaf);
        return win.__sawSourceFlash;
      });
      expect(sawSourceFlash).toBe(false);

      // Settled DOM.
      await expect(
        page.locator(`[data-swimlane-name="${SOURCE_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toHaveCount(0);
      await expect(
        page.locator(`[data-swimlane-name="${TARGET_COLUMN}"]`).locator(`text=${TASK_TITLE}`),
      ).toBeVisible();

      // And the pin was released rather than leaked - a fix that "works" by
      // stranding a pin would hold the card in a phantom column forever.
      await expect.poll(async () => page.evaluate(
        () => (window as unknown as BoardWindow).__zustandStores.board.getState().lanePins.size,
      ), { timeout: 3000 }).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
