/**
 * UI tests for the EditColumnDialog:
 * - Agent section divider
 * - Permission Mode dropdown (per-column override)
 * - Auto-spawn toggle (per-column agent auto-start)
 * - Plan exit target dropdown (for plan-mode columns)
 * - Locked state for system columns (To Do, Done)
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `EditCol Test ${Date.now()}`;
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

/** Open the EditColumnDialog for a given column name */
async function openEditDialog(columnName: string) {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await page.waitForTimeout(300);
  // Verify dialog opened
  await expect(page.locator('text=Edit Column')).toBeVisible({ timeout: 3000 });
}

/** Close dialog via Escape */
async function closeDialog() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

test.describe('EditColumnDialog', () => {
  test('Agent section divider is visible', async () => {
    await openEditDialog('Code Review');

    await expect(page.locator('text=Agent').first()).toBeVisible();

    // Permissions and Auto-spawn are always visible (no collapse)
    await expect(page.locator('label:has-text("Permissions")').first()).toBeVisible();
    await expect(page.locator('label:has-text("Auto-spawn")').first()).toBeVisible();

    await closeDialog();
  });

  test('custom column shows editable permissions dropdown with Default selected', async () => {
    await openEditDialog('Code Review');

    const select = page.locator('select').last();
    await expect(select).toBeEnabled();

    // Global default should be the selected value (empty string = inherit)
    const value = await select.inputValue();
    expect(value).toBe('');

    // First option shows resolved global value (mock default is 'default' → "Default (Allowlist)")
    // Duplicate is filtered out -- only appears once as the default option
    const options = await select.locator('option').allTextContents();
    expect(options.filter((o) => o === 'Default (Allowlist)')).toHaveLength(1);
    expect(options).toContain('Plan');
    expect(options).toContain('Accept Edits');
    expect(options).toContain('Bypass (Unsafe)');

    await closeDialog();
  });

  test('custom column shows editable auto-spawn toggle (ON)', async () => {
    await openEditDialog('Code Review');

    const toggle = page.locator('button[role="switch"]');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await closeDialog();
  });

  test('Planning column has editable permissions set to Plan', async () => {
    await openEditDialog('Planning');

    // Planning is now a regular column -- permissions are editable
    const select = page.locator('select').first();
    await expect(select).toBeEnabled();

    const value = await select.inputValue();
    expect(value).toBe('plan');

    await closeDialog();
  });

  test('Planning column has editable auto-spawn ON', async () => {
    await openEditDialog('Planning');

    const toggle = page.locator('button[role="switch"]');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await closeDialog();
  });

  test('Planning column shows plan exit target dropdown', async () => {
    await openEditDialog('Planning');

    const planExitSelect = page.locator('[data-testid="plan-exit-target"]');
    await expect(planExitSelect).toBeVisible();

    // Default target should be Executing
    const options = await planExitSelect.locator('option').allTextContents();
    expect(options).toContain('Nowhere -- stay in column');
    expect(options).toContain('Executing');

    // Should not include current column, To Do, or Done
    expect(options).not.toContain('Planning');
    expect(options).not.toContain('To Do');
    expect(options).not.toContain('Done');

    await closeDialog();
  });

  test('To Do column has auto-spawn locked OFF', async () => {
    await openEditDialog('To Do');

    const toggle = page.locator('button[role="switch"]');
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await expect(page.locator('text=Tasks in this column do not start agents.')).toBeVisible();

    await closeDialog();
  });

  test('pencil button opens edit dialog on custom column', async () => {
    const column = page.locator('[data-swimlane-name="Code Review"]');
    await column.locator('[data-testid="edit-column-btn"]').click();
    await expect(page.locator('text=Edit Column')).toBeVisible({ timeout: 3000 });
    await closeDialog();
  });

  test('pencil button opens edit dialog on Done column', async () => {
    const column = page.locator('[data-swimlane-name="Done"]');
    await column.locator('[data-testid="edit-column-btn"]').click();
    await expect(page.locator('text=Edit Column')).toBeVisible({ timeout: 3000 });
    await closeDialog();
  });

  test('save persists permission_mode and auto_spawn changes', async () => {
    await openEditDialog('Code Review');

    // Change permissions to Plan (first select is the permissions dropdown)
    const permSelect = page.locator('select').first();
    await permSelect.selectOption('plan');

    // Toggle auto-spawn OFF
    const toggle = page.locator('button[role="switch"]');
    await toggle.click();
    await page.waitForTimeout(100);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Save
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(500);

    // Reopen and verify persisted values
    await openEditDialog('Code Review');

    const permSelectAfter = page.locator('select').first();
    const valueAfter = await permSelectAfter.inputValue();
    expect(valueAfter).toBe('plan');

    const toggleAfter = page.locator('button[role="switch"]');
    await expect(toggleAfter).toHaveAttribute('aria-checked', 'false');

    // Plan exit target dropdown should now be visible (since permissions = plan)
    await expect(page.locator('[data-testid="plan-exit-target"]')).toBeVisible();

    // Restore original values so other tests aren't affected
    await permSelectAfter.selectOption('');
    await toggleAfter.click();
    await page.locator('button:has-text("Save")').click();
    await page.waitForTimeout(300);
  });
});
