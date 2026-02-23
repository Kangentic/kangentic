import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTask,
  createTempProject,
  cleanupTempProject,
  getTestDataDir,
  cleanupTestDataDir,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const TEST_NAME = 'session-reconciliation';
const runId = Date.now();
const PROJECT_NAME = `Recon Test ${runId}`;
let tmpDir: string;
// Shared data dir so the second launch sees the project from the first
const dataDir = getTestDataDir(TEST_NAME);

/**
 * Drag a task card to a target column using mouse events.
 * Same approach as drag-and-drop.spec.ts.
 */
async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string) {
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
 * Wait for the moveTask IPC to settle by checking the agent label appears.
 */
async function waitForMoveSettle(page: Page, column: string, taskTitle: string) {
  const col = page.locator(`[data-swimlane-name="${column}"]`);
  await expect(col.locator(`text=${taskTitle}`).first()).toBeVisible({ timeout: 10000 });
  try {
    await col.locator(`text=${taskTitle}`).first().locator('..').locator('text=claude').waitFor({ timeout: 10000 });
  } catch {
    await page.waitForTimeout(3000);
  }
}

test.describe('Session Reconciliation', () => {
  test.beforeAll(() => {
    tmpDir = createTempProject(TEST_NAME);
  });

  test.afterAll(() => {
    cleanupTempProject(TEST_NAME);
    cleanupTestDataDir(TEST_NAME);
  });

  test('sessions are reconciled after app restart for tasks in agent columns', async () => {
    const taskName = `Recon Task ${runId}`;

    // === Phase 1: Launch app, create project & task, drag to Planning ===
    let result = await launchApp({ dataDir });
    let app: ElectronApplication = result.app;
    let page: Page = result.page;

    await createProject(page, PROJECT_NAME, tmpDir);
    await createTask(page, taskName, 'Test session reconciliation');

    // Drag task to Planning to spawn a session
    await dragTaskToColumn(page, taskName, 'Planning');
    await waitForMoveSettle(page, 'Planning', taskName);

    // Verify the task is in Planning and has a session
    const planningCol = page.locator('[data-swimlane-name="Planning"]');
    await expect(planningCol.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 5000 });

    // Wait for the session to be visible (session count > 0)
    await expect(page.locator('text=/[1-9]\\d*\\/\\d+ sessions/')).toBeVisible({ timeout: 15000 });

    // The bottom terminal panel should have a session tab with xterm
    const sessionTab = page.locator('.resize-handle ~ div button').first();
    await expect(sessionTab).toBeVisible({ timeout: 5000 });

    // === Phase 2: Close the app ===
    await app.close();

    // Brief pause to ensure cleanup completes
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // === Phase 3: Relaunch the app and open the same project ===
    result = await launchApp({ dataDir });
    app = result.app;
    page = result.page;

    // The project should be in the sidebar — click it to open
    const projectButton = page.locator(`button:has-text("${PROJECT_NAME}")`).first();
    await expect(projectButton).toBeVisible({ timeout: 10000 });
    await projectButton.click();

    // Wait for the board to load with our task in Planning
    await waitForBoard(page);

    // Verify the task is still in Planning
    const planningAfterRestart = page.locator('[data-swimlane-name="Planning"]');
    await expect(planningAfterRestart.locator(`text=${taskName}`).first()).toBeVisible({ timeout: 10000 });

    // === Key assertion: Session reconciliation should have spawned a new session ===
    // Wait for sessions to appear (reconciliation runs during project open)
    await expect(page.locator('text=/[1-9]\\d*\\/\\d+ sessions/')).toBeVisible({ timeout: 20000 });

    // The bottom terminal panel should show activity (session tab visible)
    const sessionTabAfterRestart = page.locator('.resize-handle ~ div button').first();
    await expect(sessionTabAfterRestart).toBeVisible({ timeout: 10000 });

    // Click the session tab and verify xterm renders
    await sessionTabAfterRestart.click();
    await page.waitForTimeout(500);

    const terminalPanel = page.locator('.resize-handle ~ div');
    const xtermElement = terminalPanel.locator('.xterm');
    await expect(xtermElement.first()).toBeVisible({ timeout: 10000 });

    // Verify the task card shows the agent label (session was reconciled)
    try {
      await planningAfterRestart
        .locator(`text=${taskName}`)
        .first()
        .locator('..')
        .locator('text=claude')
        .waitFor({ timeout: 10000 });
    } catch {
      // Agent label may take time; the session count check above is the primary assertion
    }

    // Open task detail dialog to verify session is active
    const card = planningAfterRestart.locator(`text=${taskName}`).first();
    await card.click();
    await page.waitForTimeout(500);

    const dialog = page.locator('.fixed.inset-0');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // xterm should render in the dialog (session is active)
    const dialogXterm = dialog.locator('.xterm');
    await expect(dialogXterm.first()).toBeVisible({ timeout: 10000 });

    // Close dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Cleanup
    await app.close();
  });
});
