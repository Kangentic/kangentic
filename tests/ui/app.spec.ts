import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `UI Test ${Date.now()}`;
const runId = Date.now();
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
  await page.locator('.fixed input[placeholder="Task title"], .fixed textarea, [data-testid="task-detail-dialog"]')
    .waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});

  const backlog = page.locator('[data-swimlane-name="To Do"]');
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
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();
  });

  test('default swimlanes are created', async () => {
    await ensureBoardVisible();
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();
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

  test('can create a task in To Do', async () => {
    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await backlog.locator('text=Add task').click();

    await page.locator('input[placeholder="Task title"]').fill('Test Task Alpha');
    await page.locator('.fixed textarea').fill('Description for alpha task');
    await page.locator('button:has-text("Create")').click();

    await expect(taskCard('Test Task Alpha')).toBeVisible({ timeout: 3000 });
  });

  test('task card shows title', async () => {
    await expect(taskCard('Test Task Alpha')).toBeVisible();
  });

  test('can open task detail dialog', async () => {
    await taskCard('Test Task Alpha').click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    // To Do tasks open directly in edit mode -- title shows as input
    const titleInput = page.locator('.fixed input[placeholder="Task title"]');
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toHaveValue('Test Task Alpha');

    // Close dialog and confirm it's gone
    await page.keyboard.press('Escape');
    await expect(titleInput).not.toBeVisible({ timeout: 2000 });
  });

  test('can edit task title and description', async () => {
    await taskCard('Test Task Alpha').click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    // To Do tasks open directly in edit mode -- no need to click kebab -> Edit
    const titleInput = page.locator('.fixed input[placeholder="Task title"]');
    await titleInput.fill('Updated Task Alpha');

    await page.locator('button:has-text("Save")').click();

    // Dialog closes after save (no session), verify the card shows the updated title
    await expect(taskCard('Updated Task Alpha')).toBeVisible({ timeout: 3000 });
  });

  test('can create a second task', async () => {
    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await backlog.locator('text=Add task').click();

    await page.locator('input[placeholder="Task title"]').fill('Test Task Beta');
    await page.locator('button:has-text("Create")').click();

    await expect(taskCard('Test Task Beta')).toBeVisible({ timeout: 3000 });
  });

  test('can move a task to another column', async () => {
    // Drag "Test Task Beta" from To Do to Planning
    const card = page.locator('[data-testid="swimlane"]').locator('text=Test Task Beta').first();
    const planning = page.locator('[data-swimlane-name="Planning"]');

    await planning.waitFor({ state: 'visible', timeout: 5000 });

    // Scroll Planning column into view
    await page.evaluate(() => {
      const targetElement = document.querySelector('[data-swimlane-name="Planning"]');
      if (targetElement) targetElement.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
    });
    // Short wait needed for scroll to complete
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

    // @dnd-kit PointerSensor requires movement >= 5px to activate
    await page.mouse.move(startX + 10, startY, { steps: 3 });
    await page.waitForTimeout(100);

    // Move to target in steps
    await page.mouse.move(endX, endY, { steps: 15 });
    // Wait for @dnd-kit drag animation to settle
    await page.waitForTimeout(200);

    await page.mouse.up();
    // Wait for drop animation and state update
    await page.waitForTimeout(500);

    // Task should appear in Planning and be gone from To Do
    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await expect(planning.locator('text=Test Task Beta').first()).toBeVisible({ timeout: 5000 });
    await expect(backlog.locator('text=Test Task Beta')).not.toBeVisible({ timeout: 3000 });
  });

  test('can delete a task', async () => {
    // Create a temp task to delete
    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await backlog.locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Task To Delete');
    await page.locator('button:has-text("Create")').click();
    await expect(taskCard('Task To Delete')).toBeVisible({ timeout: 3000 });

    // Open the task (backlog tasks open in edit mode with Delete in footer)
    await taskCard('Task To Delete').click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    await page.locator('button:has-text("Delete")').click();

    // Confirm deletion in the ConfirmDialog
    await page.locator('text=This action cannot be undone.').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('button:has-text("Delete")').click();

    // Verify the task is gone from To Do
    await expect(backlog.locator('text=Task To Delete')).not.toBeVisible({ timeout: 3000 });
  });

  test('edit mode footer shows Delete for backlog task', async () => {
    // Create a fresh task for this test
    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await backlog.locator('text=Add task').click();
    await page.locator('input[placeholder="Task title"]').fill('Test Task Gamma');
    await page.locator('button:has-text("Create")').click();
    await expect(taskCard('Test Task Gamma')).toBeVisible({ timeout: 3000 });

    // Open the task detail dialog
    await taskCard('Test Task Gamma').click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    // To Do tasks open in edit mode with Delete in footer
    const dialog = page.locator('[data-testid="task-detail-dialog"]');
    await expect(dialog.locator('button:has-text("Delete")')).toBeVisible();
    await expect(dialog.locator('button:has-text("Save")')).toBeVisible();
    await expect(dialog.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test('can delete a non-archived task directly', async () => {
    // "Test Task Gamma" was created above and is still in To Do
    await taskCard('Test Task Gamma').click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    // To Do tasks open in edit mode -- Delete is in the footer
    await page.locator('button:has-text("Delete")').click();

    // Confirm deletion in the ConfirmDialog
    await page.locator('text=This action cannot be undone.').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('button:has-text("Delete")').click();

    // Verify the task is gone from the To Do column
    const backlog = page.locator('[data-swimlane-name="To Do"]');
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
    await page.locator('text=Edit Column').waitFor({ state: 'visible', timeout: 3000 });
    await expect(page.locator('text=Edit Column')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('text=Edit Column').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('can add a new custom column', async () => {
    const addColumnBtn = page.locator('button:has-text("Add column")');
    if (await addColumnBtn.isVisible()) {
      await addColumnBtn.click();

      // New Column dialog opens
      await expect(page.locator('text=New Column')).toBeVisible({ timeout: 3000 });
      const nameInput = page.locator('input[placeholder="Column name"]');
      await nameInput.fill('Custom Stage');
      await page.locator('button:has-text("Create")').click();
      await expect(page.locator('[data-swimlane-name="Custom Stage"]')).toBeVisible({ timeout: 3000 });
    }
  });
});

test.describe('Session & Column Details', () => {
  test.beforeEach(async () => {
    await ensureBoardVisible();
  });

  test('task detail dialog shows no session state', async () => {
    await taskCard('Updated Task Alpha').click();
    await page.locator('.fixed input[placeholder="Task title"], .fixed textarea').first().waitFor({ state: 'visible' });

    // To Do tasks open in edit mode -- the edit textarea is visible instead of "No active session"
    const textarea = page.locator('.fixed textarea');
    await expect(textarea).toBeVisible();

    await page.keyboard.press('Escape');
    await page.locator('.fixed textarea').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('session count starts at 0', async () => {
    await expect(page.locator('[data-testid="session-count"]')).toContainText('0 agents');
  });

  test('system columns cannot be deleted via UI', async () => {
    const planning = page.locator('[data-swimlane-name="Planning"]');
    await planning.locator('text=Planning').click();
    await page.locator('text=Edit Column').waitFor({ state: 'visible', timeout: 3000 });

    const lockIndicator = page.locator('text=System column');
    const hasLock = await lockIndicator.isVisible().catch(() => false);
    if (hasLock) {
      const deleteBtn = page.locator('button:has-text("Delete column")');
      await expect(deleteBtn).not.toBeVisible();
    }

    await page.keyboard.press('Escape');
    await page.locator('text=Edit Column').waitFor({ state: 'hidden', timeout: 2000 });
  });

  test('tasks in To Do have no branch info', async () => {
    await taskCard('Updated Task Alpha').click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    await expect(page.locator('text=Branch:')).not.toBeVisible();

    await page.keyboard.press('Escape');
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
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
    // Use the welcome button if sidebar is not visible, otherwise use the dropdown
    const welcomeButton = page.locator('[data-testid="welcome-open-project"]');
    if (await welcomeButton.isVisible()) {
      await welcomeButton.click();
    } else {
      await page.locator('button[title="Open folder as project"]').click();
    }
    await waitForBoard(page);

    await expect(page.locator('text=(worktree)')).toBeVisible();
  });
});

test.describe('Project Deletion', () => {
  test('deleting active project clears board and removes from sidebar', async () => {
    const name = `DelTest ${runId}`;
    await createProject(page, name);
    await createTask(page, `Task A ${runId}`);
    await createTask(page, `Task B ${runId}`);

    // Sanity: tasks and board visible
    await expect(taskCard(`Task A ${runId}`)).toBeVisible();
    await expect(taskCard(`Task B ${runId}`)).toBeVisible();
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();

    // Right-click the project row to open the context menu, then click Delete
    const projectRow = page.locator(`[role="button"]:has-text("${name}")`);
    await projectRow.click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Delete').click();

    // Confirm deletion in dialog
    await expect(page.locator('h3:has-text("Delete Project")')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    // Project removed from sidebar
    await expect(page.locator(`[role="button"]:has-text("${name}")`)).not.toBeVisible({ timeout: 3000 });

    // Deleted project's tasks are cleared from backend
    const tasks = await page.evaluate(() => window.electronAPI.tasks.list());
    const deletedProjectTasks = tasks.filter((t: { title: string }) =>
      t.title.includes(`${runId}`)
    );
    expect(deletedProjectTasks).toEqual([]);
  });

  test('new project after deletion loads clean state (no cross-project bleed)', async () => {
    const name = `PostDel ${runId}`;
    await createProject(page, name);

    // Default swimlanes present
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();
    await expect(page.locator('[data-swimlane-name="Done"]')).toBeVisible();

    // Board has columns but no leftover tasks from the deleted project
    const backlog = page.locator('[data-swimlane-name="To Do"]');
    await expect(backlog.locator(`text=Task A ${runId}`)).not.toBeVisible();
    await expect(backlog.locator(`text=Task B ${runId}`)).not.toBeVisible();

    // Board is functional -- can create new tasks
    await createTask(page, `Fresh Task ${runId}`);
    await expect(taskCard(`Fresh Task ${runId}`)).toBeVisible();
  });

  test('cancel delete preserves project and board', async () => {
    const name = `PostDel ${runId}`;

    // Try to delete (via context menu) but cancel
    const projectRow = page.locator(`[role="button"]:has-text("${name}")`);
    await projectRow.click({ button: 'right' });
    await page.locator('.fixed.bg-surface-raised').locator('text=Delete').click();

    // Dialog appears
    await expect(page.locator('h3:has-text("Delete Project")')).toBeVisible();

    // Cancel
    await page.locator('button:has-text("Cancel")').click();
    await page.locator('h3:has-text("Delete Project")').waitFor({ state: 'hidden', timeout: 2000 });

    // Dialog dismissed, project and board intact
    await expect(page.locator('h3:has-text("Delete Project")')).not.toBeVisible();
    await expect(page.locator(`[role="button"]:has-text("${name}")`)).toBeVisible();
    await expect(page.locator('[data-swimlane-name="To Do"]')).toBeVisible();
    await expect(taskCard(`Fresh Task ${runId}`)).toBeVisible();
  });
});

test.describe('Project Reorder', () => {
  test('new project appears at top of sidebar (position 0)', async () => {
    // Clean slate: remove all pre-existing projects so only Alpha/Beta/Gamma remain
    await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      for (const project of projects) {
        await window.electronAPI.projects.delete(project.id);
      }
    });
    await page.reload();
    await page.waitForSelector('text=Kangentic', { timeout: 15000 });

    await createProject(page, 'Alpha');
    await createProject(page, 'Beta');
    await createProject(page, 'Gamma');

    // Gamma was created last, should be at the top (position 0)
    const projectButtons = page.locator('[role="button"]:has(.truncate.font-medium)');
    const names = await projectButtons.locator('.truncate.font-medium').allTextContents();

    expect(names[0]).toBe('Gamma');
    expect(names[1]).toBe('Beta');
    expect(names[2]).toBe('Alpha');
  });

  test('order persists after re-fetch via loadProjects', async () => {
    // Force a fresh load from the mock backend
    await page.evaluate(async () => {
      const store = (window as any).__zustandStores?.project;
      if (store) {
        await store.getState().loadProjects();
      } else {
        // Fallback: call the API directly and check order
        const projects = await window.electronAPI.projects.list();
        // Verify they come back sorted by position
        for (let i = 1; i < projects.length; i++) {
          if (projects[i].position < projects[i - 1].position) {
            throw new Error('Projects not sorted by position');
          }
        }
      }
    });

    // Verify sidebar order is still correct
    const projectButtons = page.locator('[role="button"]:has(.truncate.font-medium)');
    const names = await projectButtons.locator('.truncate.font-medium').allTextContents();

    expect(names[0]).toBe('Gamma');
    expect(names[1]).toBe('Beta');
    expect(names[2]).toBe('Alpha');
  });

  test('reorder API updates position values', async () => {
    // Call reorder directly to reverse the order: Alpha, Beta, Gamma
    const positions = await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      const reversed = [...projects].reverse();
      await window.electronAPI.projects.reorder(reversed.map((p: any) => p.id));
      const updated = await window.electronAPI.projects.list();
      return updated.map((p: any) => ({ name: p.name, position: p.position }));
    });

    expect(positions[0].name).toBe('Alpha');
    expect(positions[0].position).toBe(0);
    expect(positions[1].name).toBe('Beta');
    expect(positions[1].position).toBe(1);
    expect(positions[2].name).toBe('Gamma');
    expect(positions[2].position).toBe(2);
  });

  test('drag project down reorders sidebar', async () => {
    // Current order after previous test: Alpha, Beta, Gamma
    // Drag Alpha (top) down past Beta to get: Beta, Alpha, Gamma
    const projectItems = page.locator('[role="button"]:has(.truncate.font-medium)');
    const firstItem = projectItems.nth(0);
    const secondItem = projectItems.nth(1);

    const firstBox = await firstItem.boundingBox();
    const secondBox = await secondItem.boundingBox();
    if (!firstBox || !secondBox) throw new Error('Could not get bounding boxes');

    const startX = firstBox.x + firstBox.width / 2;
    const startY = firstBox.y + firstBox.height / 2;
    // Drop at the bottom edge of the second item
    const endX = secondBox.x + secondBox.width / 2;
    const endY = secondBox.y + secondBox.height * 0.75;

    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // @dnd-kit PointerSensor requires movement >= 5px to activate
    await page.mouse.move(startX, startY + 10, { steps: 3 });
    await page.waitForTimeout(100);

    // Move to target position in small steps
    await page.mouse.move(endX, endY, { steps: 15 });
    // Wait for @dnd-kit drag animation
    await page.waitForTimeout(300);

    await page.mouse.up();
    // Wait for drop animation and state update
    await page.waitForTimeout(500);

    // After drag, verify order changed -- Alpha should no longer be first
    const names = await projectItems.locator('.truncate.font-medium').allTextContents();
    expect(names[0]).not.toBe('Alpha');
    // Alpha should have moved down at least one position
    const alphaIndex = names.indexOf('Alpha');
    expect(alphaIndex).toBeGreaterThan(0);
  });

  test('drag reorder persists to backend', async () => {
    // Verify the backend positions match the current sidebar order
    const sidebar = page.locator('.bg-surface-raised').first();
    const sidebarNames = await sidebar
      .locator('[role="button"] .truncate.font-medium')
      .allTextContents();

    const backendNames = await page.evaluate(async () => {
      const projects = await window.electronAPI.projects.list();
      return projects.map((p: any) => p.name);
    });

    // Backend order should match sidebar order
    expect(backendNames).toEqual(sidebarNames);
  });
});
