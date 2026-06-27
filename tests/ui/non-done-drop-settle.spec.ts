/**
 * Regression guard for the conditional `dropAnimation` fix in KanbanBoard.
 *
 * Before the fix, <DragOverlay> had a global `dropAnimation={null}`, which
 * eliminated the dnd-kit default ~250ms settle animation for EVERY drop target,
 * not just Done. The fix makes it conditional:
 *   - `isOverDone ? null : undefined`
 *   - Over Done: null (FlyingCard owns the motion; overlay must vanish synchronously)
 *   - Over non-Done: undefined (dnd-kit DEFAULT settle animation restored)
 *
 * This spec drags a task from Executing to Code Review (a non-Done lane) and
 * asserts that:
 *   1. The `.drag-overlay` clone persists in the DOM for at least one rAF frame
 *      after `mouse.up()` (proving the default settle animation is running, not
 *      the synchronous-detach null path).
 *   2. NO `.flying-card` is created (the FlyingCard path is Done-only).
 *   3. The task lands in the Code Review lane after the move resolves.
 *
 * The existing `move-to-done-no-snapback.spec.ts` covers the Done path (overlay
 * count = 0 at fly time, fly is the only element in motion). This spec covers
 * the inverse: non-Done path (overlay count >= 1 during settle, no fly).
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

// Distinct IDs to avoid collision with move-to-done-no-snapback.spec.ts
const PROJECT_ID = 'proj-non-done-settle';
const TASK_ID = 'task-non-done-settle';

async function launch(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  // Pre-configure: create a project with DEFAULT_SWIMLANES and one task in Executing.
  const preConfigScript = `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Non-Done Drop Settle Test',
        path: '/mock/non-done-settle-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var id = 'nds-lane-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = id;
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: id,
          position: index,
          created_at: ts,
        }));
      });
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Settle Test Task',
        description: 'Dragged to Code Review',
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

/**
 * Drag a task card to a non-Done column and release.
 *
 * For non-Done targets there is no `.drop-zone-active` indicator (that is
 * Done-specific). Instead we wait for the `.drop-highlight` class on the
 * target swimlane element, which `updateDropHighlight` in useBoardDragDrop.ts
 * adds via direct DOM mutation on every `handleDragOver` event.
 */
async function dragTaskToNonDoneColumn(
  page: Page,
  taskTitle: string,
  targetColumnName: string,
): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumnName}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((columnName: string) => {
    document.querySelector(`[data-swimlane-name="${columnName}"]`)
      ?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumnName);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 10px shift satisfies dnd-kit's PointerSensor activation distance.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  // Poll the board store's `activeTask` to confirm drag activation.
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // Wait for `.drop-highlight` on the target swimlane. This class is added by
  // `updateDropHighlight` in useBoardDragDrop.ts via direct DOM mutation on
  // handleDragOver. Non-Done lanes do NOT get `.drop-zone-active`; that is
  // Done-specific. The `data-swimlane-id` attribute lives on the same root
  // element as `data-swimlane-name` in Swimlane.tsx.
  await expect(target).toHaveClass(/drop-highlight/, { timeout: 2000 });

  await page.mouse.up();
}

interface BoardTaskState {
  taskSwimlaneId: string | null;
  taskSwimlaneFound: boolean;
  codeReviewLaneId: string | null;
}

async function readTaskSwimlane(page: Page, taskId: string): Promise<BoardTaskState> {
  return page.evaluate((targetTaskId: string) => {
    const stores = (window as unknown as {
      __zustandStores?: {
        board: {
          getState: () => {
            tasks: Array<{ id: string; swimlane_id: string }>;
            swimlanes: Array<{ id: string; name: string }>;
          };
        };
      };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    const state = stores.board.getState();
    const foundTask = state.tasks.find((boardTask) => boardTask.id === targetTaskId);
    const codeReviewLane = state.swimlanes.find((lane) => lane.name === 'Code Review');
    return {
      taskSwimlaneId: foundTask?.swimlane_id ?? null,
      taskSwimlaneFound: foundTask !== undefined,
      codeReviewLaneId: codeReviewLane?.id ?? null,
    };
  }, taskId);
}

test.describe('Non-Done cross-column move - default drop animation (settle guard)', () => {
  test('overlay clone persists after release and no flying card is created', async () => {
    const { browser, page } = await launch();

    try {
      await page.locator('[data-swimlane-name="Code Review"]').waitFor({ state: 'visible', timeout: 15000 });
      await expect(
        page.locator('[data-swimlane-name="Executing"]').locator('text=Settle Test Task'),
      ).toBeVisible();

      // Install a rAF sampler that records the maximum .drag-overlay count seen
      // across frames. The sampler is installed before the drag starts so it
      // captures both the during-drag overlay (expected to be 1) and, crucially,
      // any frames AFTER release where the settle animation keeps the overlay
      // mounted. With the old global `dropAnimation={null}` the overlay detaches
      // synchronously on release (count returns to 0 on the very first post-release
      // frame); with `dropAnimation={undefined}` the default 250ms settle keeps it
      // mounted for several more frames.
      //
      // We record the overlay count on the SECOND rAF frame after release.
      // `__overlayPostReleaseCount` uses -1 as a sentinel meaning "the second
      // post-release frame has not yet fired". This is critical: with the initial
      // value at 0, the previous poll condition (`mouseUpFired && maxCount >= 1`)
      // could resolve immediately after mouseup (maxCount is always >= 1 from
      // during-drag frames) before the second post-release frame had actually run,
      // leaving postReleaseCount stuck at the default 0. The sentinel ensures the
      // poll cannot resolve until the second frame has genuinely executed.
      await page.evaluate(() => {
        const win = window as unknown as {
          __overlayMaxCount: number;
          __overlayRafHandle: number;
          __overlayPostReleaseCount: number;
          __overlayMouseUpFired: boolean;
        };
        win.__overlayMaxCount = 0;
        // -1 = "second post-release frame not yet seen".
        // 0  = "second frame ran, overlay was absent" (null path regression).
        // >= 1 = "second frame ran, overlay still mounted" (settle animation running).
        win.__overlayPostReleaseCount = -1;
        win.__overlayMouseUpFired = false;

        // Listen for the mouseup so we know when "post-release" starts.
        document.addEventListener('mouseup', function onMouseUp() {
          win.__overlayMouseUpFired = true;
          document.removeEventListener('mouseup', onMouseUp);
        }, { capture: true });

        let framesSinceRelease = 0;
        const sampleFrame = () => {
          const count = document.querySelectorAll('.drag-overlay').length;
          if (count > win.__overlayMaxCount) win.__overlayMaxCount = count;
          if (win.__overlayMouseUpFired) {
            framesSinceRelease += 1;
            // Record the count on the second post-release frame to avoid
            // the same-microtask-batch ambiguity of the first frame.
            if (framesSinceRelease === 2) {
              // Overwrites the -1 sentinel with the actual count (0 or >= 1).
              win.__overlayPostReleaseCount = count;
            }
          }
          win.__overlayRafHandle = requestAnimationFrame(sampleFrame);
        };
        win.__overlayRafHandle = requestAnimationFrame(sampleFrame);
      });

      await dragTaskToNonDoneColumn(page, 'Settle Test Task', 'Code Review');

      // Wait until the SECOND post-release rAF frame has genuinely executed.
      // We gate on __overlayPostReleaseCount >= 0 (any value other than the -1
      // sentinel) rather than on `mouseUpFired && maxCount >= 1`. The old
      // condition was the source of the CI flake: maxCount is always >= 1 from
      // during-drag frames, so it resolved the moment mouseup fired - potentially
      // before a single post-release rAF frame had run, leaving postReleaseCount
      // stuck at 0 (the former default) even when the settle animation was active.
      // The sentinel approach makes the poll causally dependent on the second frame.
      await expect.poll(async () => page.evaluate(() => {
        const win = window as unknown as {
          __overlayPostReleaseCount: number;
        };
        // -1 means the second post-release frame has not fired yet. Any other
        // value (0 = overlay gone, >= 1 = overlay still present) means we can
        // safely read the result.
        return win.__overlayPostReleaseCount >= 0;
      }), { timeout: 3000, intervals: [50, 50, 50, 100, 100] }).toBe(true);

      const samplerResult = await page.evaluate(() => {
        const win = window as unknown as {
          __overlayMaxCount: number;
          __overlayPostReleaseCount: number;
          __overlayRafHandle: number;
        };
        cancelAnimationFrame(win.__overlayRafHandle);
        return {
          maxCount: win.__overlayMaxCount,
          postReleaseCount: win.__overlayPostReleaseCount,
        };
      });

      // The overlay was present during the drag (maxCount >= 1 is guaranteed by
      // dnd-kit's DragOverlay rendering the clone while dragging).
      expect(samplerResult.maxCount).toBeGreaterThanOrEqual(1);

      // The critical regression guard: the overlay clone survived at least one
      // rAF frame past release (postReleaseCount >= 1). With `dropAnimation={null}`
      // (the old global disable) the overlay detaches synchronously on mouseup and
      // this count is 0. With `dropAnimation={undefined}` (the default 250ms settle)
      // the overlay remains mounted for the settle duration, so the second post-
      // release frame sees count = 1.
      expect(samplerResult.postReleaseCount).toBeGreaterThanOrEqual(1);

      // No FlyingCard was created - that path is Done-only.
      await expect(page.locator('.flying-card')).toHaveCount(0);

      // The task lands in Code Review (not archived, still in the active task list).
      await expect.poll(async () => {
        const state = await readTaskSwimlane(page, TASK_ID);
        return (
          state.taskSwimlaneFound
          && state.taskSwimlaneId !== null
          && state.codeReviewLaneId !== null
          && state.taskSwimlaneId === state.codeReviewLaneId
        );
      }, { timeout: 3000 }).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
