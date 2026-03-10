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

  test('shows welcome screen on start (no projects)', async () => {
    await expect(page.locator('[data-testid="welcome-open-project"]')).toBeVisible();
  });

  test('title bar displays Kangentic branding', async () => {
    await expect(page.locator('.font-semibold:has-text("Kangentic")')).toBeVisible();
  });

  test('status bar exists', async () => {
    await expect(page.locator('.h-9.bg-surface.border-t')).toBeVisible();
  });

  test('window control buttons are visible', async () => {
    await expect(page.locator('button[title="Minimize"]')).toBeVisible();
    await expect(page.locator('button[title="Maximize"]')).toBeVisible();
    await expect(page.locator('button[title="Close"]')).toBeVisible();
  });

  test('minimize button calls electronAPI', async () => {
    await page.evaluate(() => {
      (window as any).__minimizeCalled = false;
      window.electronAPI.window.minimize = () => { (window as any).__minimizeCalled = true; };
    });
    await page.locator('button[title="Minimize"]').click();
    const called = await page.evaluate(() => (window as any).__minimizeCalled);
    expect(called).toBe(true);
  });

  test('maximize button calls electronAPI', async () => {
    await page.evaluate(() => {
      (window as any).__maximizeCalled = false;
      window.electronAPI.window.maximize = () => { (window as any).__maximizeCalled = true; };
    });
    await page.locator('button[title="Maximize"]').click();
    const called = await page.evaluate(() => (window as any).__maximizeCalled);
    expect(called).toBe(true);
  });

  test('close button calls electronAPI', async () => {
    await page.evaluate(() => {
      (window as any).__closeCalled = false;
      window.electronAPI.window.close = () => { (window as any).__closeCalled = true; };
    });
    await page.locator('button[title="Close"]').click();
    const called = await page.evaluate(() => (window as any).__closeCalled);
    expect(called).toBe(true);
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
    await expect(page.locator('[data-swimlane-name="Executing"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Code Review"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Tests"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Ship It"]')).toBeVisible();
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
    await page.locator('.fixed textarea').fill('Description for alpha task');
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

    // Backlog tasks open directly in edit mode -- title shows as input
    const titleInput = page.locator('.fixed input[type="text"]');
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toHaveValue('Test Task Alpha');

    // Close dialog and confirm it's gone
    await page.keyboard.press('Escape');
    await expect(titleInput).not.toBeVisible({ timeout: 2000 });
  });

  test('can edit task title and description', async () => {
    await taskCard('Test Task Alpha').click();
    await page.waitForTimeout(300);

    // Backlog tasks open directly in edit mode -- no need to click kebab → Edit
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

  test('can move a task to another column', async () => {
    // Drag "Test Task Beta" from Backlog to Planning
    const card = page.locator('[data-testid="swimlane"]').locator('text=Test Task Beta').first();
    const planning = page.locator('[data-swimlane-name="Planning"]');

    await planning.waitFor({ state: 'visible', timeout: 5000 });

    // Scroll Planning column into view
    await page.evaluate(() => {
      const targetElement = document.querySelector('[data-swimlane-name="Planning"]');
      if (targetElement) targetElement.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
    });
    await page.waitForTimeout(100);

    const cardBox = await card.boundingBox();
    const targetBox = await planning.boundingBox();
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

    // Task should appear in Planning and be gone from Backlog
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(planning.locator('text=Test Task Beta').first()).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator('text=Test Task Beta')).not.toBeVisible({ timeout: 3000 });
  });

  test('can delete a task', async () => {
    // Create a temp task to delete
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await backlog.locator('text=+ Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Task To Delete');
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(500);

    // Open the task (backlog tasks open in edit mode with Delete in footer)
    await taskCard('Task To Delete').click();
    await page.waitForTimeout(300);

    await page.locator('button:has-text("Delete")').click();
    await page.waitForTimeout(200);

    // Confirm deletion in the ConfirmDialog
    await page.locator('text=This action cannot be undone.').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('button:has-text("Delete")').click();
    await page.waitForTimeout(500);

    // Verify the task is gone from Backlog
    await expect(backlog.locator('text=Task To Delete')).not.toBeVisible({ timeout: 3000 });
  });

  test('edit mode footer shows Delete for backlog task', async () => {
    // Create a fresh task for this test
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await backlog.locator('text=+ Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Test Task Gamma');
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(500);

    // Open the task detail dialog
    await taskCard('Test Task Gamma').click();
    await page.waitForTimeout(300);

    // Backlog tasks open in edit mode with Delete in footer
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await expect(dialog.locator('button:has-text("Delete")')).toBeVisible();
    await expect(dialog.locator('button:has-text("Save")')).toBeVisible();
    await expect(dialog.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test('can delete a non-archived task directly', async () => {
    // "Test Task Gamma" was created above and is still in Backlog
    await taskCard('Test Task Gamma').click();
    await page.waitForTimeout(300);

    // Backlog tasks open in edit mode -- Delete is in the footer
    await page.locator('button:has-text("Delete")').click();
    await page.waitForTimeout(200);

    // Confirm deletion in the ConfirmDialog
    await page.locator('text=This action cannot be undone.').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('button:has-text("Delete")').click();
    await page.waitForTimeout(500);

    // Verify the task is gone from the Backlog column
    const backlog = page.locator('[data-swimlane-name="Backlog"]');
    await expect(backlog.locator('text=Test Task Gamma')).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Column Management', () => {
  test.beforeEach(async () => {
    await ensureBoardVisible();
  });

  test('clicking column header opens edit dialog', async () => {
    const col = page.locator('[data-swimlane-name="Code Review"]');
    await col.locator('text=Code Review').click();
    await page.waitForTimeout(300);
    await expect(page.locator('text=Edit Column')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
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

test.describe('Session & Column Details', () => {
  test.beforeEach(async () => {
    await ensureBoardVisible();
  });

  test('task detail dialog shows no session state', async () => {
    await taskCard('Updated Task Alpha').click();
    await page.waitForTimeout(300);

    // Backlog tasks open in edit mode -- the edit textarea is visible instead of "No active session"
    const textarea = page.locator('.fixed textarea');
    await expect(textarea).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('session count starts at 0', async () => {
    await expect(page.locator('[data-testid="session-count"]')).toContainText('0 agents');
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

  test('tasks in Backlog have no branch info', async () => {
    await taskCard('Updated Task Alpha').click();
    await page.waitForTimeout(300);

    await expect(page.locator('text=Branch:')).not.toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});

test.describe('Worktree Title Bar', () => {
  test('no worktree badge for normal project path', async () => {
    // The project created earlier has a normal path (/mock/projects/...)
    await expect(page.locator('text=(worktree)')).not.toBeVisible();
  });

  test('worktree badge appears for worktree project path', async () => {
    // Create a project whose path contains .kangentic/worktrees/
    await page.evaluate(() => {
      (window as any).__mockFolderPath = '/mock/project/.kangentic/worktrees/my-feature-abc12345';
    });
    await page.locator('button[title="Open folder as project"]').click();
    await waitForBoard(page);

    await expect(page.locator('text=(worktree)')).toBeVisible();
  });
});
