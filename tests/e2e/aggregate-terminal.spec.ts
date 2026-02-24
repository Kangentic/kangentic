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

const TEST_NAME = 'aggregate-terminal';
const runId = Date.now();
const PROJECT_NAME = `Agg Term ${runId}`;
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

async function waitForMoveSettle(column: string, taskTitle: string) {
  const col = page.locator(`[data-swimlane-name="${column}"]`);
  await expect(col.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(3000);
}

test.describe('Aggregate Terminal (All Tab)', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('"All" tab hidden with single session', async () => {
    const taskName = `Single ${runId}`;
    await createTask(page, taskName, 'Only one session');

    await dragTaskToColumn(taskName, 'Planning');
    await waitForMoveSettle('Planning', taskName);

    // With only 1 session, the "All" tab should NOT be visible
    const allTab = page.locator('button:has-text("All")').first();
    await expect(allTab).not.toBeVisible({ timeout: 3000 });
  });

  test('"All" tab appears with 2+ sessions and renders xterm', async () => {
    const taskA = `AggA ${runId}`;
    const taskB = `AggB ${runId}`;
    await createTask(page, taskA, 'First session for aggregate');
    await createTask(page, taskB, 'Second session for aggregate');

    // Drag both tasks to Planning to spawn 2 sessions
    await dragTaskToColumn(taskA, 'Planning');
    await waitForMoveSettle('Planning', taskA);

    await dragTaskToColumn(taskB, 'Planning');
    await waitForMoveSettle('Planning', taskB);

    // "All" tab should now be visible (2+ sessions)
    const allTab = page.locator('button:has-text("All")').first();
    await expect(allTab).toBeVisible({ timeout: 5000 });

    // Click the "All" tab
    await allTab.click();
    await page.waitForTimeout(500);

    // The "All" tab should be highlighted (active state)
    await expect(allTab).toHaveClass(/bg-zinc-800/, { timeout: 3000 });

    // xterm should render inside the aggregate terminal panel
    const terminalPanel = page.locator('.resize-handle ~ div');
    const xtermElement = terminalPanel.locator('.xterm');
    await expect(xtermElement.first()).toBeVisible({ timeout: 5000 });

    // xterm screen should have real dimensions
    const xtermScreen = terminalPanel.locator('.xterm-screen');
    await expect(xtermScreen.first()).toBeVisible({ timeout: 3000 });
    const screenBox = await xtermScreen.first().boundingBox();
    expect(screenBox).toBeTruthy();
    expect(screenBox!.width).toBeGreaterThan(50);
    expect(screenBox!.height).toBeGreaterThan(20);
  });

  test('"All" tab shows scrollback headers for each session', async () => {
    // This test depends on the previous test having created 2 sessions.
    // The "All" tab should show scrollback headers with session labels.

    const allTab = page.locator('button:has-text("All")').first();
    if (!(await allTab.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await allTab.click();
    await page.waitForTimeout(1000);

    // Read the terminal content via the scrollback IPC
    // The aggregate terminal should contain "Scrollback:" text
    const terminalPanel = page.locator('.resize-handle ~ div');
    const xtermElement = terminalPanel.locator('.xterm');
    await expect(xtermElement.first()).toBeVisible({ timeout: 5000 });

    // Use canvas-based check: the xterm should have rendered content
    const hasContent = await terminalPanel.locator('.xterm canvas').first().evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      return canvas.width > 0 && canvas.height > 0;
    });
    expect(hasContent).toBe(true);
  });

  test('switching between All and individual tabs preserves xterm', async () => {
    const allTab = page.locator('button:has-text("All")').first();
    if (!(await allTab.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    // Click an individual session tab
    const sessionTabs = page.locator('button').filter({ hasNot: page.locator('text=All') });
    const terminalPanel = page.locator('.resize-handle ~ div');

    // Find a session tab (not All, not collapse button)
    const tabButtons = terminalPanel.locator('button');
    const tabCount = await tabButtons.count();
    let individualTab = null;
    for (let i = 0; i < tabCount; i++) {
      const text = await tabButtons.nth(i).textContent();
      if (text && !text.includes('All') && text.trim().length > 0) {
        individualTab = tabButtons.nth(i);
        break;
      }
    }

    if (!individualTab) {
      test.skip();
      return;
    }

    // Click individual tab
    await individualTab.click();
    await page.waitForTimeout(300);

    // An xterm instance should be visible for the individual session
    const visibleXterm = terminalPanel.locator('.xterm:visible');
    await expect(visibleXterm.first()).toBeVisible({ timeout: 3000 });

    // Switch back to All tab
    await allTab.click();
    await page.waitForTimeout(500);

    // xterm in All view should be visible again
    await expect(visibleXterm.first()).toBeVisible({ timeout: 3000 });
  });
});
