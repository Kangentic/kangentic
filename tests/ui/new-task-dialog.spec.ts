import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `NewTaskDialog Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Open the New Task dialog in the To Do column */
async function openNewTaskDialog() {
  const column = page.locator('[data-swimlane-name="To Do"]');
  const addButton = column.locator('text=Add task');
  await addButton.click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

/** Close dialog by pressing Escape */
async function closeDialog() {
  await page.keyboard.press('Escape');
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
}

test.describe('BranchPicker', () => {
  test('chip renders with default branch name', async () => {
    await openNewTaskDialog();

    const chip = page.locator('[data-testid="branch-picker-chip"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('main');

    await closeDialog();
  });

  test('clicking chip opens dropdown with branch list', async () => {
    await openNewTaskDialog();

    const chip = page.locator('[data-testid="branch-picker-chip"]');
    await chip.click();

    // Wait for the dropdown to appear with the search input
    const searchInput = page.locator('input[placeholder="Search branches..."]');
    await expect(searchInput).toBeVisible();

    // Verify branches from mock are listed
    await expect(page.locator('button:has-text("develop")')).toBeVisible();
    await expect(page.locator('button:has-text("feature/auth")')).toBeVisible();

    // Close dropdown first (Escape closes dropdown, not dialog)
    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeVisible();

    await closeDialog();
  });

  test('selecting a branch closes dropdown and updates chip', async () => {
    await openNewTaskDialog();

    const chip = page.locator('[data-testid="branch-picker-chip"]');
    await chip.click();

    // Wait for branches to load
    const developBtn = page.locator('button:has-text("develop")');
    await developBtn.waitFor({ state: 'visible' });
    await developBtn.click();

    // Dropdown should close
    await expect(page.locator('input[placeholder="Search branches..."]')).not.toBeVisible();

    // Chip should now show the selected branch
    await expect(chip).toContainText('develop');

    await closeDialog();
  });

  test('Escape closes dropdown without closing parent dialog', async () => {
    await openNewTaskDialog();

    const chip = page.locator('[data-testid="branch-picker-chip"]');
    await chip.click();

    // Dropdown is open
    await expect(page.locator('input[placeholder="Search branches..."]')).toBeVisible();

    // Press Escape -- should close dropdown only
    await page.keyboard.press('Escape');
    await expect(page.locator('input[placeholder="Search branches..."]')).not.toBeVisible();

    // Parent dialog should still be open
    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

    await closeDialog();
  });
});

test.describe('Worktree Toggle', () => {
  test('toggle is visible in New Task dialog', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="worktree-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Worktree');

    await closeDialog();
  });

  test('toggle defaults to enabled when global worktrees setting is ON', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="worktree-toggle"]');
    // Default config has worktreesEnabled: true -- chip should NOT have line-through
    const span = toggle.locator('span');
    await expect(span).not.toHaveClass(/line-through/);

    await closeDialog();
  });

  test('clicking toggle switches to disabled state', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="worktree-toggle"]');
    await toggle.click();

    // After toggling off, the span should have line-through styling
    const span = toggle.locator('span');
    await expect(span).toHaveClass(/line-through/);

    await closeDialog();
  });

  test('clicking toggle twice returns to enabled state', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="worktree-toggle"]');
    // Toggle off
    await toggle.click();
    const span = toggle.locator('span');
    await expect(span).toHaveClass(/line-through/);

    // Toggle back on
    await toggle.click();
    await expect(span).not.toHaveClass(/line-through/);

    await closeDialog();
  });

  test('created task receives use_worktree: 0 when toggled off', async () => {
    await openNewTaskDialog();

    // Fill in title
    await page.locator('input[placeholder="Task title"]').fill('Worktree Off Task');

    // Toggle worktree off
    const toggle = page.locator('[data-testid="worktree-toggle"]');
    await toggle.click();

    // Create the task
    await page.locator('button:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Verify the task was created with use_worktree = 0
    const taskData = await page.evaluate(() => {
      return window.electronAPI.tasks.list();
    });
    const task = taskData.find((t: { title: string }) => t.title === 'Worktree Off Task');
    expect(task).toBeDefined();
    expect(task.use_worktree).toBe(0);
  });

  test('created task has use_worktree: null when not toggled', async () => {
    await openNewTaskDialog();

    // Fill in title without touching the toggle
    await page.locator('input[placeholder="Task title"]').fill('Default Worktree Task');

    // Create the task
    await page.locator('button:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Verify the task was created with use_worktree = null (follows global)
    const taskData = await page.evaluate(() => {
      return window.electronAPI.tasks.list();
    });
    const task = taskData.find((t: { title: string }) => t.title === 'Default Worktree Task');
    expect(task).toBeDefined();
    expect(task.use_worktree).toBeNull();
  });

  test('task detail edit mode shows toggle for pre-session task', async () => {
    // Create a task first
    await createTask(page, 'Detail Toggle Task');

    // Click on the task card to open detail dialog
    // To Do tasks open directly in edit mode
    const taskCard = page.locator('text=Detail Toggle Task').first();
    await taskCard.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Worktree toggle should be visible in edit mode (no session = pre-session)
    const toggle = page.locator('[data-testid="worktree-toggle"]');
    await expect(toggle).toBeVisible();

    // Close by pressing Escape
    await page.keyboard.press('Escape');
  });
});

test.describe('To Do Edit Branch Config', () => {
  test('backlog edit shows full branch config UI', async () => {
    await createTask(page, 'Branch Config Task');

    // To Do tasks open directly in edit mode
    const taskCard = page.locator('[data-testid="swimlane"]').locator('text=Branch Config Task').first();
    await taskCard.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Custom branch name input should be visible
    const branchInput = page.locator('[data-testid="custom-branch-name-input"]');
    await expect(branchInput).toBeVisible();

    // BranchPicker chip should be visible
    const branchChip = page.locator('[data-testid="branch-picker-chip"]');
    await expect(branchChip).toBeVisible();

    // WorktreeChip should be visible
    const worktreeToggle = page.locator('[data-testid="worktree-toggle"]');
    await expect(worktreeToggle).toBeVisible();

    // Branch hint text should be visible
    const branchHint = page.locator('text=Auto-generated branch will be created from');
    await expect(branchHint).toBeVisible();

    await page.keyboard.press('Escape');
  });

  test('custom branch name is saved to task', async () => {
    await createTask(page, 'Custom Branch Save Task');

    const taskCard = page.locator('[data-testid="swimlane"]').locator('text=Custom Branch Save Task').first();
    await taskCard.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Type a custom branch name
    const branchInput = page.locator('[data-testid="custom-branch-name-input"]');
    await branchInput.fill('feature/my-custom-branch');

    // Save
    await page.locator('button:has-text("Save")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Verify branch_name was saved
    const taskData = await page.evaluate(() => {
      return window.electronAPI.tasks.list();
    });
    const task = taskData.find((t: { title: string }) => t.title === 'Custom Branch Save Task');
    expect(task).toBeDefined();
    expect(task.branch_name).toBe('feature/my-custom-branch');
  });

  test('invalid branch name shows error and disables Save', async () => {
    await createTask(page, 'Invalid Branch Task');

    const taskCard = page.locator('[data-testid="swimlane"]').locator('text=Invalid Branch Task').first();
    await taskCard.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Type an invalid branch name (leading dots)
    const branchInput = page.locator('[data-testid="custom-branch-name-input"]');
    await branchInput.fill('..bad-branch');

    // Error message should appear
    await expect(page.locator('text=Invalid git branch name')).toBeVisible();

    // Save button should be disabled
    const saveButton = page.locator('button:has-text("Save")');
    await expect(saveButton).toBeDisabled();

    await page.keyboard.press('Escape');
  });

  test('cancel resets custom branch name', async () => {
    await createTask(page, 'Cancel Branch Task');

    const taskCard = page.locator('[data-testid="swimlane"]').locator('text=Cancel Branch Task').first();
    await taskCard.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Type a custom branch name
    const branchInput = page.locator('[data-testid="custom-branch-name-input"]');
    await branchInput.fill('feature/will-be-cancelled');

    // Cancel
    await page.locator('button:has-text("Cancel")').click();

    // Re-open the task
    await taskCard.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // Branch input should be empty (reset to original null value)
    const branchInputAgain = page.locator('[data-testid="custom-branch-name-input"]');
    await expect(branchInputAgain).toHaveValue('');

    await page.keyboard.press('Escape');
  });

  test('non-backlog task edit hides custom branch input', async () => {
    await createTask(page, 'Planning Branch Task');

    // Move the task to Planning via mock API and reload the board store
    await page.evaluate(async () => {
      const api = (window as any).electronAPI;
      const stores = (window as any).__zustandStores;
      const tasks = await api.tasks.list();
      const task = tasks.find((t: { title: string }) => t.title === 'Planning Branch Task');
      const swimlanes = await api.swimlanes.list();
      const planning = swimlanes.find((s: { name: string }) => s.name === 'Planning');
      if (task && planning) {
        await api.tasks.move({
          taskId: task.id,
          targetSwimlaneId: planning.id,
          targetPosition: 0,
        });
        await stores.board.getState().loadBoard();
      }
    });

    // Wait for the task to appear in Planning
    const taskCard = page.locator('[data-swimlane-name="Planning"]').locator('text=Planning Branch Task').first();
    await expect(taskCard).toBeVisible({ timeout: 5000 });

    // Open the task in Planning (non-backlog tasks without sessions open in edit mode)
    await taskCard.click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    // Custom branch name input should NOT be visible (non-backlog task)
    const branchInput = page.locator('[data-testid="custom-branch-name-input"]');
    await expect(branchInput).not.toBeVisible();

    // But BranchPicker should still be visible (simple chip mode for non-backlog)
    const branchChip = page.locator('[data-testid="branch-picker-chip"]');
    await expect(branchChip).toBeVisible();

    await page.keyboard.press('Escape');
  });
});
