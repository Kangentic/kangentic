import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

const runId = Date.now();
const PROJECT_NAME = `DnD Test ${runId}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME, '/tmp/dnd-test');
});

test.afterAll(async () => {
  await browser?.close();
});

async function ensureBoard() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="To Do"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`[role="button"]:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

/**
 * Drag a task card from its current column to a target column.
 * Uses mouse events to simulate @dnd-kit's PointerSensor (activation distance >= 5px).
 */
async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
  const card = page
    .locator('[data-testid="swimlane"]')
    .locator(`text=${taskTitle}`)
    .first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  // Scroll so both elements are in view
  await page.evaluate((targetCol) => {
    const targetEl = document.querySelector(`[data-swimlane-name="${targetCol}"]`);
    if (targetEl) targetEl.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);
  await page.waitForTimeout(100);

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 80;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Move enough to activate @dnd-kit's PointerSensor (distance >= 5)
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.waitForTimeout(100);

  // Move to target in steps
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.waitForTimeout(200);

  await page.mouse.up();
  await page.waitForTimeout(500);
}

/**
 * Drag a task card onto another task card within the same column.
 * Uses vertical mouse movement to trigger within-column reorder.
 */
async function dragTaskWithinColumn(sourceTitle: string, targetTitle: string) {
  const source = page
    .locator('[data-testid="swimlane"]')
    .locator(`text=${sourceTitle}`)
    .first();
  await source.waitFor({ state: 'visible', timeout: 5000 });

  const target = page
    .locator('[data-testid="swimlane"]')
    .locator(`text=${targetTitle}`)
    .first();
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Could not get bounding boxes for within-column drag');

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Move enough to activate @dnd-kit's PointerSensor (distance >= 5)
  const direction = endY > startY ? 1 : -1;
  await page.mouse.move(startX, startY + direction * 10, { steps: 3 });
  await page.waitForTimeout(100);

  // Move to target position
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.waitForTimeout(200);

  await page.mouse.up();
  await page.waitForTimeout(500);
}

test.describe('Drag and Drop', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('drag task from To Do to Planning', async () => {
    const taskName = `DnD Plan ${runId}`;
    await createTask(page, taskName, 'Test drag to Planning');

    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();

    await dragTaskToColumn(taskName, 'Planning');

    const planning = page.locator('[data-swimlane-name="Planning"]');
    await expect(
      planning.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task from To Do to Code Review', async () => {
    const taskName = `DnD Rev ${runId}`;
    await createTask(page, taskName, 'Test drag to Code Review');

    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();

    await dragTaskToColumn(taskName, 'Code Review');

    const review = page.locator('[data-swimlane-name="Code Review"]');
    await expect(
      review.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task from Planning to Code Review', async () => {
    const taskName = `DnD PtoR ${runId}`;
    await createTask(page, taskName, 'Test drag to Code Review');
    await dragTaskToColumn(taskName, 'Planning');

    const planning = page.locator('[data-swimlane-name="Planning"]');
    await expect(planning.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 5000 });

    await dragTaskToColumn(taskName, 'Code Review');
    const review = page.locator('[data-swimlane-name="Code Review"]');
    await expect(
      review.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      planning.locator(`text=${taskName}`),
    ).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task skipping columns (To Do to Code Review)', async () => {
    const taskName = `DnD Skip ${runId}`;
    await createTask(page, taskName, 'Test skip columns');

    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();

    // Drag directly from To Do to Code Review, skipping Planning
    await dragTaskToColumn(taskName, 'Code Review');
    const review = page.locator('[data-swimlane-name="Code Review"]');
    await expect(
      review.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      backlog.locator(`text=${taskName}`),
    ).not.toBeVisible({ timeout: 3000 });
  });

  test('reorder task within column (top to bottom)', async () => {
    const task1 = `DnD Reorder1 ${runId}`;
    const task2 = `DnD Reorder2 ${runId}`;
    const task3 = `DnD Reorder3 ${runId}`;
    await createTask(page, task1, 'First task');
    await createTask(page, task2, 'Second task');
    await createTask(page, task3, 'Third task');

    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await expect(backlog.locator(`text=${task1}`).first()).toBeVisible();
    await expect(backlog.locator(`text=${task3}`).first()).toBeVisible();

    // Drag task1 onto task3 (top to bottom)
    await dragTaskWithinColumn(task1, task3);

    // Verify all tasks remain in To Do (not moved to another column)
    await expect(backlog.locator(`text=${task1}`).first()).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${task2}`).first()).toBeVisible();
    await expect(backlog.locator(`text=${task3}`).first()).toBeVisible();

    // Verify order: task2 should appear above task1 after dragging task1 down
    const box1 = await backlog.locator(`text=${task1}`).first().boundingBox();
    const box2 = await backlog.locator(`text=${task2}`).first().boundingBox();
    expect(box1).toBeTruthy();
    expect(box2).toBeTruthy();
    expect(box2!.y).toBeLessThan(box1!.y);
  });

  test('reorder task within column (bottom to top)', async () => {
    const task1 = `DnD Up1 ${runId}`;
    const task2 = `DnD Up2 ${runId}`;
    const task3 = `DnD Up3 ${runId}`;
    await createTask(page, task1, 'First task');
    await createTask(page, task2, 'Second task');
    await createTask(page, task3, 'Third task');

    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await expect(backlog.locator(`text=${task3}`).first()).toBeVisible();

    // Drag task3 onto task1 (bottom to top)
    await dragTaskWithinColumn(task3, task1);

    // Verify all tasks remain in To Do
    await expect(backlog.locator(`text=${task1}`).first()).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${task2}`).first()).toBeVisible();
    await expect(backlog.locator(`text=${task3}`).first()).toBeVisible();

    // Verify order: task3 should appear above task2 after dragging task3 up
    const box3 = await backlog.locator(`text=${task3}`).first().boundingBox();
    const box2 = await backlog.locator(`text=${task2}`).first().boundingBox();
    expect(box3).toBeTruthy();
    expect(box2).toBeTruthy();
    expect(box3!.y).toBeLessThan(box2!.y);
  });
});
