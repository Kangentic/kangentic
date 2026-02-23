import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const TEST_NAME = 'drag-and-drop';
const runId = Date.now();
const PROJECT_NAME = `DnD Test ${runId}`;
let app: ElectronApplication;
let page: Page;
let tmpDir: string;

test.beforeAll(async () => {
  tmpDir = createTempProject(TEST_NAME);
  const result = await launchApp();
  app = result.app;
  page = result.page;
  await createProject(page, PROJECT_NAME, tmpDir);
});

test.afterAll(async () => {
  await app?.close();
  cleanupTempProject(TEST_NAME);
});

/** Dismiss any open dialogs, then ensure the board is visible */
async function ensureBoard() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

/**
 * Wait for the moveTask IPC to settle by checking the agent label appears
 * (transitions spawn Claude agents which update the task). Falls back to a
 * timeout if no agent label appears.
 */
async function waitForMoveSettle(page: Page, column: string, taskTitle: string) {
  const col = page.locator(`[data-swimlane-name="${column}"]`);
  // Wait for the card to be visible in the target column
  await expect(col.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 10000 });
  // Wait for the transition/IPC to complete — the agent label is a reliable indicator.
  // Claude CLI detection + PTY spawn can be slow (especially on Windows), so use a
  // generous timeout. The fallback covers transitions that don't spawn agents.
  try {
    await col.locator(`text=${taskTitle}`).first().locator('..').locator('text=claude').waitFor({ timeout: 10000 });
  } catch {
    // Agent may not appear if transition doesn't spawn one; wait for IPC to finish
    await page.waitForTimeout(3000);
  }
}

/**
 * Drag a task card from its current column to a target column.
 * Uses mouse events to simulate @dnd-kit's PointerSensor (activation distance >= 5px).
 */
async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  // Scroll the board container so both source card and target column are in view
  await page.evaluate((targetCol) => {
    const targetEl = document.querySelector(`[data-swimlane-name="${targetCol}"]`);
    if (targetEl) targetEl.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);
  await page.waitForTimeout(100);

  // Get bounding boxes
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  // Drop in the task area of the target column (below the ~44px header + accent bar)
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  // Perform the drag with mouse events
  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Move enough to activate @dnd-kit's PointerSensor (distance >= 5)
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.waitForTimeout(100);

  // Move to target in steps for smooth drag
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.waitForTimeout(200);

  // Release
  await page.mouse.up();
  await page.waitForTimeout(500);
}

test.describe('Drag and Drop', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('drag task from Backlog to Planning', async () => {
    const taskName = `DnD Plan ${runId}`;
    await createTask(page, taskName, 'Test drag to Planning');

    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();

    await dragTaskToColumn(taskName, 'Planning');

    const planning = page.locator('[data-swimlane-name="Planning"]');
    await expect(planning.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task from Backlog to Running', async () => {
    const taskName = `DnD Run ${runId}`;
    await createTask(page, taskName, 'Test drag to Running');

    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();

    await dragTaskToColumn(taskName, 'Running');

    const running = page.locator('[data-swimlane-name="Running"]');
    await expect(running.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task from Planning to Running (adjacent)', async () => {
    const taskName = `DnD PtoR ${runId}`;
    // Create directly in Planning to avoid race conditions from consecutive drags
    await createTask(page, taskName, 'Test drag adjacent', 'Planning');

    const planning = page.locator('[data-swimlane-name="Planning"]');
    await expect(planning.locator(`text=${taskName}`).first()).toBeVisible();

    await dragTaskToColumn(taskName, 'Running');
    const running = page.locator('[data-swimlane-name="Running"]');
    await expect(running.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 5000 });
    await expect(planning.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task across multiple columns', async () => {
    const taskName = `DnD Multi ${runId}`;
    await createTask(page, taskName, 'Test multi drag');

    // Backlog → Review (skip Planning and Running, no transitions for this path)
    await dragTaskToColumn(taskName, 'Review');
    const review = page.locator('[data-swimlane-name="Review"]');
    await expect(review.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 5000 });

    // Review → Done (no session to wait for, just kill_session which is no-op)
    await page.waitForTimeout(1000);
    await dragTaskToColumn(taskName, 'Done');
    const done = page.locator('[data-swimlane-name="Done"]');
    await expect(done.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 5000 });
    await expect(review.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });
});
