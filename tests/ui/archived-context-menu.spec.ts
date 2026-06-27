/**
 * UI tests for the archived-task right-click context menu (ArchivedTaskContextMenu).
 *
 * Surfaces tested:
 *   1. DoneSwimlane preview list - compact TaskCard wired with onContextMenu
 *      when task.archived_at is set.
 *   2. CompletedTasksDialog - DataTable.onRowContextMenu wiring.
 *
 * Both surfaces should:
 *   - Open the archived context menu at the cursor on right-click.
 *   - Surface "Restore to" with non-Done lanes.
 *   - Surface "Delete permanently" which routes through ConfirmDialog (skipDeleteConfirm
 *     unset by default) and ultimately calls tasks.delete via the existing
 *     deleteArchivedTask path.
 *
 * Additional coverage (added 2026-05-13):
 *   - Restore-to flow on both surfaces (tasks.unarchive IPC spy).
 *   - worktree_path truthy -> Changes menu item is visible.
 *   - Escape key closes the context menu (document-level dispatch, avoids xterm capture).
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

const PROJECT_ID = 'proj-archived-context-menu';
const TASK_ID = 'task-archived-context-menu';

async function launchWithArchivedTask(): Promise<{ browser: Browser; page: Page }> {
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
        name: 'Archived Context Menu Test',
        path: '/mock/archived-context-menu-test',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-acm-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      state.archivedTasks.push({
        id: '${TASK_ID}',
        title: 'Archived Task For Context Menu',
        description: 'Was completed; testing right-click menu',
        swimlane_id: laneIds['Done'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 0,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `);

  // Install a spy for tasks.delete so we can assert it fires from the menu.
  // mock-electron-api defines electronAPI synchronously when its init script
  // runs; we poll briefly because spy installation runs in a separate script.
  await page.addInitScript(`
    window.__taskDeleteCalls = [];
    var originalDelete = null;
    var checkInterval = setInterval(function () {
      if (window.electronAPI && window.electronAPI.tasks && window.electronAPI.tasks.delete && !originalDelete) {
        originalDelete = window.electronAPI.tasks.delete;
        window.electronAPI.tasks.delete = async function (id) {
          window.__taskDeleteCalls.push(id);
          return originalDelete(id);
        };
        clearInterval(checkInterval);
      }
    }, 10);
  `);

  // Install a spy for tasks.unarchive so we can assert the restore-to flow.
  // Same polling approach as the delete spy above.
  await page.addInitScript(`
    window.__taskUnarchiveCalls = [];
    var originalUnarchive = null;
    var unarchiveCheckInterval = setInterval(function () {
      if (window.electronAPI && window.electronAPI.tasks && window.electronAPI.tasks.unarchive && !originalUnarchive) {
        originalUnarchive = window.electronAPI.tasks.unarchive;
        window.electronAPI.tasks.unarchive = async function (input) {
          window.__taskUnarchiveCalls.push({ id: input.id, targetSwimlaneId: input.targetSwimlaneId });
          return originalUnarchive(input);
        };
        clearInterval(unarchiveCheckInterval);
      }
    }, 10);
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

async function readTaskDeleteCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __taskDeleteCalls: string[] }).__taskDeleteCalls ?? []);
}

async function readTaskUnarchivedCalls(page: Page): Promise<Array<{ id: string; targetSwimlaneId: string }>> {
  return page.evaluate(() => (window as unknown as { __taskUnarchiveCalls: Array<{ id: string; targetSwimlaneId: string }> }).__taskUnarchiveCalls ?? []);
}

/**
 * Launch a page with the archived task seeded with a non-null worktree_path.
 * Used only for the Changes menu item visibility test.
 */
async function launchWithWorktreeArchivedTask(): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(`
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: 'proj-acm-worktree',
        name: 'Archived Context Menu Worktree Test',
        path: '/mock/archived-context-menu-worktree',
        github_url: null,
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      var laneIds = {};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        var id = 'lane-acmwt-' + s.name.toLowerCase().replace(/\\s+/g, '-');
        laneIds[s.name] = id;
        state.swimlanes.push(Object.assign({}, s, {
          id: id,
          position: i,
          created_at: ts,
        }));
      });

      state.archivedTasks.push({
        id: 'task-acm-worktree',
        title: 'Archived Task With Worktree',
        description: 'Has a worktree path for Changes test',
        swimlane_id: laneIds['Done'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: '/mock/worktrees/task-acm-worktree',
        branch_name: 'task-acm-worktree',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: [],
        priority: 0,
        attachment_count: 0,
        archived_at: ts,
        created_at: ts,
        updated_at: ts,
      });

      return { currentProjectId: 'proj-acm-worktree' };
    });
  `);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

test.describe('Archived task context menu', () => {
  test('DoneSwimlane preview: right-click opens menu, delete routes through ConfirmDialog', async () => {
    const { browser, page } = await launchWithArchivedTask();
    try {
      // Wait for the Done swimlane's compact preview card to render.
      const compactCard = page.locator('[data-task-id="' + TASK_ID + '"]').first();
      await compactCard.waitFor({ state: 'visible', timeout: 10000 });

      await compactCard.click({ button: 'right' });

      // Menu rendered with archived-specific test IDs.
      await expect(page.locator('[data-testid="archived-context-copy-task-id"]')).toBeVisible();
      await expect(page.locator('[data-testid="archived-context-open-task"]')).toBeVisible();
      await expect(page.locator('[data-testid="archived-context-restore-to"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="archived-context-delete-task"]')).toBeVisible();

      // No worktree_path -> "Changes" item must be gated off.
      await expect(page.locator('[data-testid="archived-context-show-changes"]')).not.toBeVisible();

      // Click delete -> opens ConfirmDialog (skipDeleteConfirm is false by default).
      await page.locator('[data-testid="archived-context-delete-task"]').click();

      // Confirm dialog has a "Delete" confirm button (variant=danger).
      const confirmButton = page.locator('button:has-text("Delete")').last();
      await confirmButton.click();

      // tasks.delete must have been invoked with our task ID.
      await expect.poll(() => readTaskDeleteCalls(page)).toContain(TASK_ID);
    } finally {
      await browser.close();
    }
  });

  test('CompletedTasksDialog: right-click row opens menu, delete routes through ConfirmDialog', async () => {
    const { browser, page } = await launchWithArchivedTask();
    try {
      // Open the "View all" dialog from the Done swimlane.
      const viewAllButton = page.locator('[data-testid="view-all-completed"]');
      await viewAllButton.waitFor({ state: 'visible', timeout: 10000 });
      await viewAllButton.click();

      const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // Right-click the row.
      const row = page.locator('[data-testid="completed-task-row"]').first();
      await row.waitFor({ state: 'visible', timeout: 5000 });
      await row.click({ button: 'right' });

      // Archived context menu is visible.
      await expect(page.locator('[data-testid="archived-context-copy-task-id"]')).toBeVisible();
      await expect(page.locator('[data-testid="archived-context-restore-to"]').first()).toBeVisible();
      await expect(page.locator('[data-testid="archived-context-delete-task"]')).toBeVisible();

      // Trigger delete.
      await page.locator('[data-testid="archived-context-delete-task"]').click();

      // ConfirmDialog inside CompletedTasksDialog.
      const confirmButton = page.locator('button:has-text("Delete")').last();
      await confirmButton.click();

      await expect.poll(() => readTaskDeleteCalls(page)).toContain(TASK_ID);
    } finally {
      await browser.close();
    }
  });

  test('Active board tasks still get the original TaskContextMenu (no regression)', async () => {
    const { browser, page } = await launchWithArchivedTask();
    try {
      // Create an active task in the To Do column via the mock API.
      await page.evaluate(async () => {
        const lanes = await window.electronAPI.swimlanes.list();
        const todoLane = lanes.find((lane: { name: string }) => lane.name === 'To Do');
        if (!todoLane) throw new Error('To Do lane not found');
        await window.electronAPI.tasks.create({
          title: 'Active Task',
          description: '',
          swimlane_id: todoLane.id,
          agent: 'claude',
          labels: [],
          priority: 0,
        });
      });

      // Reload the board store so the new task appears.
      await page.evaluate(async () => {
        const stores = (window as unknown as {
          __zustandStores?: { board: { getState: () => { loadBoard: () => Promise<void> } } };
        }).__zustandStores;
        await stores?.board.getState().loadBoard();
      });

      const activeCard = page.locator('[data-task-id]').filter({ hasText: 'Active Task' }).first();
      await activeCard.waitFor({ state: 'visible', timeout: 5000 });
      await activeCard.click({ button: 'right' });

      // Original menu items still present.
      await expect(page.locator('[data-testid="context-edit-task"]')).toBeVisible();
      await expect(page.locator('[data-testid="context-archive-task"]')).toBeVisible();

      // Archived menu must NOT appear for active tasks.
      await expect(page.locator('[data-testid="archived-context-open-task"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Restore-to flow - DoneSwimlane surface
  // ---------------------------------------------------------------------------

  test('DoneSwimlane preview: restore-to calls tasks.unarchive with correct id and swimlaneId', async () => {
    // The lane ID is derived from DEFAULT_SWIMLANES in the init script:
    // 'lane-acm-' + name.toLowerCase().replace(/\s+/g, '-')
    const TODO_LANE_ID = 'lane-acm-to-do';

    const { browser, page } = await launchWithArchivedTask();
    try {
      const compactCard = page.locator('[data-task-id="' + TASK_ID + '"]').first();
      await compactCard.waitFor({ state: 'visible', timeout: 10000 });

      await compactCard.click({ button: 'right' });

      // Menu is open - wait for the restore-to section to appear.
      const firstRestoreItem = page.locator('[data-testid="archived-context-restore-to"]').first();
      await firstRestoreItem.waitFor({ state: 'visible', timeout: 5000 });

      // Click the "To Do" restore target by filtering on lane name text.
      await page.locator('[data-testid="archived-context-restore-to"]').filter({ hasText: 'To Do' }).click();

      // tasks.unarchive must have been called with the correct payload.
      await expect.poll(() => readTaskUnarchivedCalls(page)).toContainEqual({
        id: TASK_ID,
        targetSwimlaneId: TODO_LANE_ID,
      });

      // The menu closes after selection.
      await expect(page.locator('[data-testid="archived-context-open-task"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Restore-to flow - CompletedTasksDialog surface
  // ---------------------------------------------------------------------------

  test('CompletedTasksDialog: restore-to calls tasks.unarchive with correct id and swimlaneId', async () => {
    const TODO_LANE_ID = 'lane-acm-to-do';

    const { browser, page } = await launchWithArchivedTask();
    try {
      // Open the CompletedTasksDialog via the "View all" button in the Done swimlane.
      const viewAllButton = page.locator('[data-testid="view-all-completed"]');
      await viewAllButton.waitFor({ state: 'visible', timeout: 10000 });
      await viewAllButton.click();

      const dialog = page.locator('[data-testid="completed-tasks-dialog"]');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });

      // Right-click the task row.
      const row = page.locator('[data-testid="completed-task-row"]').first();
      await row.waitFor({ state: 'visible', timeout: 5000 });
      await row.click({ button: 'right' });

      // Wait for the context menu to appear (separate wiring path from DoneSwimlane).
      const firstRestoreItem = page.locator('[data-testid="archived-context-restore-to"]').first();
      await firstRestoreItem.waitFor({ state: 'visible', timeout: 5000 });

      // Click the "To Do" restore target.
      await page.locator('[data-testid="archived-context-restore-to"]').filter({ hasText: 'To Do' }).click();

      // handleRestore calls unarchiveTask which calls window.electronAPI.tasks.unarchive.
      await expect.poll(() => readTaskUnarchivedCalls(page)).toContainEqual({
        id: TASK_ID,
        targetSwimlaneId: TODO_LANE_ID,
      });

      // Menu closed after selection.
      await expect(page.locator('[data-testid="archived-context-open-task"]')).not.toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // worktree_path truthy -> Changes item is shown
  // ---------------------------------------------------------------------------

  test('worktree_path set: Changes menu item is visible in context menu', async () => {
    const { browser, page } = await launchWithWorktreeArchivedTask();
    try {
      const compactCard = page.locator('[data-task-id="task-acm-worktree"]').first();
      await compactCard.waitFor({ state: 'visible', timeout: 10000 });

      await compactCard.click({ button: 'right' });

      // The Changes item must be visible when worktree_path is set.
      await expect(page.locator('[data-testid="archived-context-show-changes"]')).toBeVisible();

      // The other items also appear as a sanity check.
      await expect(page.locator('[data-testid="archived-context-open-task"]')).toBeVisible();
      await expect(page.locator('[data-testid="archived-context-delete-task"]')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Escape closes the context menu
  // ---------------------------------------------------------------------------

  test('Escape key closes the context menu', async () => {
    const { browser, page } = await launchWithArchivedTask();
    try {
      const compactCard = page.locator('[data-task-id="' + TASK_ID + '"]').first();
      await compactCard.waitFor({ state: 'visible', timeout: 10000 });

      await compactCard.click({ button: 'right' });

      // Menu is open.
      await expect(page.locator('[data-testid="archived-context-open-task"]')).toBeVisible();

      // Dispatch Escape at the document level. ArchivedTaskContextMenu registers
      // a 'keydown' listener on document (capture phase) to handle this.
      // We do NOT use page.keyboard.press('Escape') here because if an xterm
      // widget is focused it would consume the key before it reaches our handler.
      await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      // Menu must close.
      await page.locator('[data-testid="archived-context-open-task"]').waitFor({ state: 'hidden', timeout: 3000 });
    } finally {
      await browser.close();
    }
  });
});
