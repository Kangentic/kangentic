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

  // The on/off state is read from aria-pressed, not from a styling class. The
  // control used to signal "off" with `line-through` on an inner span, so these
  // asserted on that class; a strikethrough reads as "deleted" rather than
  // "off", so the state now lives on the attribute the control already needs for
  // accessibility. Asserting programmatic state over pixels is also what
  // .claude/rules/cross-platform-parity.md asks for.
  test('toggle defaults to enabled when global worktrees setting is ON', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="worktree-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await closeDialog();
  });

  test('clicking toggle switches to disabled state', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="worktree-toggle"]');
    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await closeDialog();
  });

  test('clicking toggle twice returns to enabled state', async () => {
    await openNewTaskDialog();

    const toggle = page.locator('[data-testid="worktree-toggle"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

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

  test('created task has use_worktree: null when not toggled', async () => {
    await openNewTaskDialog();

    // Fill in title without touching the toggle
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

  // The edit form wires its own `effectiveWorktree` / `setUseWorktree` pair into
  // TaskBranchRow, separately from the New Task dialog. Visibility alone (the
  // test above) would still pass if that pair were mis-wired or handed a no-op
  // handler, so this pins the state readout and the click.
  test('task detail edit mode toggle reflects and flips worktree state', async () => {
    const uniqueTitle = `Detail Toggle State ${Date.now()}`;
    await createTask(page, uniqueTitle);

    const taskCard = page.locator('[data-testid="swimlane"]').locator(`text=${uniqueTitle}`).first();
    await taskCard.click();
    const detailDialog = page.locator('[data-testid="task-detail-dialog"]');
    await detailDialog.waitFor({ state: 'visible', timeout: 5000 });

    // Global worktrees setting is ON in the default config, and the task has no
    // explicit override, so the effective state starts enabled.
    const toggle = detailDialog.locator('[data-testid="worktree-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Toggling leaves the form dirty, so Escape raises the discard confirm.
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
  // worktree segment appears only while the task has no worktree on disk. The
  // sibling test above checks the name input is gone but asserts neither of
  // those, so both would survive being inverted without it.
  test('non-backlog task edit labels the field Base branch and keeps the worktree toggle', async () => {
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

    // The task has no worktree_path yet, so the worktree segment still renders.
    // NOTE: this pins the toggle's PRESENCE in the fixed-name shape, not the
    // `showWorktree={!task.worktree_path}` condition itself - the mock never
    // sets worktree_path, so the hidden arm stays unverified.
    await expect(page.locator('[data-testid="worktree-toggle"]')).toBeVisible();

    await page.keyboard.press('Escape');
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

    // Locate the Save button using a regex that matches both "Save" (idle) and
    // "Saving..." (in-flight). The button lives in the dialog footer and is the
    // only footer button whose label starts with "Sav". This avoids the locator
    // becoming stale when the text flips from "Save" to "Saving..." on click.
    const saveButton = detailDialog.locator('button', { hasText: /^Sav/ });

    await saveButton.click();

    // The button must disable and show "Saving..." while the update is pending.
    // This verifies the primary UI guard: React re-rendered with saving=true and
    // the button now has the disabled attribute.
    await expect(saveButton).toBeDisabled();
    await expect(saveButton).toHaveText('Saving...');

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
        (b) => b.textContent === 'Saving...',
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

    // type="submit" uniquely identifies Create (Cancel is type="button") and
    // stays stable when its label flips to "Creating...".
    const createButton = page.locator('button[type="submit"]');
    await createButton.click();

    // The button disables and reflects the in-flight state while the create is
    // pending.
    await expect(createButton).toBeDisabled();
    await expect(createButton).toHaveText('Creating...');

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
