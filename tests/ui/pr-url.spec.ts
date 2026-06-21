/**
 * UI tests for the PR URL field in the task-detail edit form and the PR badge
 * on task cards.
 *
 * Root cause of the prior flakiness (fixed here):
 *
 * 1. SHARED-PAGE CROSS-TEST STATE: the old suite used a single shared browser
 *    page across all three tests. Test 3 depended on test 2 having saved a PR
 *    URL - a cross-test state dependency that cascaded into failures when the
 *    shared page crashed.
 *
 * 2. LIVE auto_spawn INSTABILITY: test 2 moved a task into Planning via the
 *    right-click context menu. Planning has auto_spawn:true, so the renderer
 *    called sessions.spawn, which the mock throws for. The failing-spawn
 *    aftermath (spawnProgress, stall timers) was the instability window that
 *    crashed the renderer under CI load.
 *
 * Fix: each test launches its own fresh page and closes it in a finally block.
 * Tasks are seeded DIRECTLY into their target lanes via __mockPreConfigure.
 * No task is ever moved via the UI, context menu, or board store, so no spawn
 * is ever attempted.
 *
 * Pattern sourced from spawn-progress-clear-on-todo-move.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_ID = 'proj-pr-url-test';

/** Stable task ids - each test uses its own task so tests are fully isolated. */
const TASK_TODO_ID = 'task-pr-url-todo';
const TASK_PLANNING_FILL_ID = 'task-pr-url-planning-fill';
const TASK_PLANNING_CLEAR_ID = 'task-pr-url-planning-clear';

/**
 * Launch a fresh headless page with a project and all three test tasks
 * pre-seeded into their target swimlanes.
 *
 * Seeding tasks directly into Planning avoids any UI-driven move, which would
 * trigger auto_spawn and crash the mock's sessions.spawn handler.
 *
 * - TASK_TODO_ID: placed in the To Do lane (role='todo').
 * - TASK_PLANNING_FILL_ID: placed in Planning with no PR URL (pr_url=null).
 * - TASK_PLANNING_CLEAR_ID: placed in Planning already pre-seeded with
 *   pr_url='https://github.com/owner/repo/pull/99' and pr_number=99, so test 3
 *   does not depend on test 2 having saved anything.
 */
async function launchWithSeededState(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'PR URL Test',
        path: '/mock/pr-url-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // Build swimlanes from DEFAULT_SWIMLANES with stable IDs
      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (swimlane, index) {
        var laneId = 'lane-pru-' + swimlane.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[swimlane.name] = laneId;
        state.swimlanes.push(Object.assign({}, swimlane, {
          id: laneId,
          position: index,
          created_at: ts,
        }));
      });

      // Resolve plan_exit_target_id: Planning -> Executing (required by the
      // store - planningLane.plan_exit_target_id must point to a real lane id)
      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      // Task 1: sits in To Do - used by "PR URL field is hidden in To Do column"
      state.tasks.push({
        id: '${TASK_TODO_ID}',
        title: 'PR URL Todo Task',
        description: '',
        swimlane_id: laneIds['To Do'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        pr_state: null,
        base_branch: null,
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Task 2: sits in Planning with no PR URL - used by "saving PR URL persists"
      state.tasks.push({
        id: '${TASK_PLANNING_FILL_ID}',
        title: 'PR URL Fill Task',
        description: '',
        swimlane_id: laneIds['Planning'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        pr_state: null,
        base_branch: null,
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Task 3: sits in Planning already bearing a PR URL and pr_number.
      // This makes test 3 independent of test 2 - it does not need test 2 to
      // have saved the value; the value is seeded here at page load.
      state.tasks.push({
        id: '${TASK_PLANNING_CLEAR_ID}',
        title: 'PR URL Clear Task',
        description: '',
        swimlane_id: laneIds['Planning'],
        position: 1,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: 99,
        pr_url: 'https://github.com/owner/repo/pull/99',
        pr_state: null,
        base_branch: null,
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('PR URL in Edit Form', () => {
  test('PR URL field is hidden in To Do column', async () => {
    const { browser, page } = await launchWithSeededState();

    try {
      await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

      // Click the task card seeded into the To Do lane
      const todoColumn = page.locator('[data-swimlane-name="To Do"]');
      await todoColumn.locator('text=PR URL Todo Task').first().click();

      // Wait for the task-detail window edit form to mount
      await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible', timeout: 5000 });

      // The PR URL field must be absent because the task is in To Do (isInTodo=true)
      const prUrlInput = page.locator('[data-testid="pr-url-input"]');
      await expect(prUrlInput).not.toBeVisible({ timeout: 3000 });
    } finally {
      await browser.close();
    }
  });

  test('saving PR URL persists and shows PR badge on card', async () => {
    const { browser, page } = await launchWithSeededState();

    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });

      // Click the task card seeded into Planning with no PR URL
      const planningColumn = page.locator('[data-swimlane-name="Planning"]');
      await planningColumn.locator('text=PR URL Fill Task').first().click();

      // Wait for the task-detail window edit form to mount
      await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible', timeout: 5000 });

      // PR URL field must be visible because the task is in Planning (isInTodo=false)
      const prUrlInput = page.locator('[data-testid="pr-url-input"]');
      await expect(prUrlInput).toBeVisible({ timeout: 3000 });

      // Fill in the PR URL and save
      await prUrlInput.fill('https://github.com/owner/repo/pull/99');
      await page.locator('button:has-text("Save")').click();

      // After saving, the Fill task's own card must show the PR badge with the correct
      // number. Scope to its data-task-id so the assertion cannot be satisfied by the
      // Clear task's pre-seeded badge, which also lives in this Planning column.
      const fillTaskCard = planningColumn.locator(`[data-task-id="${TASK_PLANNING_FILL_ID}"]`);
      const prBadge = fillTaskCard.locator('[data-testid="task-card-pr-link"]');
      await expect(prBadge).toBeVisible({ timeout: 5000 });
      await expect(prBadge).toHaveText('PR #99');
    } finally {
      await browser.close();
    }
  });

  test('clearing PR URL removes badge from card', async () => {
    const { browser, page } = await launchWithSeededState();

    try {
      await page.locator('[data-swimlane-name="Planning"]').waitFor({ state: 'visible', timeout: 15000 });

      // Click the task card seeded into Planning that ALREADY has pr_url and pr_number=99.
      // This task was seeded with a PR URL at page load, so this test is fully independent
      // of test 2 - it never needs test 2 to have run or saved anything.
      const planningColumn = page.locator('[data-swimlane-name="Planning"]');
      await planningColumn.locator('text=PR URL Clear Task').first().click();

      // Wait for the task-detail window edit form to mount
      await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible', timeout: 5000 });

      // The PR URL field must already show the seeded value
      const prUrlInput = page.locator('[data-testid="pr-url-input"]');
      await expect(prUrlInput).toHaveValue('https://github.com/owner/repo/pull/99', { timeout: 3000 });

      // Clear the field and save
      await prUrlInput.clear();
      await page.locator('button:has-text("Save")').click();

      // After saving with an empty URL, the PR badge must no longer be visible on the card.
      // Scope to the specific card via data-task-id to avoid matching the Fill Task's badge
      // (which both share the same Planning column).
      const clearTaskCard = planningColumn.locator(`[data-task-id="${TASK_PLANNING_CLEAR_ID}"]`);
      await expect(
        clearTaskCard.locator('[data-testid="task-card-pr-link"]'),
      ).not.toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
