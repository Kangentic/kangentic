/**
 * A portaled, trigger-width-matched menu must open UNDER its trigger on the
 * FIRST open of a freshly mounted combobox, not only on the second.
 *
 * The bug: `usePopoverPosition` reads the menu's `offsetWidth` in its layout
 * effect, and the comboboxes used to measure the trigger width in a SECOND
 * layout effect declared after the hook, passing it through `style.width`.
 * Layout effects run in declaration order, so on the mount commit the hook
 * measured a width-less menu. Its shrink-to-fit width is a run of inline-block
 * `w-full` option buttons laid on ONE line (~1300px for 15 agents), which flips
 * the `preferRight: false` overflow check and right-aligns the menu at
 * `trigger.right - 1300`: about 830px left of the field, correct width, correct
 * top. The width state survived the close, so the second open measured a menu
 * that already had its width and landed correctly. Settings remounts its
 * comboboxes on every panel open, hence "first launch of the settings page".
 *
 * The fix is the hook's `matchTriggerWidth` option, which writes the width
 * ahead of its own measurement. This spec is the red-green repro: the settings
 * panel is right-anchored (`right-0 w-[720px]`), so at 1920 the field sits at
 * x~1400 and any measured width past ~712px trips the flip.
 *
 * Each test launches its own page (mode: 'parallel'). That is load-bearing
 * here, not just convention: a page where an earlier test already opened the
 * same combobox would carry the surviving width state and pass against the
 * broken code.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

const ALIGNMENT_TOLERANCE_PX = 2;

async function openSettingsTab(page: Page, tabName: string): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: tabName, exact: true }).click();
}

/**
 * The menu's left edge and width against the bordered field the input sits in
 * (the combobox container's only child, so it shares the container's box the
 * hook positions against). Null until both boxes exist.
 */
async function menuOffsets(
  page: Page,
  testId: string,
): Promise<{ deltaX: number; deltaWidth: number } | null> {
  const field = page.locator(`input[data-testid="${testId}"]`).locator('xpath=..');
  const menu = page.locator(`[data-testid="${testId}-menu"]`);
  const [fieldBox, menuBox] = await Promise.all([field.boundingBox(), menu.boundingBox()]);
  if (!fieldBox || !menuBox) return null;
  return {
    deltaX: Math.abs(menuBox.x - fieldBox.x),
    deltaWidth: Math.abs(menuBox.width - fieldBox.width),
  };
}

/**
 * Opens the combobox through its chevron and asserts the menu lands under the
 * field. Polling absorbs OverlayPopover's scale(0.96) entrance, which shifts the
 * rendered left edge by a few pixels until it settles; on the broken code the
 * delta is in the hundreds and never converges, so the poll times out red.
 */
async function expectMenuUnderField(page: Page, testId: string): Promise<void> {
  const chevron = page
    .locator(`input[data-testid="${testId}"]`)
    .locator('xpath=..')
    .locator('button[aria-label="Open dropdown"]');
  await chevron.click();
  await page.locator(`[data-testid="${testId}-menu"]`).waitFor({ state: 'visible', timeout: 3000 });

  await expect
    .poll(async () => (await menuOffsets(page, testId))?.deltaX ?? null, { timeout: 3000 })
    .toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
  await expect
    .poll(async () => (await menuOffsets(page, testId))?.deltaWidth ?? null, { timeout: 3000 })
    .toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
}

/**
 * Closes through the chevron toggle: a plain click scoped to this one
 * combobox's state, which is what is under test. Escape would close only the
 * menu too (see combobox-escape-layering.spec.ts), but that is its own contract.
 */
async function closeMenu(page: Page, testId: string): Promise<void> {
  await page
    .locator(`input[data-testid="${testId}"]`)
    .locator('xpath=..')
    .locator('button[aria-label="Close dropdown"]')
    .click();
  await page.locator(`[data-testid="${testId}-menu"]`).waitFor({ state: 'hidden', timeout: 3000 });
}

test('Settings > Agent: the agent menu opens under its field on the first open, and again on reopen', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `PopoverFirstOpen ${Date.now()}`);
    await openSettingsTab(page, 'Agent');
    await expect(page.locator('input[data-testid="project-default-agent"]')).toBeVisible({ timeout: 3000 });

    // The first open per mount is the case that failed: the menu had no width
    // yet when the hook measured it.
    await expectMenuUnderField(page, 'project-default-agent');

    // The reopen path always passed (the width state survived the close);
    // pinned so the fix cannot trade one for the other.
    await closeMenu(page, 'project-default-agent');
    await expectMenuUnderField(page, 'project-default-agent');
  } finally {
    await browser.close();
  }
});

test('Settings > Agent: the model menu opens under its field on the first open', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `PopoverFirstOpenModel ${Date.now()}`);
    await openSettingsTab(page, 'Agent');
    await expect(page.locator('input[data-testid="project-default-model"]')).toBeVisible({ timeout: 3000 });

    // ModelCombobox is the same recipe with a different row shape (flex rows,
    // which do not inflate the way inline-block buttons do), so this test was
    // GREEN before the fix too. It is a pin on the ModelCombobox adoption of the
    // hook option, not a second guard: the agent-menu test above is the one that
    // was red.
    await expectMenuUnderField(page, 'project-default-model');
  } finally {
    await browser.close();
  }
});

test('Settings > Terminal: the font menu opens under its field on the first open', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `PopoverFirstOpenFont ${Date.now()}`);
    await openSettingsTab(page, 'Terminal');
    await expect(page.locator('input[data-testid="terminal-font-family"]')).toBeVisible({ timeout: 3000 });

    // FontCombobox's rows are the same inline-block `w-full` button shape as
    // Combobox's (a plain list of font names), so a first open here is at risk
    // of the same shrink-to-fit-before-width-lands failure the agent menu had.
    await expectMenuUnderField(page, 'terminal-font-family');

    await closeMenu(page, 'terminal-font-family');
    await expectMenuUnderField(page, 'terminal-font-family');
  } finally {
    await browser.close();
  }
});

/**
 * BranchPicker's `variant="input"` shares the fix (`matchTriggerWidth: variant
 * === 'input'`, see BranchPicker.tsx) but not the comboboxes' DOM shape: the
 * trigger is a `<button data-testid="branch-picker-input">`, not an
 * `<input>` with a separate chevron, and the dropdown is
 * `data-testid="branch-picker-dropdown"`, not `<testid>-menu`. The button is
 * the combobox's whole trigger (an `onClick` toggle, no `aria-label="Open
 * dropdown"` control), so this gets its own small pair of helpers rather than
 * reusing `menuOffsets`/`expectMenuUnderField`/`closeMenu` above.
 */
async function branchPickerOffsets(page: Page): Promise<{ deltaX: number; deltaWidth: number } | null> {
  const trigger = page.locator('[data-testid="branch-picker-input"]');
  const dropdown = page.locator('[data-testid="branch-picker-dropdown"]');
  const [triggerBox, dropdownBox] = await Promise.all([trigger.boundingBox(), dropdown.boundingBox()]);
  if (!triggerBox || !dropdownBox) return null;
  return {
    deltaX: Math.abs(dropdownBox.x - triggerBox.x),
    deltaWidth: Math.abs(dropdownBox.width - triggerBox.width),
  };
}

async function expectBranchDropdownUnderField(page: Page): Promise<void> {
  await page.locator('[data-testid="branch-picker-input"]').click();
  await page.locator('[data-testid="branch-picker-dropdown"]').waitFor({ state: 'visible', timeout: 3000 });

  await expect
    .poll(async () => (await branchPickerOffsets(page))?.deltaX ?? null, { timeout: 3000 })
    .toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
  await expect
    .poll(async () => (await branchPickerOffsets(page))?.deltaWidth ?? null, { timeout: 3000 })
    .toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_PX);
}

test('Settings > Git: the default-base-branch dropdown opens under its field on the first open', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `PopoverFirstOpenBranch ${Date.now()}`);
    await openSettingsTab(page, 'Git');
    await expect(page.locator('[data-testid="branch-picker-input"]')).toBeVisible({ timeout: 3000 });

    await expectBranchDropdownUnderField(page);

    // Close by re-clicking the trigger (its own toggle, not a chevron) and
    // reopen, mirroring the reopen-still-holds pin on the agent menu above.
    await page.locator('[data-testid="branch-picker-input"]').click();
    await page.locator('[data-testid="branch-picker-dropdown"]').waitFor({ state: 'hidden', timeout: 3000 });
    await expectBranchDropdownUnderField(page);
  } finally {
    await browser.close();
  }
});
