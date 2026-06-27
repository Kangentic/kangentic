/**
 * UI tests for the confirmation dialog when moving a task to the Done column.
 *
 * Moving to Done deletes the local worktree (branch + session history are
 * preserved). A confirmation dialog appears ONLY when the git probe reports
 * pending changes (hasPendingChanges: true) OR the probe throws (treated as
 * dirty). A clean worktree (probe returns hasPendingChanges: false) never shows
 * the dialog and proceeds directly to archive. Tasks with no worktree_path
 * never probe and never show the dialog.
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

const PROJECT_ID = 'proj-done-confirm';
const TASK_ID = 'task-done-confirm';

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

function makePreConfig(options: {
  pendingChanges?: { uncommittedFileCount: number; unpushedCommitCount: number; currentBranch?: string | null };
  // Override the task's stored branch_name. Defaults to 'ready-to-ship-abcd1234'.
  // Pass null to simulate a task that was created without a branch (edge case
  // tested by the null-displayBranch + unpushed-commits scenario).
  branchName?: string | null;
  // When false, a project-config override turns git.autoCleanup off so the Done
  // move keeps the branch. The dialog then states the branch is kept and never
  // warns about only-local commits. Defaults to the mock global (true).
  autoCleanup?: boolean;
} = {}): string {
  // Project-config override applied via projectConfigs so config.get() (which
  // merges the current project's overrides) returns the desired autoCleanup.
  const autoCleanupOverride = options.autoCleanup === false
    ? `state.projectConfigs['/mock/done-confirm-test'] = { git: { autoCleanup: false } };`
    : '';
  const pendingChanges = options.pendingChanges;
  const currentBranchLiteral = pendingChanges && pendingChanges.currentBranch !== undefined
    ? JSON.stringify(pendingChanges.currentBranch)
    : 'null';
  const pendingChangesOverride = pendingChanges
    ? `
      window.electronAPI.git.checkPendingChanges = async function () {
        return {
          hasPendingChanges: ${pendingChanges.uncommittedFileCount > 0 || pendingChanges.unpushedCommitCount > 0},
          uncommittedFileCount: ${pendingChanges.uncommittedFileCount},
          unpushedCommitCount: ${pendingChanges.unpushedCommitCount},
          currentBranch: ${currentBranchLiteral},
        };
      };
    `
    : '';
  // branch_name is serialized as a JSON value so null renders as the literal
  // JSON null token and strings include their quotes.
  const branchNameLiteral = options.branchName !== undefined
    ? JSON.stringify(options.branchName)
    : JSON.stringify('ready-to-ship-abcd1234');
  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'Done Confirm Test',
        path: '/mock/done-confirm-test',
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

      var planningLane = state.swimlanes.find(function (s) { return s.name === 'Planning'; });
      var executingLane = state.swimlanes.find(function (s) { return s.name === 'Executing'; });
      if (planningLane && executingLane) {
        planningLane.plan_exit_target_id = executingLane.id;
      }

      state.tasks.push({
        id: '${TASK_ID}',
        title: 'Ready To Ship',
        description: 'A task about to move to Done',
        swimlane_id: laneIds['Executing'],
        position: 0,
        agent: 'claude',
        session_id: null,
        worktree_path: '/mock/worktrees/ready-to-ship',
        branch_name: ${branchNameLiteral},
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

      ${pendingChangesOverride}
      ${autoCleanupOverride}

      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page
    .locator('[data-testid="swimlane"]')
    .locator(`text=${taskTitle}`)
    .first();
  await card.waitFor({ state: 'visible', timeout: 5000 });

  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate((targetCol: string) => {
    document.querySelector(`[data-swimlane-name="${targetCol}"]`)?.scrollIntoView({ inline: 'nearest', behavior: 'instant' });
  }, targetColumn);

  // boundingBox() forces a layout flush, so the post-scroll geometry is
  // accurate without a fixed wait.
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes for drag');

  const startX = cardBox.x + cardBox.width / 2;
  const startY = cardBox.y + cardBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + 120;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // The 10px shift + steps satisfies dnd-kit's PointerSensor activation
  // distance; poll the store's activeTask instead of guessing with a sleep.
  await page.mouse.move(startX + 10, startY, { steps: 3 });
  await expect.poll(async () => page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { board: { getState: () => { activeTask: { id: string } | null } } };
    }).__zustandStores;
    return stores?.board.getState().activeTask !== null;
  }), { timeout: 2000 }).toBe(true);

  await page.mouse.move(endX, endY, { steps: 15 });
  // Done is the only target this helper drags to, and DoneSwimlane toggles
  // the `drop-zone-active` class via dnd-kit's isOver. Poll for it so the
  // drop fires only after the hover state is registered.
  await expect(target.locator('.drop-zone-active')).toBeVisible({ timeout: 2000 });

  await page.mouse.up();
  // Drop outcome (dialog, archive, etc.) varies per test - the caller's own
  // assertion does the post-drop wait.
}

test.describe('Move to Done - Delete Worktree Confirmation', () => {
  test('shows confirmation dialog when dropping a task on Done with pending changes', async () => {
    // A clean drop no longer shows the dialog; seed a dirty probe to trigger it.
    const { browser, page } = await launchWithState(
      makePreConfig({ pendingChanges: { uncommittedFileCount: 1, unpushedCommitCount: 0 } }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      await expect(executingColumn.locator('text=Ready To Ship')).toBeVisible();

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      const dialog = page.locator('text=Move to Done?');
      await expect(dialog).toBeVisible({ timeout: 3000 });

      // Dialog enumerates the trade-off as bullets: worktree deleted, branch
      // force-deleted (autoCleanup default on, with the branch name shown),
      // session kept. The "recreated from the branch" line is absent because the
      // branch is gone.
      await expect(page.locator('text=Local worktree will be deleted')).toBeVisible();
      await expect(page.locator('[data-testid="done-confirm-branch-fate"]')).toContainText('will be deleted');
      await expect(page.locator('text=ready-to-ship-abcd1234')).toBeVisible();
      await expect(page.locator('text=Session history will be kept')).toBeVisible();
      await expect(page.locator("text=the worktree will be recreated from the branch's last commit")).toHaveCount(0);

      await expect(page.locator('button:has-text("Move")').first()).toBeVisible();
      await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('keeps the branch and omits the commit-loss warning when autoCleanup is off', async () => {
    // With autoCleanup off the Done move keeps the branch, so only-local commits
    // are recoverable and must not warn; the dialog states the branch is kept and
    // offers worktree recreation. The dialog still opens for the uncommitted file.
    const { browser, page } = await launchWithState(
      makePreConfig({
        autoCleanup: false,
        pendingChanges: { uncommittedFileCount: 1, unpushedCommitCount: 0 },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('[data-testid="done-confirm-branch-fate"]')).toContainText('will be kept');
      await expect(page.locator("text=the worktree will be recreated from the branch's last commit")).toBeVisible();
      // No commit-loss warning when the branch survives.
      await expect(page.locator('[data-testid="done-confirm-unpushed"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('cancel restores the task to its original column', async () => {
    // Regression test for the cancel-restore path. Seed a dirty probe so the
    // dialog opens. After Cancel: card visible in Executing, no FlyingCard,
    // store cleared, task not archived.
    const { browser, page } = await launchWithState(
      makePreConfig({ pendingChanges: { uncommittedFileCount: 1, unpushedCommitCount: 0 } }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });

      await page.locator('button:has-text("Cancel")').click();

      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 3000 });

      // Card must be re-inserted into its source lane.
      const executingColumn = page.locator('[data-swimlane-name="Executing"]');
      await expect(executingColumn.locator('text=Ready To Ship')).toBeVisible();

      // FlyingCard must be gone.
      await expect(page.locator('.flying-card')).toHaveCount(0);

      // Store must be fully cleared.
      const storeState = await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => {
                completingTask: unknown;
                completingTaskIds: Set<string>;
              };
            };
          };
        }).__zustandStores;
        if (!stores) throw new Error('window.__zustandStores not exposed');
        const state = stores.board.getState();
        return {
          completingTask: state.completingTask,
          completingTaskIdsSize: state.completingTaskIds.size,
        };
      });
      expect(storeState.completingTask).toBeNull();
      expect(storeState.completingTaskIdsSize).toBe(0);

      // Task must NOT be archived.
      const isArchived = await page.evaluate(async (taskId: string) => {
        const archived = await (window as unknown as {
          electronAPI: { tasks: { listArchived: () => Promise<{ id: string }[]> } };
        }).electronAPI.tasks.listArchived();
        return archived.some((archivedTask) => archivedTask.id === taskId);
      }, TASK_ID);
      expect(isArchived).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('no dialog when the worktree is clean', async () => {
    // A clean probe (hasPendingChanges: false) must never show the dialog -
    // the task archives directly via the animated path.
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      // No confirmation dialog at all.
      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 2000 });

      // Task must end up archived.
      await expect.poll(async () => page.evaluate(async (taskId: string) => {
        const archived = await (window as unknown as {
          electronAPI: { tasks: { listArchived: () => Promise<{ id: string }[]> } };
        }).electronAPI.tasks.listArchived();
        return archived.some((archivedTask) => archivedTask.id === taskId);
      }, TASK_ID), { timeout: 5000 }).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('pending uncommitted files force the dialog', async () => {
    // A dirty worktree (uncommitted files) must trigger confirmation so the
    // user can approve the destructive delete.
    const { browser, page } = await launchWithState(
      makePreConfig({
        pendingChanges: { uncommittedFileCount: 3, unpushedCommitCount: 0 },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=3 uncommitted files will be lost')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('pending unpushed commits force the dialog', async () => {
    const { browser, page } = await launchWithState(
      makePreConfig({
        pendingChanges: { uncommittedFileCount: 0, unpushedCommitCount: 2 },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      // autoCleanup is on (mock default), so the branch is deleted and only-local
      // commits are genuine loss. Use the testid because the branch name renders
      // in a nested <code>, splitting the text node.
      const unpushed = page.locator('[data-testid="done-confirm-unpushed"]');
      await expect(unpushed).toContainText('2 commits exist only on');
      await expect(unpushed).toContainText('will be lost when the branch is deleted');
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // git failure catch path
  //
  // When checkPendingChanges throws, the catch block treats it as hasPendingChanges
  // true. The dialog appears with the git-failure fallback copy.
  // ---------------------------------------------------------------------------
  test('git failure forces the dialog with the fallback warning copy', async () => {
    // Override checkPendingChanges to throw so the catch block fires. Even
    // with a clean worktree configured, the dialog must appear because git
    // failed and the worktree state is unknown.
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await page.evaluate(() => {
        (window as unknown as { electronAPI: { git: { checkPendingChanges: () => Promise<never> } } })
          .electronAPI.git.checkPendingChanges = async function () {
          throw new Error('git binary not found');
        };
      });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      // The dialog MUST appear - git failure should never be a silent skip.
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });

      // The git-failure fallback copy is rendered.
      await expect(page.locator('text=Unable to verify pending changes')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // requestDoneConfirmDirect path with pending counts
  //
  // When active.rect.current.initial is null (HMR / DOM destruction mid-drag)
  // the code falls back to requestDoneConfirmDirect instead of the animated
  // path. This test exercises that code path directly via the store action
  // without needing to simulate a real DOM destruction race.
  // ---------------------------------------------------------------------------
  test('requestDoneConfirmDirect with pending changes shows danger dialog', async () => {
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      // Drive the store directly to exercise the direct (non-animated) path.
      // This is equivalent to what useBoardDragDrop does when initialRect is null.
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores?: {
            board: {
              getState: () => {
                requestDoneConfirmDirect: (
                  task: { id: string; title: string; branch_name: string; worktree_path: string },
                  input: { taskId: string; targetSwimlaneId: string; targetPosition: number },
                  pendingChanges: { hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number; currentBranch: string | null; autoCleanup: boolean },
                ) => void;
              };
            };
          };
        }).__zustandStores;
        stores?.board.getState().requestDoneConfirmDirect(
          {
            id: 'task-done-confirm',
            title: 'Ready To Ship',
            branch_name: 'ready-to-ship-abcd1234',
            worktree_path: '/mock/worktrees/ready-to-ship',
          },
          {
            taskId: 'task-done-confirm',
            targetSwimlaneId: 'lane-done',
            targetPosition: 0,
          },
          { hasPendingChanges: true, uncommittedFileCount: 2, unpushedCommitCount: 1, currentBranch: null, autoCleanup: true },
        );
      });

      // The dialog should appear with the correct content.
      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=2 uncommitted files will be lost')).toBeVisible();
      // Singular "exists" for a single at-risk commit (branch force-deleted).
      const unpushed = page.locator('[data-testid="done-confirm-unpushed"]');
      await expect(unpushed).toContainText('1 commit exists only on');
      await expect(unpushed).toContainText('will be lost when the branch is deleted');
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Regression spy: checkPendingChanges always fires for worktree tasks
  //
  // For every worktree task dropped on Done, the probe must fire. A future
  // short-circuit that skips the probe based on any config flag or clean-state
  // assumption would silently remove the safety net.
  // ---------------------------------------------------------------------------
  test('the probe always fires for worktree tasks', async () => {
    const { browser, page } = await launchWithState(makePreConfig());

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      // Replace checkPendingChanges with a call-counting spy that returns a
      // clean result so no dialog appears (verifying the probe fired without
      // changing the observable drag outcome).
      await page.evaluate(() => {
        (window as unknown as {
          __checkPendingChangesCalled: boolean;
          electronAPI: { git: { checkPendingChanges: () => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number; currentBranch: string | null }> } };
        }).__checkPendingChangesCalled = false;

        const originalFn = (window as unknown as {
          electronAPI: { git: { checkPendingChanges: () => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number; currentBranch: string | null }> } };
        }).electronAPI.git.checkPendingChanges;

        (window as unknown as {
          electronAPI: { git: { checkPendingChanges: () => Promise<{ hasPendingChanges: boolean; uncommittedFileCount: number; unpushedCommitCount: number; currentBranch: string | null }> } };
        }).electronAPI.git.checkPendingChanges = async function (...args) {
          (window as unknown as { __checkPendingChangesCalled: boolean }).__checkPendingChangesCalled = true;
          return originalFn.apply(this, args as []);
        };
      });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      // No dialog because the probe returns clean.
      // (intentional fixed wait - we cannot poll for non-occurrence)
      await page.waitForTimeout(1000);
      await expect(page.locator('text=Move to Done?')).toBeHidden();

      // The probe MUST have fired.
      await expect.poll(async () => page.evaluate(
        () => (window as unknown as { __checkPendingChangesCalled: boolean }).__checkPendingChangesCalled,
      ), { timeout: 2000 }).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('no dialog when the task has no worktree to delete', async () => {
    // Tasks that go straight from To Do to Done never created a worktree;
    // there's nothing destructive about the move, so the dialog is suppressed.
    const noWorktreeConfig = `
      window.__mockPreConfigure(function (state) {
        var ts = new Date().toISOString();
        state.projects.push({
          id: '${PROJECT_ID}',
          name: 'No Worktree Test',
          path: '/mock/no-worktree-test',
          github_url: null,
          default_agent: 'claude',
          last_opened: ts,
          created_at: ts,
        });
        var laneIds = {};
        state.DEFAULT_SWIMLANES.forEach(function (s, i) {
          var id = 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-');
          laneIds[s.name] = id;
          state.swimlanes.push(Object.assign({}, s, { id: id, position: i, created_at: ts }));
        });
        state.tasks.push({
          id: '${TASK_ID}',
          title: 'Quick Done',
          description: 'A task that never created a worktree',
          swimlane_id: laneIds['Executing'],
          position: 0,
          agent: 'claude',
          session_id: null,
          worktree_path: null,
          branch_name: null,
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
        return { currentProjectId: '${PROJECT_ID}' };
      });
    `;
    const { browser, page } = await launchWithState(noWorktreeConfig);

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Quick Done', 'Done');

      // No dialog appeared
      await expect(page.locator('text=Move to Done?')).toBeHidden({ timeout: 2000 });
    } finally {
      await browser.close();
    }
  });

  test('names the worktree live branch over the stored slug', async () => {
    // The agent renamed the branch inside the worktree; the probe reports the
    // real branch. The dialog must show it, not the stale stored slug.
    const { browser, page } = await launchWithState(
      makePreConfig({
        pendingChanges: { uncommittedFileCount: 1, unpushedCommitCount: 0, currentBranch: 'agent-renamed-branch' },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });
      // The live branch is shown; the stored slug is not.
      await expect(page.locator('text=agent-renamed-branch')).toBeVisible();
      await expect(page.locator('text=ready-to-ship-abcd1234')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('styles both uncommitted files and at-risk commits as danger', async () => {
    // With autoCleanup on (mock default) the branch is force-deleted, so both
    // uncommitted files and only-local commits are genuinely destroyed: both red.
    const { browser, page } = await launchWithState(
      makePreConfig({
        pendingChanges: { uncommittedFileCount: 2, unpushedCommitCount: 3 },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });

      const uncommitted = page.locator('[data-testid="done-confirm-uncommitted"]');
      const unpushed = page.locator('[data-testid="done-confirm-unpushed"]');
      await expect(uncommitted).toBeVisible();
      await expect(unpushed).toBeVisible();
      await expect(uncommitted).toHaveClass(/text-red-400/);
      await expect(unpushed).toHaveClass(/text-red-400/);
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Null displayBranch + unpushed commits: edge case in BoardDialogs.tsx
  //
  // When BOTH task.branch_name and currentBranch are null, displayBranch is null.
  // The commit-loss bullet falls back to the generic "the local branch" wording,
  // and the branch-fate bullet (kept/deleted) is absent entirely because there is
  // no branch name to surface. This guards the `{displayBranch && (...)}` and
  // `branchCode ? ... : 'the local branch'` conditionals in BoardDialogs.tsx.
  // ---------------------------------------------------------------------------
  test('null displayBranch with unpushed commits omits branch clauses', async () => {
    // Seed a task with no branch_name AND a probe that returns currentBranch: null
    // but reports unpushed commits. Both branch references should be absent.
    const { browser, page } = await launchWithState(
      makePreConfig({
        branchName: null,
        pendingChanges: { uncommittedFileCount: 0, unpushedCommitCount: 4, currentBranch: null },
      }),
    );

    try {
      await page.locator('[data-swimlane-name="Done"]').waitFor({ state: 'visible', timeout: 15000 });

      await dragTaskToColumn(page, 'Ready To Ship', 'Done');

      await expect(page.locator('text=Move to Done?')).toBeVisible({ timeout: 3000 });

      // The commit-loss bullet must be visible (this is a pending-changes dialog).
      const unpushedBullet = page.locator('[data-testid="done-confirm-unpushed"]');
      await expect(unpushedBullet).toBeVisible();

      // The bullet uses the generic "the local branch" wording (no branch name).
      await expect(unpushedBullet).toContainText('exist only on the local branch');

      // No branch-fate bullet (kept/deleted) renders without a branch name.
      await expect(page.locator('[data-testid="done-confirm-branch-fate"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
