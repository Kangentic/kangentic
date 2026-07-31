import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

/**
 * Drag-jank gate: while a board drag is active, non-positional session-store
 * pushes (spawn progress, activity, ...) must be HELD by the coalescer so the
 * initializing TaskCard does not re-render mid-drag (which would force dnd-kit
 * to re-measure on the pointer-move thread). They flush on drag end.
 *
 * Asserting at the store level is the clean proxy: if the held update never
 * reaches the session store during the drag, the subscribed card cannot
 * re-render from it. We verify the value is unchanged during the drag and
 * applied immediately after the drop.
 */

const runId = Date.now();
const PROJECT_NAME = `Coalesce Test ${runId}`;
const DRAG_TASK = 'Drag Me Smoothly';
const SPAWNING_TASK = 'Initializing Task';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME, '/tmp/coalesce-test');
  await createTask(page, DRAG_TASK);
  await createTask(page, SPAWNING_TASK);
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Resolve a task's id from the exposed board store (createTask doesn't return it). */
async function getTaskIdByTitle(title: string): Promise<string> {
  const id = await page.evaluate((wantedTitle) => {
    const win = window as unknown as {
      __zustandStores: { board: { getState: () => { tasks: Array<{ id: string; title: string }> } } };
    };
    const found = win.__zustandStores.board.getState().tasks.find((task) => task.title === wantedTitle);
    return found ? found.id : null;
  }, title);
  if (!id) throw new Error(`Task "${title}" not found in board store`);
  return id;
}

/** Read the held-or-applied spawn-progress label for a task from the session store. */
async function readSpawnProgress(taskId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const win = window as unknown as {
      __zustandStores: { session: { getState: () => { spawnProgress: Record<string, string> } } };
    };
    return win.__zustandStores.session.getState().spawnProgress[id] ?? null;
  }, taskId);
}

async function fireSpawnProgress(taskId: string, label: string | null): Promise<void> {
  await page.evaluate((args) => {
    const win = window as unknown as {
      __mockFireSpawnProgress: (taskId: string, label: string | null) => void;
    };
    win.__mockFireSpawnProgress(args.taskId, args.label);
  }, { taskId, label });
}

/**
 * Session pushes must keep applying to OTHER cards while a board drag is in flight.
 *
 * This used to assert the opposite - that the update was withheld until the drop -
 * because the gate parked every session push for the length of the gesture. That
 * froze every agent's indicator and context bar on the board while the user dragged
 * an unrelated card, which reads as the app hanging. Agents are independent of a
 * board gesture; their reporting has to survive it.
 *
 * The hold was justified by a claim that a re-render forces dnd-kit to re-measure on
 * the pointer-move thread. It does not: droppables register in a `useEffect(...,
 * [id])` and the default measuring strategy is WhileDragging, not Always. What DOES
 * disturb a drag is a card changing HEIGHT, because dnd-kit's ResizeObserver runs
 * only while dragging and re-measures every card below the resized one. That is
 * prevented at the source instead - TaskCard's running-state spinner is structurally
 * identical to its resolved context footer, so a spawn resolving cannot grow a card.
 *
 * The spawning card is deliberately a DIFFERENT card from the dragged one: that is
 * the case dnd-kit's `updateMeasurementsFor: itemsAfterCurrentSortable` cascade
 * would hit.
 */
test('spawn-progress updates apply to another card DURING an active board drag', async () => {
  const dragTaskId = await getTaskIdByTitle(DRAG_TASK);
  const spawningTaskId = await getTaskIdByTitle(SPAWNING_TASK);

  // Baseline: with no drag in progress, a push applies (coalesced on a microtask).
  await fireSpawnProgress(spawningTaskId, 'Creating worktree...');
  await expect.poll(() => readSpawnProgress(spawningTaskId), { timeout: 2000 })
    .toBe('Creating worktree...');

  // Start (but don't finish) a drag on the OTHER card so a drag is active.
  const dragCard = page.locator(`[data-task-id="${dragTaskId}"]`);
  await dragCard.waitFor({ state: 'visible', timeout: 5000 });
  const box = await dragCard.boundingBox();
  if (!box) throw new Error('Could not get bounding box for drag card');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move past the 5px PointerSensor activation threshold to start the drag.
  await page.mouse.move(startX + 12, startY, { steps: 3 });
  await expect(page.locator('.drag-overlay').filter({ hasText: DRAG_TASK }))
    .toBeVisible({ timeout: 2000 });

  // Measure the spawning card's height while the drag is live. If applying the
  // update grew it, dnd-kit would re-measure every card below it in the lane - the
  // one thing that genuinely disturbs a drag.
  const spawningCard = page.locator(`[data-task-id="${spawningTaskId}"]`);
  const heightBefore = (await spawningCard.boundingBox())?.height ?? 0;
  expect(heightBefore).toBeGreaterThan(0);

  // While the drag is active, push a NEW spawn-progress label for the other task.
  await fireSpawnProgress(spawningTaskId, 'Starting agent...');

  // It must APPLY, without waiting for the drop.
  await expect.poll(() => readSpawnProgress(spawningTaskId), { timeout: 2000 })
    .toBe('Starting agent...');

  // ...and the card must not have changed height doing so. Tolerance rather than an
  // exact match: font metrics and sub-pixel rounding differ between local Windows
  // and CI's headless Linux.
  const heightDuring = (await spawningCard.boundingBox())?.height ?? 0;
  expect(Math.abs(heightDuring - heightBefore)).toBeLessThanOrEqual(1);

  // The drag is still live and unaffected.
  await expect(page.locator('.drag-overlay').filter({ hasText: DRAG_TASK })).toBeVisible();

  await page.mouse.up();
  await page.locator('.drag-overlay').filter({ hasText: DRAG_TASK })
    .waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});

  // Still correct after the drop.
  expect(await readSpawnProgress(spawningTaskId)).toBe('Starting agent...');
});
