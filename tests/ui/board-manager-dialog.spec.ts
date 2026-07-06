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
});
