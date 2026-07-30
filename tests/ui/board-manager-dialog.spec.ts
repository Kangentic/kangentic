/**
 * UI tests for the BoardManagerDialog (V3 Focused design).
 *
 * Covers:
 * - Open from swimlane header preselects that column tab
 * - Tab switching preserves drafts (dirty dot survives swap)
 * - Save fires update IPC once per dirty column
 * - Cancel-with-dirty triggers the Discard confirm modal
 * - Conditional "After Plan Mode" row only renders for plan permission
 * - Delete hidden for role-pinned (To Do, Done) columns
 * - Add column inserts a new draft tab inline; validation blocks empty save
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `BoardMgr Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);
  await waitForBoard(page);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openManagerByHeader(columnName: string) {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('h3', { hasText: 'Edit Columns' })).toBeVisible();
}

async function closeManager() {
  const cancelBtn = page.locator('[data-testid="board-manager-dialog"]').getByRole('button', { name: 'Cancel' });
  await cancelBtn.click();
  // If discard confirm appears, accept it
  const discard = page.locator('button', { hasText: 'Discard' });
  if (await discard.isVisible({ timeout: 500 }).catch(() => false)) {
    await discard.click();
  }
  await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 2000 });
}

test.describe('BoardManagerDialog', () => {
  test.afterEach(async () => {
    if (await page.locator('[data-testid="board-manager-dialog"]').isVisible({ timeout: 200 }).catch(() => false)) {
      await closeManager();
    }
  });

  test('opens with the clicked column preselected as active tab', async () => {
    await openManagerByHeader('Code Review');
    const tab = page.locator('[data-testid="board-manager-tab"][data-tab-name="Code Review"]');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  test('tab switch preserves drafts; dirty dot survives swap', async () => {
    await openManagerByHeader('Code Review');

    const nameInput = page.locator('[data-testid="board-manager-name"]');
    await nameInput.fill('Reviews');

    // Switching to a different tab keeps Code Review's name change.
    await page.locator('[data-testid="board-manager-tab"][data-tab-name="Tests"]').click();
    await expect(nameInput).toHaveValue('Tests');

    await page.locator('[data-testid="board-manager-tab"][data-tab-name="Code Review"]').click();
    await expect(nameInput).toHaveValue('Reviews');

    // Dirty dot is present on the Code Review tab.
    const codeReviewTab = page.locator('[data-testid="board-manager-tab"][data-tab-name="Code Review"]');
    const dirtyDot = codeReviewTab.locator('[data-testid="board-manager-tab-dirty"]');
    await expect(dirtyDot).toBeVisible();
  });

  test('Save fires updateSwimlane IPC once per dirty column', async () => {
    // Wire a spy onto window.electronAPI.swimlanes.update from the page side.
    await page.evaluate(() => {
      (window as unknown as { __updateSpy?: unknown[] }).__updateSpy = [];
      const original = window.electronAPI.swimlanes.update;
      window.electronAPI.swimlanes.update = async (input) => {
        ((window as unknown as { __updateSpy: unknown[] }).__updateSpy).push(input);
        return original(input);
      };
    });

    await openManagerByHeader('Code Review');
    await page.locator('[data-testid="board-manager-name"]').fill('Reviews');

    await page.locator('[data-testid="board-manager-tab"][data-tab-name="Tests"]').click();
    await page.locator('[data-testid="board-manager-name"]').fill('QA');

    await page.locator('[data-testid="board-manager-save"]').click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });

    const calls = await page.evaluate(() => (window as unknown as { __updateSpy: { name: string }[] }).__updateSpy);
    const names = calls.map((entry) => entry.name).sort();
    expect(names).toEqual(['QA', 'Reviews']);

    // Reset names by re-opening the manager (so the store stays in sync with IPC).
    await page.locator('[data-swimlane-name="Reviews"]').locator('text=Reviews').click();
    await page.locator('[data-testid="board-manager-name"]').fill('Code Review');
    // Tab name on reopen is the current store name ("QA"), not the original.
    await page.locator('[data-testid="board-manager-tab"][data-tab-name="QA"]').click();
    await page.locator('[data-testid="board-manager-name"]').fill('Tests');
    await page.locator('[data-testid="board-manager-save"]').click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });
  });

  test('Description edits persist and round-trip back into the dialog', async () => {
    const description = 'Agents run /code-review here in an isolated session.';

    await openManagerByHeader('Code Review');
    const descriptionInput = page.locator('[data-testid="board-manager-description"]');
    await descriptionInput.fill(description);
    await page.locator('[data-testid="board-manager-save"]').click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });

    // Persisted to the store/main process.
    const stored = await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      return lanes.find((lane) => lane.name === 'Code Review')?.description ?? null;
    });
    expect(stored).toBe(description);

    // Reopening rehydrates the textarea from the persisted value.
    await openManagerByHeader('Code Review');
    await expect(page.locator('[data-testid="board-manager-description"]')).toHaveValue(description);

    // Reset to empty so the shared page stays clean for later tests; a blank
    // textarea must clear the field back to null.
    await page.locator('[data-testid="board-manager-description"]').fill('');
    await page.locator('[data-testid="board-manager-save"]').click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });

    const cleared = await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      return lanes.find((lane) => lane.name === 'Code Review')?.description ?? null;
    });
    expect(cleared).toBeNull();
  });

  test('Cancel with dirty drafts opens the discard confirm modal', async () => {
    await openManagerByHeader('Code Review');
    await page.locator('[data-testid="board-manager-name"]').fill('Reviews-temp');

    await page.locator('[data-testid="board-manager-dialog"]').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h3', { hasText: 'Discard unsaved changes?' })).toBeVisible({ timeout: 1500 });

    // Keep editing returns to the manager, drafts intact.
    await page.locator('button', { hasText: 'Keep editing' }).click();
    await expect(page.locator('[data-testid="board-manager-name"]')).toHaveValue('Reviews-temp');

    // Now discard.
    await page.locator('[data-testid="board-manager-dialog"]').getByRole('button', { name: 'Cancel' }).click();
    await page.locator('button', { hasText: 'Discard' }).click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 2000 });
  });

  test('After Plan Mode row only renders when permission_mode is plan', async () => {
    await openManagerByHeader('Code Review');

    // Code Review has no permission override so plan-exit-target should be hidden
    // (the Agent section renders inline in the one-scroll form).
    await expect(page.locator('[data-testid="plan-exit-target"]')).toBeHidden();

    // Switch to Planning column where permission_mode = 'plan'.
    await page.locator('[data-testid="board-manager-tab"][data-tab-name="Planning"]').click();
    await expect(page.locator('[data-testid="plan-exit-target"]')).toBeVisible();
  });

  test('Delete column is hidden for To Do and Done', async () => {
    await openManagerByHeader('To Do');
    await expect(page.locator('[data-testid="board-manager-delete"]')).toBeHidden();
    await closeManager();

    await openManagerByHeader('Done');
    await expect(page.locator('[data-testid="board-manager-delete"]')).toBeHidden();
  });

  test('Cancel and dirty-enabled Save render pointer cursor; disabled Save does not', async () => {
    // Regression guard for the Tailwind v4 Preflight fix (src/renderer/index.css
    // @layer base). Complements tests/unit/button-cursor-base-rule.test.ts (which
    // scans the CSS source text) by asserting the COMPUTED cursor in a real
    // browser, so a Tailwind v4 layer-ordering or specificity mistake that still
    // contains the right source text but fails to actually apply would be caught
    // here even though the static scan would stay green.
    await openManagerByHeader('Code Review');

    // Save starts disabled (no dirty edits yet): the `:not(:disabled)` rule must
    // NOT apply, so the button keeps the browser's non-pointer disabled cursor.
    const saveBtn = page.locator('[data-testid="board-manager-save"]');
    await expect(saveBtn).toBeDisabled();
    await expect(saveBtn).not.toHaveCSS('cursor', 'pointer');

    // Cancel is always enabled and has no cursor-* utility of its own, so it
    // depends entirely on the restored base-layer rule.
    const cancelBtn = page.locator('[data-testid="board-manager-dialog"]').getByRole('button', { name: 'Cancel' });
    await expect(cancelBtn).toHaveCSS('cursor', 'pointer');

    // Dirty the form so Save becomes enabled, and confirm the rule now applies.
    await page.locator('[data-testid="board-manager-name"]').fill('Reviews-cursor-check');
    await expect(saveBtn).toBeEnabled();
    await expect(saveBtn).toHaveCSS('cursor', 'pointer');

    // afterEach discards the dirty edit via closeManager()'s Cancel+Discard path.
  });

  test('Add column inserts a new draft tab inline; empty name blocks save', async () => {
    await openManagerByHeader('Code Review');

    await page.locator('[data-testid="board-manager-add-column"]').click();

    const nameInput = page.locator('[data-testid="board-manager-name"]');
    await expect(nameInput).toHaveValue('New column');

    // Delete column button is visible for unsaved drafts (same as for persisted columns).
    await expect(page.locator('[data-testid="board-manager-delete"]')).toBeVisible();

    // Validation: empty name blocks save and stays focused.
    await nameInput.fill('   ');
    await page.locator('[data-testid="board-manager-save"]').click();
    await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible();

    // Set a valid name and save.
    await nameInput.fill('Triage');
    await page.locator('[data-testid="board-manager-save"]').click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });

    // The new column should now exist in the store/board.
    const swimlanes = await page.evaluate(async () => window.electronAPI.swimlanes.list());
    expect(swimlanes.some((lane) => lane.name === 'Triage')).toBe(true);

    // Cleanup so subsequent tests start clean.
    await page.evaluate(async () => {
      const remaining = await window.electronAPI.swimlanes.list();
      const triage = remaining.find((lane) => lane.name === 'Triage');
      if (triage) await window.electronAPI.swimlanes.delete(triage.id);
    });
  });

  // --- Staged column removal -----------------------------------------------
  // Removal used to fire its IPC the instant the confirm was accepted, which
  // made it the one structural edit Save and Cancel did not govern: the form
  // never went dirty (both sides of the comparison lost the id at once) so Save
  // stayed disabled, and Cancel could not undo the deletion. Nothing exercised
  // a CONFIRMED delete, so neither behavior had a guard. These two do.

  /** Create a persisted column through the dialog's own add-and-save flow. */
  async function addColumnAndSave(name: string) {
    await openManagerByHeader('Code Review');
    await page.locator('[data-testid="board-manager-add-column"]').click();
    await page.locator('[data-testid="board-manager-name"]').fill(name);
    await page.locator('[data-testid="board-manager-save"]').click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });
  }

  async function confirmDeleteActiveColumn() {
    await page.locator('[data-testid="board-manager-delete"]').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
  }

  async function columnExists(name: string): Promise<boolean> {
    return page.evaluate(async (target) => {
      const lanes = await window.electronAPI.swimlanes.list();
      return lanes.some((lane) => lane.name === target);
    }, name);
  }

  // Failure-safe teardown. The tests in this file share one `page` and one
  // project, so a spec that throws PART WAY through leaves its column persisted
  // and poisons every later spec that counts columns - the exact cascade
  // cross-platform-parity.md names as this repo's historical CI breakage. Doing
  // it here rather than at the end of each test body means it runs whether the
  // body finished or not. Scoped to these three fixture names, and to the two
  // profiles the third spec creates, so it cannot disturb the other specs.
  const STAGED_REMOVAL_FIXTURES = ['Retire Me', 'Keep Me', 'Profiled Column'];
  const STAGED_REMOVAL_PROFILES = ['Heavy', 'Extra'];

  test.afterEach(async () => {
    // Data-only. Dismissing a left-open dialog is already handled by the
    // describe's first afterEach, which runs before this one and gates on the
    // dialog actually being visible.
    await page.evaluate(async ([columnNames, profileNames]) => {
      const lanes = await window.electronAPI.swimlanes.list();
      for (const lane of lanes) {
        if (columnNames.includes(lane.name)) {
          await window.electronAPI.swimlanes.delete(lane.id).catch(() => {});
        }
      }
      const profiles = await window.electronAPI.boardConfig.getBoardProfiles();
      const survivors = profiles.filter((profile) => !profileNames.includes(profile.name));
      if (survivors.length !== profiles.length) {
        await window.electronAPI.boardConfig.setBoardProfiles(survivors);
      }
    }, [STAGED_REMOVAL_FIXTURES, STAGED_REMOVAL_PROFILES]).catch(() => {});
  });

  test('removing a column enables Save and persists only once saved', async () => {
    await addColumnAndSave('Retire Me');
    await openManagerByHeader('Retire Me');

    const saveBtn = page.locator('[data-testid="board-manager-save"]');
    await expect(saveBtn).toBeDisabled();

    await confirmDeleteActiveColumn();

    // The removal marks the form dirty, exactly like editing any other field.
    await expect(saveBtn).toBeEnabled();
    // ...and the row leaves the rail immediately, so the pending state is visible.
    await expect(page.locator('[data-testid="board-manager-tab"][data-tab-name="Retire Me"]')).toHaveCount(0);
    // The load-bearing assertion: nothing is persisted yet. Before staging, the
    // column was already gone from the DB at this point.
    expect(await columnExists('Retire Me')).toBe(true);

    await saveBtn.click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });

    await expect.poll(() => columnExists('Retire Me'), { timeout: 3000 }).toBe(false);
  });

  test('discarding after removing a column keeps the column', async () => {
    await addColumnAndSave('Keep Me');
    await openManagerByHeader('Keep Me');

    await confirmDeleteActiveColumn();

    // Cancel must raise the discard confirm (proof the staged delete counts as
    // dirty), and discarding must leave the column alone.
    await page.locator('[data-testid="board-manager-dialog"]').getByRole('button', { name: 'Cancel' }).click();
    const discard = page.getByRole('button', { name: 'Discard' });
    await expect(discard).toBeVisible({ timeout: 2000 });

    // The confirm must SAY what it is discarding. Its bullet list is built from
    // `dirtyIds`, which a staged delete is not part of, so a delete-only cancel
    // used to render an empty body under the "Discard unsaved changes?" title.
    await expect(page.getByText('These columns are staged for removal. Discarding keeps them:')).toBeVisible();
    // Scope to the confirm's own bullet list by testid: "Keep Me" also labels the
    // column header still on the board behind the modal, and a page-wide `ul li`
    // would silently start counting any other list that happens to be mounted.
    const bullets = page.locator('[data-testid="board-manager-staged-removals"] li');
    await expect.poll(async () => bullets.count(), { timeout: 2000 }).toBe(1);
    await expect(bullets.first()).toContainText('Keep Me');

    await discard.click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });

    expect(await columnExists('Keep Me')).toBe(true);
    // Teardown is the shared afterEach, so it also runs if any assertion above throws.
  });

  test('saving a staged delete alongside a profile edit does not restore the profile entry', async () => {
    // `profileDrafts` is snapshotted at mount and written back WHOLE at the end
    // of handleSave. The main process prunes the deleted column out of the
    // on-disk profiles during the delete IPC, so without pruning that snapshot
    // too, this trailing write puts the dangling entry straight back.
    //
    // The profile edit is load-bearing: with no profile change there is no
    // trailing write at all, and main's own pruning stands unopposed. This is
    // specifically the both-at-once case.
    await addColumnAndSave('Profiled Column');

    const laneId = await page.evaluate(async () => {
      const lanes = await window.electronAPI.swimlanes.list();
      return lanes.find((lane) => lane.name === 'Profiled Column')?.id ?? '';
    });
    expect(laneId).not.toBe('');

    // Give a profile a real delta keyed to that column.
    await openManagerByHeader('Profiled Column');
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await page.locator('[data-testid="board-manager-profile-new"]').click();
    await page.locator('[data-testid="profile-name-input"]').fill('Heavy');
    await page.locator('[data-testid="profile-name-confirm"]').click();
    await expect(page.locator('[data-testid="profile-name-input"]')).toBeHidden({ timeout: 2000 });
    await dialog.locator('[role="switch"][aria-label="Start an agent here"]').click();
    await page.locator('[data-testid="board-manager-save"]').click();
    await dialog.waitFor({ state: 'detached', timeout: 3000 });

    const seeded = await page.evaluate(async () => window.electronAPI.boardConfig.getBoardProfiles());
    expect(seeded.find((profile) => profile.name === 'Heavy')?.columns).toHaveProperty(laneId);

    // Now delete that column AND touch the profiles in the same save. Structure
    // edits are suppressed under a profile, so stage the delete under Default
    // first, then make the profile change.
    await openManagerByHeader('Profiled Column');
    await confirmDeleteActiveColumn();
    await page.locator('[data-testid="board-manager-profile-new"]').click();
    await page.locator('[data-testid="profile-name-input"]').fill('Extra');
    await page.locator('[data-testid="profile-name-confirm"]').click();
    await expect(page.locator('[data-testid="profile-name-input"]')).toBeHidden({ timeout: 2000 });

    await page.locator('[data-testid="board-manager-save"]').click();
    await page.locator('[data-testid="board-manager-dialog"]').waitFor({ state: 'detached', timeout: 3000 });

    const after = await page.evaluate(async () => window.electronAPI.boardConfig.getBoardProfiles());
    expect(after.find((profile) => profile.name === 'Heavy')?.columns ?? {}).not.toHaveProperty(laneId);
    // Teardown is the shared afterEach, which removes only the "Heavy"/"Extra"
    // profiles this spec created rather than resetting the whole list to [].
  });
});
