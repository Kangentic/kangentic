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
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
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
    await expect(
      planning.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task from Backlog to Running', async () => {
    const taskName = `DnD Run ${runId}`;
    await createTask(page, taskName, 'Test drag to Running');

    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();

    await dragTaskToColumn(taskName, 'Running');

    const running = page.locator('[data-swimlane-name="Running"]');
    await expect(
      running.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator(`text=${taskName}`)).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task from Planning to Running (adjacent)', async () => {
    const taskName = `DnD PtoR ${runId}`;
    await createTask(page, taskName, 'Test drag adjacent', 'Planning');

    const planning = page.locator('[data-swimlane-name="Planning"]');
    await expect(planning.locator(`text=${taskName}`).first()).toBeVisible();

    await dragTaskToColumn(taskName, 'Running');
    const running = page.locator('[data-swimlane-name="Running"]');
    await expect(
      running.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      planning.locator(`text=${taskName}`),
    ).not.toBeVisible({ timeout: 3000 });
  });

  test('drag task skipping columns (Backlog to Review)', async () => {
    const taskName = `DnD Skip ${runId}`;
    await createTask(page, taskName, 'Test skip columns');

    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(backlog.locator(`text=${taskName}`).first()).toBeVisible();

    // Drag directly from Backlog to Review, skipping Planning and Running
    await dragTaskToColumn(taskName, 'Review');
    const review = page.locator('[data-swimlane-name="Review"]');
    await expect(
      review.locator(`text=${taskName}`).first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      backlog.locator(`text=${taskName}`),
    ).not.toBeVisible({ timeout: 3000 });
  });
});
