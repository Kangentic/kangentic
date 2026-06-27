/**
 * UI tests for the confirmation dialog when moving a task with pending
 * changes back to the To Do column.
 *
 * Moving to To Do is destructive - it deletes worktrees, branches, and
 * session history. When the task has uncommitted files or unpushed commits,
 * a confirmation dialog must appear so the user can choose to keep working.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-move-confirm';
const TASK_ID = 'task-move-confirm';

/**
 * Launch a page with pre-configured mock state.
 * The preConfigScript string is evaluated via addInitScript after the mock
 * is injected but before React mounts, so stores load the pre-set data.
 */
async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/**
 * Build a pre-configure script that creates a project with a task that has
 * a worktree. The task is in the Executing column. Optionally overrides
 * checkPendingChanges to simulate pending changes.
 */
function makePreConfig(options: {
  hasPendingChanges: boolean;
  uncommittedFileCount?: number;
  unpushedCommitCount?: number;
  hasWorktree?: boolean;
}): string {
  const uncommittedFileCount = options.uncommittedFileCount ?? (options.hasPendingChanges ? 3 : 0);
  const unpushedCommitCount = options.unpushedCommitCount ?? (options.hasPendingChanges ? 1 : 0);
  const worktreePath = options.hasWorktree !== false ? "'/mock/worktrees/test-wt'" : 'null';
  const branchName = "task-move-confirm-abcd1234";

  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Move Confirm Test',
        path: '/mock/move-confirm-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      // Resolve plan_exit_target_id: Planning -> Executing
      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // Task in Executing with worktree
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Feature With Changes',
        description: 'A task with pending changes in its worktree',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: ${worktreePath},
        branch_name: '${branchName}',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Override checkPendingChanges mock to return the configured state
      window.electronAPI.git.checkPendingChanges = async function () {
        return {
          hasPendingChanges: ${options.hasPendingChanges},
          uncommittedFileCount: ${uncommittedFileCount},
          unpushedCommitCount: ${unpushedCommitCount},
          currentBranch: null,
        };
      };

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/**
 * Drag a task card from its current column to a target column.
 */
async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page
    .locator('[data-testid="swimlane"]')
    .locator(`text=${taskTitle}`)
    .first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  // Scroll so both elements are in view. boundingBox() forces a layout flush
  // after the scroll, so no fixed wait is needed.
  await page.evaluate((targetCol: string) => {
    const targetElement = document.querySelector(`[data-swimlane-name="${targetCol}"]`);
    if (targetElement) targetElement.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

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
  // Poll for dnd-kit activation: DragOverlay renders a .drag-overlay element
  // containing the task title once the sensor fires. Filtering by title avoids
  // strict-mode violations when a previous drag's overlay is still unmounting.
  await expect(page.locator('.drag-overlay').filter({ hasText: taskTitle })).toBeVisible({ timeout: 2000 });
  // Move to target in steps.
  await page.mouse.move(endX, endY, { steps: 30 });
  // Intentional fixed wait (dnd-kit collision settle): there is no DOM signal
  // for "target column is hovered" on regular swimlanes. 200ms gives dnd-kit's
  // collision detection time to register the drop target before pointerup fires.
  // This replaces the original 200ms wait; the 500ms post-drop wait is removed
  // because the caller's next toBeVisible assertion handles post-drop state.
  await page.waitForTimeout(200);
  await page.mouse.up();
  // Wait for the DragOverlay to detach. dnd-kit calls setActiveTask(null) in
  // handleDragEnd which removes the .drag-overlay element. Ensures dnd-kit
  // cleanup completes before the next assertion.
  await page.locator('.drag-overlay').filter({ hasText: taskTitle }).waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
}

test.describe('Move to To Do - Pending Changes Confirmation', () => {
  test('shows confirmation dialog when task has pending changes', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ hasPendingChanges: true, uncommittedFileCount: 5, unpushedCommitCount: 2 }),
    );

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Verify the task is in Executing
      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      await expect(executingColumn.locator('text=Feature With Changes')).toBeVisible();

      // Drag to To Do
      await dragTaskToColumn(page, 'Feature With Changes', 'To Do');

      // Confirmation dialog should appear
      const dialog = page.locator('text=Reset task?');
      await expect(dialog).toBeVisible({ timeout: 3000 });

      // Check that the dialog shows pending change counts
      await expect(page.locator('text=5 uncommitted files')).toBeVisible();
      await expect(page.locator('text=2 unpushed commits')).toBeVisible();

      // Check dialog buttons
      await expect(page.locator('button:has-text("Reset")')).toBeVisible();
      await expect(page.locator('button:has-text("Keep Working")')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('cancel keeps task in original column', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ hasPendingChanges: true }),
    );

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Feature With Changes', 'To Do');

      // Wait for confirmation dialog
      await expect(page.locator('text=Reset task?')).toBeVisible({ timeout: 3000 });

      // Click "Keep Working" to cancel
      await page.locator('button:has-text("Keep Working")').click();

      // Dialog should close
      await expect(page.locator('text=Reset task?')).toBeHidden({ timeout: 3000 });

      // Task should still be in Executing (not moved)
      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      await expect(executingColumn.locator('text=Feature With Changes')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('confirm moves task to To Do', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ hasPendingChanges: true }),
    );

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Feature With Changes', 'To Do');

      // Wait for confirmation dialog
      await expect(page.locator('text=Reset task?')).toBeVisible({ timeout: 3000 });

      // Click "Reset" to confirm
      await page.locator('button:has-text("Reset")').click();

      // Dialog should close
      await expect(page.locator('text=Reset task?')).toBeHidden({ timeout: 3000 });

      // Task should now be in To Do
      const todoColumn = page.locator('[data-swimlane-name="To Do"]');
      await expect(todoColumn.locator('text=Feature With Changes')).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('no confirmation when task has no pending changes', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ hasPendingChanges: false }),
    );

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Feature With Changes', 'To Do');

      // No confirmation dialog should appear
      await expect(page.locator('text=Reset task?')).toBeHidden({ timeout: 2000 });

      // Task should move directly to To Do
      const todoColumn = page.locator('[data-swimlane-name="To Do"]');
      await expect(todoColumn.locator('text=Feature With Changes')).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('shows warning when git check fails', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ hasPendingChanges: true }),
    );

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Override checkPendingChanges to throw (simulating git failure)
      await page.evaluate(() => {
        window.electronAPI.git.checkPendingChanges = async () => {
          throw new Error('git status failed');
        };
      });

      await dragTaskToColumn(page, 'Feature With Changes', 'To Do');

      // Confirmation dialog should still appear (safe default)
      await expect(page.locator('text=Reset task?')).toBeVisible({ timeout: 3000 });

      // Should show the fallback warning about unverified changes
      await expect(page.locator('text=Unable to verify pending changes')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('shows worktree deletion warning for worktree tasks', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({ hasPendingChanges: true, hasWorktree: true, uncommittedFileCount: 1, unpushedCommitCount: 0 }),
    );

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Feature With Changes', 'To Do');

      await expect(page.locator('text=Reset task?')).toBeVisible({ timeout: 3000 });

      // Worktree-specific message
      await expect(page.locator('text=delete its worktree')).toBeVisible();
      await expect(page.locator('text=1 uncommitted file')).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
