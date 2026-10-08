/**
 * UI tests for user-paused session behavior on task column moves.
 *
 * When a user manually pauses a session, moving the task to another column
 * should NOT auto-resume it. The task should remain paused with a "Resume
 * session" button, and no "Agent started" toast should appear.
 *
 * Backend fix: commit e759dbc added a `suspended_by='user'` guard in
 * spawnAgent(). These tests verify the renderer-side behavior: stale
 * pendingCommandLabel cleanup and correct paused UI state after moves.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

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

  await gotoVite(page, VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

const PROJECT_ID = 'proj-pause-move';
const TASK_ID = 'task-pause-move';
const SESSION_ID = 'sess-pause-move';

/**
 * Build pre-configure script that creates a project with a user-paused task.
 * The task has session_id=null (cleared on pause) and a suspended session.
 * Optionally sets auto_command on the Code Review column.
 */
function makePreConfig(options: { autoCommand?: string } = {}): string {
  const autoCommand = options.autoCommand ? `'${options.autoCommand}'` : 'null';
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Pause Move Test',
        path: '/mock/pause-move-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Create swimlanes with IDs we can reference
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        var lane = Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        });
        // Optionally set auto_command on Code Review
        if (s.name === 'Code Review') {
          lane.auto_command = ${autoCommand};
        }
        state.swimlanes.push(lane);
      });

      // Resolve plan_exit_target_id: Planning -> Executing
      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // Create a suspended session (user-paused)
      state.sessions.push({
        id: '${SESSION_ID}',
        taskId: '${TASK_ID}',
        projectId: '${PROJECT_ID}',
        pid: 9999,
        status: 'suspended',
        shell: 'bash',
        cwd: '/mock/pause-move-test',
        startedAt: ts,
        exitCode: null,
      });

      // Task in Executing column, no active session (user paused it)
      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Paused Task',
        description: 'A task that was manually paused',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

/**
 * Drag a task card from its current column to a target column.
 * Uses mouse events to simulate @dnd-kit's PointerSensor (activation distance >= 5px).
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
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Move enough to activate @dnd-kit's PointerSensor (distance >= 5)
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

test.describe('User-paused session behavior on column move', () => {
  test.describe('paused task stays paused on move', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      ({ browser, page } = await launchWithState(makePreConfig()));
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('task card shows Paused status in original column', async () => {
      // The task should be in Executing with a "Paused" status bar
      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      const taskCard = executingColumn.locator(`text=Paused Task`).first();
      await taskCard.waitFor({ state: 'visible', timeout: 5000 });

      const statusBar = executingColumn.locator('[data-testid="status-bar"]');
      await expect(statusBar).toContainText('Paused');
    });

    test('task stays paused after moving to Code Review', async () => {
      await dragTaskToColumn(page, 'Paused Task', 'Code Review');

      // Task should now be in Code Review
      const codeReviewColumn = page.locator('[data-swimlane-name="Code Review"]');
      const taskCard = codeReviewColumn.locator(`text=Paused Task`);
      await expect(taskCard).toBeVisible({ timeout: 5000 });

      // Status bar should still show "Paused"
      const statusBar = codeReviewColumn.locator('[data-testid="status-bar"]');
      await expect(statusBar).toContainText('Paused');

      // No "Agent started" or "Agent resumed" toast should appear
      const agentToast = page.locator('text=/Agent (started|resumed)/');
      await expect(agentToast).not.toBeVisible();
    });
  });

  test.describe('pendingCommandLabel cleared for paused task', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      // Set auto_command on Code Review so the board store sets pendingCommandLabel
      ({ browser, page } = await launchWithState(makePreConfig({ autoCommand: '/code-review' })));
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('no stale shimmer overlay after moving paused task to auto_command column', async () => {
      // Move paused task to Code Review (which has auto_command='/code-review')
      await dragTaskToColumn(page, 'Paused Task', 'Code Review');

      // Task should be in Code Review and still paused
      const codeReviewColumn = page.locator('[data-swimlane-name="Code Review"]');
      const taskCard = codeReviewColumn.locator(`text=Paused Task`);
      await expect(taskCard).toBeVisible({ timeout: 5000 });

      // Status bar should show "Paused"
      const statusBar = codeReviewColumn.locator('[data-testid="status-bar"]');
      await expect(statusBar).toContainText('Paused');

      // Verify no "Agent started" toast (which would indicate an unwanted auto-spawn)
      const agentToast = page.locator('text=/Agent (started|resumed)/');
      await expect(agentToast).not.toBeVisible();
    });
  });
});
