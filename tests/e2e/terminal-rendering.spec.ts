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

const TEST_NAME = 'terminal-rendering';
const runId = Date.now();
const PROJECT_NAME = `Term Test ${runId}`;
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

async function ensureBoard() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

/**
 * Drag a task card to a target column using mouse events.
 * Same approach as drag-and-drop.spec.ts.
 */
async function dragTaskToColumn(taskTitle: string, targetColumn: string) {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

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
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await page.waitForTimeout(100);
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/**
 * Wait for the moveTask IPC to complete (agent label or timeout).
 */
async function waitForMoveSettle(column: string, taskTitle: string) {
  const col = page.locator(`[data-swimlane-name="${column}"]`);
  await expect(col.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 10000 });
  try {
    await col.locator(`text=${taskTitle}`).first().locator('..').locator('text=claude').waitFor({ timeout: 10000 });
  } catch {
    await page.waitForTimeout(3000);
  }
}

test.describe('Terminal Rendering', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('bottom terminal panel shows xterm after session spawn', async () => {
    const taskName = `Term Panel ${runId}`;
    await createTask(page, taskName, 'Test terminal in bottom panel');

    // Drag to Planning to spawn a session
    await dragTaskToColumn(taskName, 'Planning');
    await waitForMoveSettle('Planning', taskName);

    // The bottom terminal panel should now have a session tab
    const sessionTab = page.locator('.resize-handle ~ div button').first();
    await expect(sessionTab).toBeVisible({ timeout: 5000 });

    // Click the session tab to ensure it's active
    await sessionTab.click();
    await page.waitForTimeout(500);

    // xterm should have rendered: look for the .xterm container in the bottom panel
    const terminalPanel = page.locator('.resize-handle ~ div');
    const xtermElement = terminalPanel.locator('.xterm');
    await expect(xtermElement.first()).toBeVisible({ timeout: 5000 });

    // xterm screen canvas should exist and have real dimensions
    const xtermScreen = terminalPanel.locator('.xterm-screen');
    await expect(xtermScreen.first()).toBeVisible({ timeout: 3000 });
    const screenBox = await xtermScreen.first().boundingBox();
    expect(screenBox).toBeTruthy();
    expect(screenBox!.width).toBeGreaterThan(50);
    expect(screenBox!.height).toBeGreaterThan(20);
  });

  test('task detail dialog shows xterm terminal', async () => {
    const taskName = `Term Dialog ${runId}`;
    await createTask(page, taskName, 'Test terminal in dialog');

    // Drag to Planning to spawn a session
    await dragTaskToColumn(taskName, 'Planning');
    await waitForMoveSettle('Planning', taskName);

    // Open the task detail dialog by clicking the card
    const card = page.locator('[data-swimlane-name="Planning"]').locator(`text=${taskName}`).first();
    await card.click();
    await page.waitForTimeout(500);

    // Dialog should be visible with session info
    const dialog = page.locator('.fixed.inset-0');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog.locator('text=claude')).toBeVisible({ timeout: 3000 });

    // xterm should render inside the dialog
    const dialogXterm = dialog.locator('.xterm');
    await expect(dialogXterm.first()).toBeVisible({ timeout: 5000 });

    // xterm screen should have real dimensions (not collapsed)
    const xtermScreen = dialog.locator('.xterm-screen');
    await expect(xtermScreen.first()).toBeVisible({ timeout: 3000 });
    const screenBox = await xtermScreen.first().boundingBox();
    expect(screenBox).toBeTruthy();
    expect(screenBox!.width).toBeGreaterThan(100);
    expect(screenBox!.height).toBeGreaterThan(50);

    // Close dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('terminal shows shell output (scrollback)', async () => {
    const taskName = `Term Output ${runId}`;
    await createTask(page, taskName, 'Test terminal shows output');

    // Drag to Planning to spawn a session
    await dragTaskToColumn(taskName, 'Planning');
    await waitForMoveSettle('Planning', taskName);

    // Open task detail dialog
    const card = page.locator('[data-swimlane-name="Planning"]').locator(`text=${taskName}`).first();
    await card.click();
    await page.waitForTimeout(1000);

    // The xterm terminal should render inside the dialog
    const dialog = page.locator('.fixed.inset-0');
    const xtermContainer = dialog.locator('.xterm');
    await expect(xtermContainer.first()).toBeVisible({ timeout: 5000 });

    // xterm v6 uses WebGL canvases for rendering, so we check that the terminal
    // has canvas elements with real pixel content (width/height > 0)
    const hasCanvasContent = await dialog.locator('.xterm canvas').first().evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      return canvas.width > 0 && canvas.height > 0;
    });
    expect(hasCanvasContent).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});
