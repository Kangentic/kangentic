import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask, collectPageErrors } from './helpers';
import type { Browser, Page } from '@playwright/test';

/**
 * A Done drop's pending-changes probe fetches remotes after the release, and on
 * the dogfooding instance that probe ran 640 to 1150ms against a 500ms card
 * flight (2026-09-16 drag audit). The board therefore warms the throttled
 * all-remotes fetch the moment a drag of a WORKTREE-BACKED card begins, so the
 * probe skips or joins that fetch rather than starting its own. A card with no
 * worktree has no probe and must not trigger a fetch. Both halves are pinned
 * here through the mock bridge's call log; the test goes red if the prefetch is
 * removed from handleDragStart or if it starts firing for every card.
 *
 * Scope: this is the RENDERER half only. Whether main actually fetches is gated
 * there on `git.autoFetchIntervalMinutes` (off means the endpoint is a no-op),
 * which the mock bridge never runs; that half lives in the main handler and is
 * covered by the throttle's own unit tests.
 *
 * The call is fire-and-forget with `.catch(() => {})` at the call site, so a
 * rejecting prefetch must never break the drag. The third test below forces
 * the mock to reject and drives a real cross-lane drop to pin exactly that.
 */

const runId = Date.now();
const PROJECT_NAME = `Prefetch Test ${runId}`;
const WORKTREE_TASK = 'Worktree backed card';
const PLAIN_TASK = 'Plain card';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
  await createTask(page, WORKTREE_TASK);
  await createTask(page, PLAIN_TASK);
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

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

async function readPrefetchCalls(): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as unknown as { __mockPrefetchRemotesCalls?: string[] };
    return win.__mockPrefetchRemotesCalls ?? [];
  });
}

/** Start a drag on the card, hold it for a moment, then release in place. */
async function dragBriefly(taskId: string, title: string): Promise<void> {
  const card = page.locator(`[data-task-id="${taskId}"]`);
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const box = await card.boundingBox();
  if (!box) throw new Error(`Could not get bounding box for ${title}`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move past the 5px PointerSensor activation threshold to start the drag.
  await page.mouse.move(startX + 12, startY, { steps: 3 });
  await expect(page.locator('.drag-overlay').filter({ hasText: title })).toBeVisible({ timeout: 2000 });
  await page.mouse.up();
  await page.locator('.drag-overlay').filter({ hasText: title })
    .waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
}

/**
 * Drag a card into a DIFFERENT (non-Done) column and drop it there, a real
 * cross-lane move rather than dragBriefly's in-place release above. Non-Done
 * lanes get no `.drop-zone-active` indicator (that is Done-specific per
 * non-done-drop-settle.spec.ts); instead poll for `.drop-highlight`, which
 * `updateDropHighlight` in useBoardDragDrop.ts adds to the hovered swimlane's
 * root element (the same element carrying `data-swimlane-name`) on every
 * `handleDragOver`.
 */
async function dragTaskToColumn(taskId: string, title: string, targetColumnName: string): Promise<void> {
  const card = page.locator(`[data-task-id="${taskId}"]`);
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const target = page.locator(`[data-swimlane-name="${targetColumnName}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((columnName: string) => {
    document.querySelector(`[data-swimlane-name="${columnName}"]`)
      ?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumnName);

  // boundingBox() forces a layout flush - scroll geometry is accurate without a fixed wait.
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error(`Could not get bounding boxes for dragging ${title}`);

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move past the 5px PointerSensor activation threshold to start the drag.
  await page.mouse.move(startX + 12, startY, { steps: 3 });
  await expect(page.locator('.drag-overlay').filter({ hasText: title })).toBeVisible({ timeout: 2000 });

  await page.mouse.move(endX, endY, { steps: 15 });
  await expect(target).toHaveClass(/drop-highlight/, { timeout: 2000 });

  await page.mouse.up();
}

test('dragging a worktree-backed card warms the remote fetch for its worktree, a plain card does not', async () => {
  const worktreeTaskId = await getTaskIdByTitle(WORKTREE_TASK);
  const plainTaskId = await getTaskIdByTitle(PLAIN_TASK);

  // Give one card a worktree through the same call the task detail's branch
  // switch uses, then reload so the board store carries the path the drag
  // handler reads.
  const worktreePath = await page.evaluate(async (taskId) => {
    const updated = await window.electronAPI.tasks.switchBranch({ taskId, newBaseBranch: 'main', enableWorktree: true });
    const win = window as unknown as { __zustandStores: { board: { getState: () => { loadBoard: () => Promise<void> } } } };
    await win.__zustandStores.board.getState().loadBoard();
    return updated.worktree_path;
  }, worktreeTaskId);
  expect(worktreePath).toBeTruthy();

  expect(await readPrefetchCalls()).toEqual([]);

  await dragBriefly(plainTaskId, PLAIN_TASK);
  // No worktree, no probe to warm: still nothing.
  expect(await readPrefetchCalls()).toEqual([]);

  await dragBriefly(worktreeTaskId, WORKTREE_TASK);
  await expect.poll(() => readPrefetchCalls(), { timeout: 2000 }).toEqual([worktreePath]);
});

test('a rejecting prefetchRemotes does not break the drag: the drop still lands and nothing surfaces', async () => {
  // handleDragStart calls prefetchRemotes fire-and-forget with `.catch(() => {})`
  // because the comment there says the call "cannot fail the drag". Force the
  // mock to reject and drive a REAL cross-lane drop (not dragBriefly's in-place
  // release) so a missing catch would show up as either an unhandled rejection
  // or a drop that never lands.
  const worktreeTaskId = await getTaskIdByTitle(WORKTREE_TASK);
  const getPageErrors = collectPageErrors(page);
  const callsBeforeDrag = (await readPrefetchCalls()).length;

  await page.evaluate(() => {
    (window as unknown as { __mockPrefetchRemotesShouldReject?: boolean }).__mockPrefetchRemotesShouldReject = true;
  });

  await dragTaskToColumn(worktreeTaskId, WORKTREE_TASK, 'Executing');

  // The prefetch actually fired (and rejected) during this drag, so the
  // assertions below exercise the reject path rather than a no-op.
  await expect
    .poll(async () => (await readPrefetchCalls()).length, { timeout: 2000 })
    .toBeGreaterThan(callsBeforeDrag);

  // The drop still landed in the destination lane despite the rejection.
  await expect(
    page.locator('[data-swimlane-name="Executing"]').locator(`[data-task-id="${worktreeTaskId}"]`),
  ).toBeVisible({ timeout: 3000 });

  // dnd-kit's DragOverlay unmounted normally: the board is not left wedged
  // mid-drag with a stuck overlay clone.
  await expect(page.locator('.drag-overlay')).toHaveCount(0, { timeout: 3000 });

  // No unhandled rejection or uncaught exception surfaced from the fire-and-
  // forget prefetch call.
  expect(getPageErrors()).toEqual([]);

  await page.evaluate(() => {
    delete (window as unknown as { __mockPrefetchRemotesShouldReject?: boolean }).__mockPrefetchRemotesShouldReject;
  });
});
