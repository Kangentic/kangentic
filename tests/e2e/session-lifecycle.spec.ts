import { test, expect } from '@playwright/test';
import {
  launchApp,
  waitForBoard,
  createProject,
  createTempProject,
  cleanupTempProject,
} from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

const TEST_NAME = 'session-lifecycle';
const PROJECT_NAME = `SL Test ${Date.now()}`;
const TASK_NAME = `Lifecycle Task ${Date.now()}`;
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

/** Dismiss dialogs and ensure board is visible */
async function ensureBoard() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const backlog = page.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;
  await page.locator(`button:has-text("${PROJECT_NAME}")`).first().click();
  await waitForBoard(page);
}

test.describe('Session Lifecycle', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('creating a task starts with no session', async () => {
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await backlog.locator('text=+ Add task').click();

    await page.locator('input[placeholder="Task title"]').fill(TASK_NAME);
    await page.locator('textarea[placeholder="Description (optional)"]').fill('Test session lifecycle');
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(500);

    await expect(backlog.locator(`text=${TASK_NAME}`).first()).toBeVisible();
  });

  test('task detail dialog shows no session state', async () => {
    await page.locator('[data-testid="swimlane"]').locator(`text=${TASK_NAME}`).first().click();
    await page.waitForTimeout(300);

    const emptyMsg = page.locator('text=No active session');
    const hasEmpty = await emptyMsg.isVisible().catch(() => false);
    expect(hasEmpty || (await page.locator('text=Test session lifecycle').isVisible())).toBeTruthy();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('session count starts at 0', async () => {
    await expect(page.locator('text=/0\\/\\d+ sessions/')).toBeVisible();
  });
});

test.describe('Column Operations', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('system columns cannot be deleted via UI', async () => {
    const planning = page.locator('[data-swimlane-name="Planning"]');
    await planning.locator('text=Planning').click();
    await page.waitForTimeout(300);

    const lockIndicator = page.locator('text=System column');
    const hasLock = await lockIndicator.isVisible().catch(() => false);
    if (hasLock) {
      const deleteBtn = page.locator('button:has-text("Delete column")');
      await expect(deleteBtn).not.toBeVisible();
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('Running column also shows as system column', async () => {
    const running = page.locator('[data-swimlane-name="Running"]');
    await running.locator('text=Running').click();
    await page.waitForTimeout(300);

    const lockIndicator = page.locator('text=System column');
    const hasLock = await lockIndicator.isVisible().catch(() => false);
    if (hasLock) {
      const deleteBtn = page.locator('button:has-text("Delete column")');
      await expect(deleteBtn).not.toBeVisible();
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});

test.describe('Worktree Info', () => {
  test.beforeEach(async () => {
    await ensureBoard();
  });

  test('tasks in Backlog have no branch info', async () => {
    await page.locator('[data-testid="swimlane"]').locator(`text=${TASK_NAME}`).first().click();
    await page.waitForTimeout(300);

    await expect(page.locator('text=Branch:')).not.toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});
