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

  test('can delete a task', async () => {
    // "Test Task Beta" was archived above — it now lives in Done's Completed section
    const doneColumn = page.locator('[data-swimlane-name="Done"]');

    // Expand the Completed section if not already visible
    const archivedCard = doneColumn.locator('text=Test Task Beta');
    if (!(await archivedCard.isVisible().catch(() => false))) {
      await doneColumn.locator('button:has-text("Completed")').click();
      await page.waitForTimeout(300);
    }

    // Click the archived task card to open its detail dialog
    await archivedCard.click();
    await page.waitForTimeout(300);

    // Open kebab menu and click Delete (shown for archived tasks)
    await page.locator('button[title="Actions"]').click();
    await page.waitForTimeout(200);
    await page.locator('button:has-text("Delete")').click();
    await page.waitForTimeout(200);

    // Confirm deletion in the ConfirmDialog (replaces the detail dialog)
    await page.locator('text=This action cannot be undone.').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('button:has-text("Delete")').click();
    await page.waitForTimeout(500);

    // Verify the task is gone from the Completed section
    await expect(doneColumn.locator('text=Test Task Beta')).not.toBeVisible({ timeout: 3000 });
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

test.describe('Session & Column Details', () => {
  test.beforeEach(async () => {
    await ensureBoardVisible();
  });

  test('task detail dialog shows no session state', async () => {
    await taskCard('Updated Task Alpha').click();
    await page.waitForTimeout(300);

    // With no session spawned, either "No active session" or the task description is visible
    const emptyMsg = page.locator('text=No active session');
    const hasEmpty = await emptyMsg.isVisible().catch(() => false);
    expect(hasEmpty || (await page.locator('text=Description for alpha task').isVisible())).toBeTruthy();

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
