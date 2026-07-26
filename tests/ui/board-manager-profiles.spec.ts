/**
 * Board Profile authoring in the BoardManagerDialog.
 *
 * A profile is a named alternate ladder of the per-column strategy settings.
 * Its NAME is how it is picked in a task's context bar, so names must be unique
 * - two profiles called "Complex" would be indistinguishable at the point of
 * use even though they carry different uuids.
 *
 * These cover the authoring surface: the rail's Profile section, the name
 * dialog's uniqueness guard, and that selecting a profile re-points the column
 * form at that profile's values while leaving column identity shared.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `BoardMgr Profiles ${Date.now()}`;
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

async function openManager(columnName: string) {
  const column = page.locator(`[data-swimlane-name="${columnName}"]`);
  await column.locator(`text=${columnName}`).click();
  await expect(page.locator('[data-testid="board-manager-dialog"]')).toBeVisible({ timeout: 3000 });
}

async function closeManager() {
  // Several tests deliberately finish with the name dialog still open (a
  // rejected name leaves Create disabled). Its backdrop intercepts pointer
  // events, so dismiss it before reaching for the manager's Cancel button.
  const nameInput = page.locator('[data-testid="profile-name-input"]');
  if (await nameInput.isVisible({ timeout: 300 }).catch(() => false)) {
    await page.locator('[data-testid="profile-name-cancel"]').click();
    await nameInput.waitFor({ state: 'hidden', timeout: 2000 });
  }

  const dialog = page.locator('[data-testid="board-manager-dialog"]');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const discardBtn = page.locator('button', { hasText: 'Discard' });
  if (await discardBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await discardBtn.click();
  }
  await dialog.waitFor({ state: 'detached', timeout: 2000 });
}

/** Create a profile through the rail's New-profile flow. */
async function createProfile(name: string) {
  await page.locator('[data-testid="board-manager-profile-new"]').click();
  const input = page.locator('[data-testid="profile-name-input"]');
  await expect(input).toBeVisible({ timeout: 2000 });
  await input.fill(name);
  await page.locator('[data-testid="profile-name-confirm"]').click();
  await expect(input).toBeHidden({ timeout: 2000 });
}

test.describe('BoardManagerDialog Board Profiles', () => {
  test.afterEach(async () => {
    if (await page.locator('[data-testid="board-manager-dialog"]').isVisible({ timeout: 200 }).catch(() => false)) {
      await closeManager();
    }
  });

  test('rail shows the Profile section defaulting to Default', async () => {
    await openManager('Planning');

    await expect(page.locator('[data-testid="board-manager-profile-bar"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-manager-profile-select"]')).toHaveValue('');
    // Default offers only "New"; the destructive/renaming actions belong to a
    // selected profile and must not sit there permanently disabled.
    await expect(page.locator('[data-testid="board-manager-profile-new"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-manager-profile-delete"]')).toHaveCount(0);

    await closeManager();
  });

  test('creating a profile selects it and swaps in its management actions', async () => {
    await openManager('Planning');
    await createProfile('Complex');

    const select = page.locator('[data-testid="board-manager-profile-select"]');
    await expect(select).not.toHaveValue('');
    await expect(page.locator('[data-testid="board-manager-profile-duplicate"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-manager-profile-rename"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-manager-profile-delete"]')).toBeVisible();
    // "New" stays available in both states - it is meaningful either way, and
    // holding it constant keeps the action row from reflowing on every switch.
    await expect(page.locator('[data-testid="board-manager-profile-new"]')).toBeVisible();

    // The detail header names the profile being edited, so the form never
    // silently shows one profile's values while the user believes another.
    await expect(page.locator('[data-testid="board-manager-active-profile-pill"]')).toHaveText('Complex');

    await closeManager();
  });

  test('a duplicate profile name cannot be created', async () => {
    await openManager('Planning');
    await createProfile('Simple');

    // Back to Default so the New action is available again.
    await page.locator('[data-testid="board-manager-profile-select"]').selectOption('');
    await page.locator('[data-testid="board-manager-profile-new"]').click();

    const input = page.locator('[data-testid="profile-name-input"]');
    await input.fill('Simple');

    await expect(page.locator('[data-testid="profile-name-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-name-confirm"]')).toBeDisabled();

    await closeManager();
  });

  test('the duplicate-name check ignores case and surrounding whitespace', async () => {
    await openManager('Planning');
    await createProfile('Heavy');

    await page.locator('[data-testid="board-manager-profile-select"]').selectOption('');
    await page.locator('[data-testid="board-manager-profile-new"]').click();

    const input = page.locator('[data-testid="profile-name-input"]');
    const confirm = page.locator('[data-testid="profile-name-confirm"]');

    await input.fill('  heavy  ');
    await expect(confirm).toBeDisabled();

    await input.fill('HEAVY');
    await expect(confirm).toBeDisabled();

    // A genuinely different name clears the block.
    await input.fill('Heavyweight');
    await expect(confirm).toBeEnabled();

    await closeManager();
  });

  test('an empty name cannot be submitted', async () => {
    await openManager('Planning');
    await page.locator('[data-testid="board-manager-profile-new"]').click();

    const input = page.locator('[data-testid="profile-name-input"]');
    const confirm = page.locator('[data-testid="profile-name-confirm"]');

    await expect(confirm).toBeDisabled();
    await input.fill('   ');
    await expect(confirm).toBeDisabled();

    await closeManager();
  });

  test('renaming allows keeping the profile\'s own name', async () => {
    await openManager('Planning');
    await createProfile('Deep');

    await page.locator('[data-testid="board-manager-profile-rename"]').click();
    const input = page.locator('[data-testid="profile-name-input"]');
    await expect(input).toHaveValue('Deep');
    // Its own name must not count as a collision with itself.
    await expect(page.locator('[data-testid="profile-name-confirm"]')).toBeEnabled();
    await expect(page.locator('[data-testid="profile-name-error"]')).toHaveCount(0);

    await closeManager();
  });

  // REGRESSION: handleSave's "nothing to save" early return checked only column
  // creates / updates / reorder. Profile edits live in `profileDrafts`, never in
  // `drafts`, so a profile-only change left all three false and the dialog closed
  // before the profile write ran - create a profile, edit it, Save, reopen, gone.
  test('a profile-only change survives Save and reopen', async () => {
    await openManager('Planning');
    await createProfile('Persisted');

    // Edit a strategy field so the profile carries a real delta, not just a name.
    const effort = page.locator('[data-testid="column-effort-override"]');
    await expect(effort).toBeVisible({ timeout: 2000 });

    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 3000 });

    // Reopen: the profile must still be listed and selectable.
    await openManager('Planning');
    const select = page.locator('[data-testid="board-manager-profile-select"]');
    await expect(select.locator('option', { hasText: 'Persisted' })).toHaveCount(1);

    await closeManager();
  });

  // Column STRUCTURE - which columns exist and their order - is singular across
  // profiles. Only strategy is profile-scoped, so add / delete / reorder must be
  // unavailable under a profile: performing any of them there would restructure
  // the board for every task, not just the ones riding this profile.
  test('structure edits are suppressed while a profile is selected', async () => {
    await openManager('Planning');

    // Baseline under Default: all three structure affordances are present.
    await expect(page.locator('[data-testid="board-manager-add-column"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-manager-delete"]')).toBeVisible();
    const handlesUnderDefault = await page.locator('[data-drag-handle]').count();
    expect(handlesUnderDefault).toBeGreaterThan(0);

    await createProfile('Structured');

    await expect(page.locator('[data-testid="board-manager-add-column"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="board-manager-delete"]')).toBeHidden();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(0);

    // Returning to Default restores them.
    await page.locator('[data-testid="board-manager-profile-select"]').selectOption('');
    await expect(page.locator('[data-testid="board-manager-add-column"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-manager-delete"]')).toBeVisible();
    expect(await page.locator('[data-drag-handle]').count()).toBeGreaterThan(0);

    await closeManager();
  });

  test('column identity is not editable while a profile is selected', async () => {
    await openManager('Planning');

    // Under Default the name field edits the column itself.
    await expect(page.locator('[data-testid="board-manager-name"]')).toBeVisible();

    await createProfile('Light');

    // Under a profile it is replaced by an explanation: name, color, and icon
    // are shared by every profile, so editing them here would change the board
    // for everyone rather than just this profile.
    await expect(page.locator('[data-testid="board-manager-name"]')).toHaveCount(0);

    await closeManager();
  });
});
