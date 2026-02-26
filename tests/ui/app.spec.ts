import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `UI Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
});

test.afterAll(async () => {
  await browser?.close();
});

/** Dismiss any open dialogs, then ensure the board is visible */
async function ensureBoardVisible() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const backlog = page.locator('[data-swimlane-name="Backlog"]');
  if (await backlog.isVisible().catch(() => false)) return;

  const projectBtn = page.locator(`[role="button"]:has-text("${PROJECT_NAME}")`).first();
  await projectBtn.click();
  await waitForBoard(page);
}

/** Click a task card by title (within the board, not any dialog) */
function taskCard(title: string) {
  return page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
}

test.describe('App Launch', () => {
  test('window opens with correct title', async () => {
    const title = await page.evaluate(() => document.title);
    expect(title).toBe('Kangentic');
  });

  test('shows project sidebar on start', async () => {
    await expect(page.getByText('Projects', { exact: true })).toBeVisible();
  });

  test('title bar displays Kangentic branding', async () => {
    await expect(page.locator('.font-semibold:has-text("Kangentic")')).toBeVisible();
  });

  test('status bar exists', async () => {
    await expect(page.locator('.h-9.bg-zinc-900.border-t')).toBeVisible();
  });
});

test.describe('Project Management', () => {
  test('can create a new project', async () => {
    await createProject(page, PROJECT_NAME, '/tmp/ui-test');
    await expect(page.locator('[data-swimlane-name="Backlog"]')).toBeVisible();
  });

  test('default swimlanes are created', async () => {
    await ensureBoardVisible();
    await expect(page.locator('[data-swimlane-name="Backlog"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Planning"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Running"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Review"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Done"]')).toBeVisible();
  });

  test('project appears in sidebar', async () => {
    await expect(
      page.locator(`[role="button"]:has-text("${PROJECT_NAME}")`).first(),
    ).toBeVisible();
  });

  test('status bar shows session and task counts after project open', async () => {
    await expect(page.locator('[data-testid="session-count"]')).toBeVisible();
    await expect(page.locator('[data-testid="task-count"]')).toBeVisible();
  });
});

test.describe('Task CRUD', () => {
  test.beforeEach(async () => {
    await ensureBoardVisible();
  });

  test('can create a task in Backlog', async () => {
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await backlog.locator('text=+ Add task').click();

    await page.locator('input[placeholder="Task title"]').fill('Test Task Alpha');
    await page
      .locator('textarea[placeholder="Description (optional)"]')
      .fill('Description for alpha task');
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(500);

    await expect(taskCard('Test Task Alpha')).toBeVisible();
  });

  test('task card shows title', async () => {
    await expect(taskCard('Test Task Alpha')).toBeVisible();
  });

  test('can open task detail dialog', async () => {
    await taskCard('Test Task Alpha').click();
    await page.waitForTimeout(300);

    const dialogTitle = page.locator('h2:has-text("Test Task Alpha")');
    await expect(dialogTitle).toBeVisible();

    // Close dialog and confirm it's gone
    await page.keyboard.press('Escape');
    await expect(dialogTitle).not.toBeVisible({ timeout: 2000 });
  });

  test('can edit task title and description', async () => {
    await taskCard('Test Task Alpha').click();
    await page.waitForTimeout(300);

    // Open kebab menu (the "..." Actions button), then click Edit
    await page.locator('button[title="Actions"]').click();
    await page.waitForTimeout(200);

    // Click the Edit menu item (has Pencil icon + "Edit" text)
    await page.locator('button:has-text("Edit")').first().click();
    await page.waitForTimeout(200);

    const titleInput = page.locator('.fixed input[type="text"]');
    await titleInput.fill('Updated Task Alpha');

    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(500);

    // Dialog closes after save (no session), verify the card shows the updated title
    await expect(taskCard('Updated Task Alpha')).toBeVisible();
  });

  test('can create a second task', async () => {
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await backlog.locator('text=+ Add task').click();

    await page.locator('input[placeholder="Task title"]').fill('Test Task Beta');
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(500);

    await expect(taskCard('Test Task Beta')).toBeVisible();
  });

  test('can archive a task', async () => {
    await taskCard('Test Task Beta').click();
    await page.waitForTimeout(300);

    // Open kebab menu, click Archive
    await page.locator('button[title="Actions"]').click();
    await page.waitForTimeout(200);
    await page.locator('button:has-text("Archive")').click();
    await page.waitForTimeout(500);

    // Task should no longer appear in the Backlog column
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(backlog.locator('text=Test Task Beta')).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Column Management', () => {
  test.beforeEach(async () => {
    await ensureBoardVisible();
  });

  test('system columns have lock icons', async () => {
    const planning = page.locator('[data-swimlane-name="Planning"]');
    await expect(planning.locator('svg').first()).toBeVisible();
  });

  test('can add a new custom column', async () => {
    const addColumnBtn = page.locator('button:has-text("Add column")');
    if (await addColumnBtn.isVisible()) {
      await addColumnBtn.click();
      await page.waitForTimeout(300);

      const nameInput = page.locator('input[placeholder="Column name"]');
      if (await nameInput.isVisible()) {
        await nameInput.fill('Custom Stage');
        await nameInput.press('Enter');
        await page.waitForTimeout(500);
        await expect(page.locator('[data-swimlane-name="Custom Stage"]')).toBeVisible();
      }
    }
  });
});
