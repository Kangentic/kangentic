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

// The Branch row's trailing segment is a two-option radio group, Worktree or
// Project, not an on/off button: the "off" state has a name (the project
// folder), so it is offered as a named choice. State is read from aria-checked
// on each option, never from a styling class (cross-platform-parity.md).
test.describe('Worktree placement', () => {
  test('offers Worktree and Project in the New Task dialog', async () => {
    await openNewTaskDialog();

    const group = page.locator('[data-testid="worktree-placement"]');
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute('role', 'radiogroup');
    await expect(page.locator('[data-testid="worktree-option-worktree"]')).toHaveText('Worktree');
    await expect(page.locator('[data-testid="worktree-option-project"]')).toHaveText('Project');

    await closeDialog();
  });

  test('Worktree is selected by default when the global worktrees setting is ON', async () => {
    await openNewTaskDialog();

    await expect(page.locator('[data-testid="worktree-option-worktree"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-testid="worktree-option-project"]')).toHaveAttribute('aria-checked', 'false');

    await closeDialog();
  });

  test('choosing Project selects it and deselects Worktree', async () => {
    await openNewTaskDialog();

    await page.locator('[data-testid="worktree-option-project"]').click();

    await expect(page.locator('[data-testid="worktree-option-project"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-testid="worktree-option-worktree"]')).toHaveAttribute('aria-checked', 'false');

    await closeDialog();
  });

  test('choosing Worktree again reselects it', async () => {
    await openNewTaskDialog();

    const worktreeOption = page.locator('[data-testid="worktree-option-worktree"]');
    await page.locator('[data-testid="worktree-option-project"]').click();
    await expect(worktreeOption).toHaveAttribute('aria-checked', 'false');

    await worktreeOption.click();
    await expect(worktreeOption).toHaveAttribute('aria-checked', 'true');

    await closeDialog();
  });

  // The group is one tab stop with arrows moving the selection, which is what
  // role="radiogroup" promises a screen reader. The Home/End pair is covered by
  // the same handler; ArrowRight is enough to pin that the model is a radio
  // group and not two independent buttons.
  test('arrow keys move the selection within the group', async () => {
    await openNewTaskDialog();

    const worktreeOption = page.locator('[data-testid="worktree-option-worktree"]');
    const projectOption = page.locator('[data-testid="worktree-option-project"]');
    await worktreeOption.focus();
    await page.keyboard.press('ArrowRight');

    await expect(projectOption).toHaveAttribute('aria-checked', 'true');
    await expect(projectOption).toBeFocused();
    // The dialog is still open: the arrow was swallowed by the group, not the form.
    await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

    await closeDialog();
  });

  // The hint names WHERE the agent will run. With Project chosen, it states the
  // project folder and the branch the mock probe reports checked out there, in
  // the same quiet tone as every other hint. The old copy ("Agent will work
  // directly on main") named no folder and guessed the branch, which is how a
  // user filed two issues without finding the control.
  test('choosing Project states the project folder and its checked-out branch', async () => {
    await openNewTaskDialog();

    const hint = page.locator('[data-testid="task-branch-row"] ~ [data-testid="field-hint"]');
    await expect(hint).toContainText('Auto-generated branch will be created from');

    await page.locator('[data-testid="worktree-option-project"]').click();
    await expect(hint).toHaveText('Runs in the project folder on main');

    await closeDialog();
  });

  test('created task receives use_worktree: 0 when Project is chosen', async () => {
    await openNewTaskDialog();

    // Fill in title
    await page.locator('input[placeholder="Task title"]').fill('Worktree Off Task');

    await page.locator('[data-testid="worktree-option-project"]').click();

    // Create the task
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Verify the task was created with use_worktree = 0
    const taskData = await page.evaluate(() => {
      return window.electronAPI.tasks.list();
    });
    const task = taskData.find((t: { title: string }) => t.title === 'Worktree Off Task');
    expect(task).toBeDefined();
    expect(task.use_worktree).toBe(0);
  });

  test('created task has use_worktree: null when the placement is untouched', async () => {
    await openNewTaskDialog();

    // Fill in title without touching the placement
    await page.locator('input[placeholder="Task title"]').fill('Default Worktree Task');

    // Create the task
    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    // Verify the task was created with use_worktree = null (follows global)
    const taskData = await page.evaluate(() => {
      return window.electronAPI.tasks.list();
    });
    const task = taskData.find((t: { title: string }) => t.title === 'Default Worktree Task');
    expect(task).toBeDefined();
    expect(task.use_worktree).toBeNull();
  });

  // Re-clicking the already selected option must not pin an explicit override
  // on a task that is following the global setting.
  test('created task keeps use_worktree: null when the selected option is clicked again', async () => {
    await openNewTaskDialog();

    await page.locator('input[placeholder="Task title"]').fill('Reclick Worktree Task');
    await page.locator('[data-testid="worktree-option-worktree"]').click();

    await page.locator('button[type="submit"]:has-text("Create")').click();
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const taskData = await page.evaluate(() => {
      return window.electronAPI.tasks.list();
    });
    const task = taskData.find((t: { title: string }) => t.title === 'Reclick Worktree Task');
    expect(task).toBeDefined();
    expect(task.use_worktree).toBeNull();
  });

  test('task detail edit mode shows the placement control for a pre-session task', async () => {
    // Create a task first
    await createTask(page, 'Detail Toggle Task');

    // Click on the task card to open detail dialog
    // To Do tasks open directly in edit mode
    const taskCard = page.locator('text=Detail Toggle Task').first();
    await taskCard.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible' });

    // The placement control is visible in edit mode (no session = pre-session)
    await expect(page.locator('[data-testid="worktree-placement"]')).toBeVisible();

    // Close by pressing Escape
    await page.keyboard.press('Escape');
  });

  // The edit form wires its own `effectiveWorktree` / `setUseWorktree` pair into
  // TaskBranchRow, separately from the New Task dialog. Visibility alone (the
  // test above) would still pass if that pair were mis-wired or handed a no-op
  // handler, so this pins the state readout and the click.
  test('task detail edit mode placement reflects and flips worktree state', async () => {
    const uniqueTitle = `Detail Toggle State ${Date.now()}`;
    await createTask(page, uniqueTitle);

    const taskCard = page.locator('[data-testid="swimlane"]').locator(`text=${uniqueTitle}`).first();
    await taskCard.click();
    const detailDialog = page.locator('[data-testid="task-detail-dialog"]');
    await detailDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Global worktrees setting is ON in the default config, and the task has no
    // explicit override, so the effective state starts on Worktree.
    const worktreeOption = detailDialog.locator('[data-testid="worktree-option-worktree"]');
    const projectOption = detailDialog.locator('[data-testid="worktree-option-project"]');
    await expect(worktreeOption).toHaveAttribute('aria-checked', 'true');

    await projectOption.click();
    await expect(projectOption).toHaveAttribute('aria-checked', 'true');
    await expect(worktreeOption).toHaveAttribute('aria-checked', 'false');

    // Changing it leaves the form dirty, so Escape raises the discard confirm.
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await detailDialog.waitFor({ state: 'hidden', timeout: 3000 });
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

    // The Worktree | Project control should be visible
    await expect(page.locator('[data-testid="worktree-placement"]')).toBeVisible();

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

    // The edit form is dirty (custom branch typed), so Escape opens the discard
    // confirm; Discard closes it and leaves a clean state for the next test.
    await page.keyboard.press('Escape');
    await page.locator('button:has-text("Discard")').click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'hidden', timeout: 3000 });
  });

  test('cancel resets custom branch name', async () => {
    await createTask(page, 'Cancel Branch Task');

    const taskCard = page.locator('[data-testid="swimlane"]').locator('text=Cancel Branch Task').first();
    await taskCard.click();
    const detailDialog = page.locator('[data-testid="task-detail-dialog"]');
    await detailDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Type a custom branch name
    const branchInput = page.locator('[data-testid="custom-branch-name-input"]');
    await branchInput.fill('feature/will-be-cancelled');

    // Cancel closes the window (initialEdit=true + no session -> onClose() is called).
    await page.locator('button:has-text("Cancel")').click();

    // Wait for the window to fully unmount before re-opening it. Without this,
    // the closing-animation window's task-detail-dialog is still in DOM when the
    // card click opens a new one, and the assertion resolves to the old stale input.
    await detailDialog.waitFor({ state: 'hidden', timeout: 3000 });

    // Re-open the task - the new window has fresh state from the stored task data.
    await taskCard.click();
    await detailDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Branch input should be empty (reset to original null value, never saved)
    const branchInputAgain = page.locator('[data-testid="custom-branch-name-input"]');
    await expect(branchInputAgain).toHaveValue('');

    await page.keyboard.press('Escape');
    await detailDialog.waitFor({ state: 'hidden', timeout: 3000 });
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

  // Past To Do the branch NAME is fixed, so TaskBranchRow renders its second
  // shape: the field is titled "Base branch" rather than "Branch", and the
  // Worktree | Project segment appears only while the task has no worktree on
  // disk. The sibling test above checks the name input is gone but asserts
  // neither of those, so both would survive being inverted without it.
  test('non-backlog task edit labels the field Base branch and keeps the placement control', async () => {
    const uniqueTitle = `Base Branch Shape ${Date.now()}`;
    await createTask(page, uniqueTitle);

    await page.evaluate(async (title) => {
      const api = (window as any).electronAPI;
      const stores = (window as any).__zustandStores;
      const tasks = await api.tasks.list();
      const task = tasks.find((t: { title: string }) => t.title === title);
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
    }, uniqueTitle);

    const taskCard = page.locator('[data-swimlane-name="Planning"]').locator(`text=${uniqueTitle}`).first();
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    await taskCard.click();
    await page.locator('.fixed input[placeholder="Task title"]').waitFor({ state: 'visible' });

    // "Base branch", not "Branch" - there is no editable branch name here. The
    // exact match is what carries this: it fails if the label reverts to
    // "Branch", so no page-wide negative assertion is needed alongside it.
    await expect(page.getByText('Base branch', { exact: true })).toBeVisible();

    // The task has no worktree_path yet, so the placement segment still renders.
    // The sibling test below covers the opposite arm, once worktree_path is set.
    await expect(page.locator('[data-testid="worktree-placement"]')).toBeVisible();

    await page.keyboard.press('Escape');
  });

  // Closes the gap the test above leaves open: once the task has a
  // worktree_path (a worktree already materialized on disk), the placement
  // segment must disappear entirely - offering a choice about a worktree that
  // already exists doesn't make sense. This pins the
  // `showWorktree={!task.worktree_path}` CALL SITE in TaskDetailEditForm, not
  // just TaskBranchRow's internal `showWorktree` branch: a unit test that
  // called `TaskBranchRow({ showWorktree: false })` directly would pass
  // unchanged even if the call site computed the wrong boolean (e.g. inverted
  // to `showWorktree={!!task.worktree_path}`).
  test('non-backlog task edit hides the placement control once the task has a worktree_path', async () => {
    const uniqueTitle = `Worktree Path Hides Toggle ${Date.now()}`;
    await createTask(page, uniqueTitle);

    await page.evaluate(async (title) => {
      const api = (window as any).electronAPI;
      const stores = (window as any).__zustandStores;
      const tasks = await api.tasks.list();
      const task = tasks.find((t: { title: string }) => t.title === title);
      const swimlanes = await api.swimlanes.list();
      const planning = swimlanes.find((s: { name: string }) => s.name === 'Planning');
      if (task && planning) {
        await api.tasks.move({
          taskId: task.id,
          targetSwimlaneId: planning.id,
          targetPosition: 0,
        });
        // Simulate a worktree that has already materialized on disk for this
        // task (the real main process sets this once the worktree checkout
        // completes; the mock never sets it on its own).
        await api.tasks.update({
          id: task.id,
          worktree_path: '/mock/worktrees/' + task.id.slice(0, 8),
        });
        await stores.board.getState().loadBoard();
      }
    }, uniqueTitle);

    const taskCard = page.locator('[data-swimlane-name="Planning"]').locator(`text=${uniqueTitle}`).first();
    await expect(taskCard).toBeVisible({ timeout: 5000 });
    await taskCard.click();
    const detailDialog = page.locator('[data-testid="task-detail-dialog"]');
    await detailDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Positive anchor: the branch row itself rendered. Without this, the
    // negative assertion below would pass vacuously if the whole row failed
    // to render or the form landed in a different mode.
    await expect(detailDialog.locator('[data-testid="branch-picker-chip"]')).toBeVisible();

    // The assertion this test exists for.
    await expect(detailDialog.locator('[data-testid="worktree-placement"]')).not.toBeVisible();

    // No edits were made, so Escape closes directly (no discard confirm).
    // Wait for the window to fully unmount so it can't leak into a later test
    // in this shared-page suite (cross-platform-parity.md).
    await page.keyboard.press('Escape');
    await detailDialog.waitFor({ state: 'hidden', timeout: 3000 });
  });
});

test.describe('Save double-submit guard', () => {
  test('Save disables while in flight and calls tasks.update exactly once', async () => {
    const uniqueTitle = `Save Double Submit Guard ${Date.now()}`;

    // Create a To Do task - To Do tasks open directly in edit mode when clicked.
    await createTask(page, uniqueTitle);

    // Open the task detail dialog by clicking the card.
    const taskCard = page.locator('[data-testid="swimlane"]').locator(`text=${uniqueTitle}`).first();
    await taskCard.click();
    const detailDialog = page.locator('[data-testid="task-detail-dialog"]');
    await detailDialog.waitFor({ state: 'visible' });

    // Change the title so `executeSave` takes the non-switchBranch path and
    // calls `updateTask`, which hits `tasks.update` on the IPC mock.
    const titleInput = detailDialog.locator('input[placeholder="Task title"]');
    await titleInput.fill(`${uniqueTitle} edited`);

    // Arm the deferred hook and reset the call counter. While deferred is true
    // the next tasks.update call will suspend until __mockTaskUpdateResolve() fires,
    // giving us a deterministic window to observe the in-flight (saving) state.
    await page.evaluate(() => {
      const mock = window as unknown as {
        __mockTaskUpdateCallCount: number;
        __mockTaskUpdateDeferred: boolean;
      };
      mock.__mockTaskUpdateCallCount = 0;
      mock.__mockTaskUpdateDeferred = true;
    });

    // The footer's submit button. Its label stays "Save" while in flight: the
    // button disables rather than relabels, so the footer never changes shape.
    const saveButton = detailDialog.locator('button', { hasText: /^Save$/ });

    await saveButton.click();

    // The button must disable while the update is pending and keep its label:
    // a "Saving..." relabel grew the button and shifted Cancel for the length
    // of the round trip. This verifies the primary UI guard: React re-rendered
    // with saving=true and the button now has the disabled attribute.
    await expect(saveButton).toBeDisabled();
    await expect(saveButton).toHaveText('Save');

    // Exactly one tasks.update IPC call must have fired.
    const callsDuringFlight = await page.evaluate(
      () => (window as unknown as { __mockTaskUpdateCallCount: number }).__mockTaskUpdateCallCount,
    );
    expect(callsDuringFlight).toBe(1);

    // Simulate a stray second activation while in-flight: React has already
    // rendered `saving=true`, so the button is disabled. The JS guard
    // `if (saving) return;` in `executeSave` is the backstop for programmatic
    // re-entry (e.g. the `pendingSaveRef` path or a keyboard race). Verify it by
    // dispatching a click event directly to the button element -- this bypasses
    // the browser's native disabled-element click suppression and fires through
    // React's root-level event delegation. If the guard is absent, a second
    // `tasks.update` IPC call would be fired.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Save' && b.disabled,
      );
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });

    const callsAfterSecondActivation = await page.evaluate(
      () => (window as unknown as { __mockTaskUpdateCallCount: number }).__mockTaskUpdateCallCount,
    );
    expect(callsAfterSecondActivation).toBe(1);

    // Resolve the pending update. For a To Do task with no session, executeSave
    // calls onClose() after updateTask resolves, so the dialog should close.
    await page.evaluate(() => {
      (window as unknown as { __mockTaskUpdateResolve: () => void }).__mockTaskUpdateResolve();
    });
    await detailDialog.waitFor({ state: 'hidden', timeout: 3000 });

    // Final call count must still be exactly 1.
    const finalCalls = await page.evaluate(
      () => (window as unknown as { __mockTaskUpdateCallCount: number }).__mockTaskUpdateCallCount,
    );
    expect(finalCalls).toBe(1);
  });
});

test.describe('Create double-submit guard', () => {
  test('Create disables while in flight and creates exactly one task', async () => {
    const uniqueTitle = `Double Submit Guard ${Date.now()}`;
    await openNewTaskDialog();
    await page.locator('input[placeholder="Task title"]').fill(uniqueTitle);

    // Arm the deferred-create hook: the create IPC hangs until we resolve it,
    // giving us a deterministic window to observe the in-flight state (no timing
    // assumptions). Reset the call counter so the assertions are isolated.
    await page.evaluate(() => {
      const mock = window as unknown as { __mockTaskCreateCallCount: number; __mockTaskCreateDeferred: boolean };
      mock.__mockTaskCreateCallCount = 0;
      mock.__mockTaskCreateDeferred = true;
    });

    // type="submit" uniquely identifies Create (Cancel is type="button").
    const createButton = page.locator('button[type="submit"]');
    await createButton.click();

    // The button disables while the create is pending and keeps its label, so
    // the footer does not change shape on the press.
    await expect(createButton).toBeDisabled();
    await expect(createButton).toHaveText('Create');

    const callsDuringFlight = await page.evaluate(
      () => (window as unknown as { __mockTaskCreateCallCount: number }).__mockTaskCreateCallCount,
    );
    expect(callsDuringFlight).toBe(1);

    // Simulate a stray second activation landing while the first create is still
    // in flight (the reported double-click / Enter-then-click). The handler's
    // `submitting` guard must swallow it: no second create IPC.
    await page.evaluate(() => {
      const submitButton = document.querySelector('button[type="submit"]');
      submitButton?.closest('form')?.requestSubmit();
    });
    const callsAfterSecondActivation = await page.evaluate(
      () => (window as unknown as { __mockTaskCreateCallCount: number }).__mockTaskCreateCallCount,
    );
    expect(callsAfterSecondActivation).toBe(1);

    // Resolve the pending create; the dialog closes and exactly one task exists.
    await page.evaluate(() => {
      (window as unknown as { __mockTaskCreateResolve: () => void }).__mockTaskCreateResolve();
    });
    await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 3000 });

    const finalCalls = await page.evaluate(
      () => (window as unknown as { __mockTaskCreateCallCount: number }).__mockTaskCreateCallCount,
    );
    expect(finalCalls).toBe(1);

    const matchingCount = await page.evaluate(async (title) => {
      const list = await window.electronAPI.tasks.list();
      return list.filter((task: { title: string }) => task.title === title).length;
    }, uniqueTitle);
    expect(matchingCount).toBe(1);
  });
});

// Own page, not the shared one above: the path probe is cached per project
// path for 15s, so a blocked probe would leak into every later test that opens
// the dialog on the same project.
test.describe('Structural worktree blockers', () => {
  test('a project that is itself a worktree gets a disabled Worktree option and a hint that says so', async () => {
    const { browser: ownBrowser, page: ownPage } = await launchPage();
    try {
      // Before the project exists, so its very first probe reports the nesting.
      await ownPage.evaluate(() => {
        (window as unknown as { __mockProbePathOverrides: Record<string, unknown> }).__mockProbePathOverrides = { isInsideWorktree: true };
      });
      await createProject(ownPage, `Nested Worktree Project ${Date.now()}`);
      await waitForBoard(ownPage);

      await ownPage.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
      await ownPage.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });

      // The control cannot promise a worktree the manager will skip: the
      // Worktree option is disabled with the reason as its tooltip, and
      // Project reads selected.
      const worktreeOption = ownPage.locator('[data-testid="worktree-option-worktree"]');
      await expect(worktreeOption).toBeDisabled();
      await expect(worktreeOption).toHaveAttribute('aria-checked', 'false');
      await expect(worktreeOption).toHaveAttribute('title', /itself a git worktree/);
      await expect(ownPage.locator('[data-testid="worktree-option-project"]')).toHaveAttribute('aria-checked', 'true');

      const hint = ownPage.locator('[data-testid="task-branch-row"] ~ [data-testid="field-hint"]');
      await expect(hint).toHaveText('Runs in the project folder');
      // The auto-branch placeholder is gone too: no branch will be created.
      await expect(ownPage.locator('[data-testid="custom-branch-name-input"]')).toHaveAttribute('placeholder', 'main');
    } finally {
      await ownBrowser.close();
    }
  });

  // `SegmentedControl.focusOption` calls `onChange` for whichever index its
  // keydown handler lands on. If a regression ever made that arithmetic land
  // on a disabled index (the blocked Worktree option here, the only other
  // option besides the selected Project), it would write `use_worktree: true`
  // for a project the worktree manager will refuse to give one, silently.
  //
  // `aria-checked` cannot carry this red-green: WorktreePlacementControl pins
  // `selected` to `'project'` whenever `blockedReason` is set, so it renders
  // Project checked whether or not a bad keypress already wrote `worktree`
  // into the parent's state. The observable harm is the CREATED TASK's
  // `use_worktree`, so that is what this test asserts on.
  test('keyboard nav never selects the disabled Worktree option, and the created task keeps use_worktree: null', async () => {
    const { browser: ownBrowser, page: ownPage } = await launchPage();
    try {
      await ownPage.evaluate(() => {
        (window as unknown as { __mockProbePathOverrides: Record<string, unknown> }).__mockProbePathOverrides = { isInsideWorktree: true };
      });
      const uniqueTitle = `Keyboard Nav Blocked Worktree ${Date.now()}`;
      await createProject(ownPage, `Nested Worktree Keyboard ${Date.now()}`);
      await waitForBoard(ownPage);

      await ownPage.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
      const titleInput = ownPage.locator('input[placeholder="Task title"]');
      await titleInput.waitFor({ state: 'visible' });
      await titleInput.fill(uniqueTitle);

      const projectOption = ownPage.locator('[data-testid="worktree-option-project"]');
      const worktreeOption = ownPage.locator('[data-testid="worktree-option-worktree"]');
      await expect(projectOption).toHaveAttribute('aria-checked', 'true');
      await projectOption.focus();

      // Project is the only enabled option, so every one of these must be a
      // no-op: `nextEnabled`/`endEnabled` find no other enabled candidate and
      // return null, so `focusOption` (and its `onChange` call) never runs.
      for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
        await ownPage.keyboard.press(key);
        await expect(projectOption).toHaveAttribute('aria-checked', 'true');
        await expect(worktreeOption).toHaveAttribute('aria-checked', 'false');
      }

      const createButton = ownPage.locator('button[type="submit"]:has-text("Create")');
      await createButton.click();
      await titleInput.waitFor({ state: 'hidden', timeout: 3000 });

      const taskData = await ownPage.evaluate(() => window.electronAPI.tasks.list());
      const task = taskData.find((candidate: { title: string }) => candidate.title === uniqueTitle);
      expect(task).toBeDefined();
      // The placement was never touched: no keypress landed on the disabled
      // option, so no override was ever written.
      expect(task.use_worktree).toBeNull();
    } finally {
      await ownBrowser.close();
    }
  });
});
