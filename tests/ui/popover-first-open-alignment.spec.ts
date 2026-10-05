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
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  launchPage,
  createProject,
  launchWithTransientTerminal,
  openTransientCommandTerminal,
} from './helpers';

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

// ---------------------------------------------------------------------------
// Short window: a fixed menu caps itself to the room the hook publishes
// ---------------------------------------------------------------------------

/**
 * `usePopoverPosition({ strategy: 'fixed' })` publishes the room on the side it
 * chose as `--popover-available-height` and `--popover-available-width` on the
 * popover, and the menus cap themselves with it: Combobox with
 * `max-h-[min(12rem,var(--popover-available-height,12rem))]`, BranchPicker with
 * `max-h-[var(--popover-available-height,none)]` on a flex column. Before the
 * cap each had a fixed height only, so in a short window the menu ran past the
 * window edge.
 *
 * The published value is the room to the window edge minus the gap the hook
 * leaves to the trigger and the padding it leaves to the edge. That is the
 * contract these cases pin: a menu capped to it fits between the two.
 */

/** Slack for sub-pixel rounding, which differs between Windows and headless Linux. */
const GEOMETRY_TOLERANCE_PX = 2;
/** What the hook leaves between a fixed menu and its trigger (POPOVER_GAP). */
const POPOVER_GAP_PX = 8;
/** What the hook leaves between a fixed menu and the window edge (the default viewportPadding). */
const VIEWPORT_PADDING_PX = 8;
/** The published value is the trigger-to-window-edge distance less both of the above. */
const PUBLISHED_HEIGHT_INSET_PX = POPOVER_GAP_PX + VIEWPORT_PADDING_PX;

/**
 * Room under the Git tab's trigger for the branch case. It has to sit between the
 * menu's open-time loading state (about 105px, which must fit below or the menu
 * opens above and the cap never binds) and the loaded menu (about 247px: the
 * search row plus the list's own 200px cap).
 */
const BRANCH_ROOM_BELOW_TRIGGER_PX = 150;
/** Enough branches that the list overflows its own 200px cap many times over. */
const BRANCH_COUNT = 40;
/** Room under the Git tab's trigger that cannot hold the loading state, so the menu opens above. */
const BRANCH_ROOM_FOR_ABOVE_PX = 40;

/**
 * Window height for the Combobox case. The Agent tab's field is scrolled to the
 * top of the panel body, so it has under 192px of room on both sides, which is
 * the only way the 12rem menu cannot find a side it fits on.
 */
const COMBOBOX_SHORT_WINDOW_HEIGHT_PX = 330;
/** Combobox's own cap, `12rem` at the 16px root. */
const COMBOBOX_MENU_CAP_PX = 192;

const PIXEL_VALUE = /^\s*\d+(\.\d+)?px\s*$/;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Edges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface MenuGeometry {
  windowHeight: number;
  windowWidth: number;
  trigger: Edges;
  menu: Edges & { offsetHeight: number };
  publishedHeight: string;
  publishedWidth: string;
  scrollerScrollHeight: number;
  scrollerClientHeight: number;
  /** Where the scroller's own box ends. For a menu that scrolls through an inner list, a list that never shrank ends past the menu. */
  scrollerBottom: number;
}

/** A pixel string the hook wrote, parsed; fails the case if it is not `<n>px`. */
function parsePixels(raw: string): number {
  expect(raw).toMatch(PIXEL_VALUE);
  return parseFloat(raw);
}

/**
 * The trigger's box once two reads 100ms apart agree. A position the test sizes
 * the window around has to hold still before the menu opens: the hook anchors to
 * where the trigger is at open and nothing re-measures afterwards.
 */
async function readSteadyBox(locator: Locator): Promise<Box> {
  const result: { previous: Box | null; steady: Box | null } = { previous: null, steady: null };
  await expect
    .poll(
      async () => {
        const current = await locator.boundingBox();
        const previous = result.previous;
        const isSteady = current !== null
          && previous !== null
          && current.x === previous.x
          && current.y === previous.y
          && current.width === previous.width
          && current.height === previous.height;
        if (isSteady) result.steady = current;
        result.previous = current;
        return isSteady;
      },
      { timeout: 5000, intervals: [100] },
    )
    .toBe(true);
  if (!result.steady) throw new Error('locator never held still');
  return result.steady;
}

/**
 * Resolves once the menu's own grow-in has finished, so a rect read afterwards is
 * the settled one (the animation starts at scale(0.96)). Only the element's own
 * animations, not its subtree's, so the branch loader's spinner is not waited on.
 */
async function waitForMenuEntrance(menu: Locator): Promise<void> {
  await menu.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
}

/**
 * Where the open menu sits against its trigger and the window, plus the room the
 * hook published on it. `scrollerSelector` names the element inside the menu that
 * scrolls; when absent the menu itself scrolls.
 */
async function readMenuGeometry(
  page: Page,
  selectors: { trigger: string; menu: string; scroller?: string },
): Promise<MenuGeometry> {
  return page.evaluate((selected) => {
    const triggerElement = document.querySelector(selected.trigger);
    const menuElement = document.querySelector<HTMLElement>(selected.menu);
    if (!triggerElement || !menuElement) throw new Error('trigger or menu is not in the page');
    const scrollerElement = selected.scroller
      ? menuElement.querySelector<HTMLElement>(selected.scroller)
      : menuElement;
    if (!scrollerElement) throw new Error('the menu has no scroller');
    const triggerRect = triggerElement.getBoundingClientRect();
    const menuRect = menuElement.getBoundingClientRect();
    const computed = getComputedStyle(menuElement);
    return {
      windowHeight: window.innerHeight,
      windowWidth: window.innerWidth,
      trigger: { top: triggerRect.top, bottom: triggerRect.bottom, left: triggerRect.left, right: triggerRect.right },
      menu: {
        top: menuRect.top,
        bottom: menuRect.bottom,
        left: menuRect.left,
        right: menuRect.right,
        offsetHeight: menuElement.offsetHeight,
      },
      publishedHeight: computed.getPropertyValue('--popover-available-height'),
      publishedWidth: computed.getPropertyValue('--popover-available-width'),
      scrollerScrollHeight: scrollerElement.scrollHeight,
      scrollerClientHeight: scrollerElement.clientHeight,
      scrollerBottom: scrollerElement.getBoundingClientRect().bottom,
    };
  }, selectors);
}

/**
 * The branch list the Git tab will fetch, seeded before the picker opens. Awaited
 * by the caller through the last row: the picker caches a fetch for 15s, so a list
 * that never shows up means something fetched first and this override lost.
 */
async function seedBranches(page: Page, count: number): Promise<string[]> {
  const branchNames = Array.from({ length: count }, (_unused, index) => `feature/branch-${String(index).padStart(2, '0')}`);
  await page.evaluate((names) => {
    (window as unknown as { electronAPI: { git: { listBranches: () => Promise<string[]> } } })
      .electronAPI.git.listBranches = async () => names;
  }, branchNames);
  return branchNames;
}

const BRANCH_TRIGGER = '[data-testid="branch-picker-input"]';
const BRANCH_MENU = '[data-testid="branch-picker-dropdown"]';

test('Settings > Git: in a short window the branch list shrinks and scrolls instead of running past the window bottom', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `BranchShortWindow ${Date.now()}`);
    const branchNames = await seedBranches(page, BRANCH_COUNT);
    await openSettingsTab(page, 'Git');
    const trigger = page.locator(BRANCH_TRIGGER);
    await expect(trigger).toBeVisible({ timeout: 3000 });

    // Size the window around the trigger rather than hard-coding a height: the
    // room under it is what the case is about, and its position differs by a few
    // pixels between platforms. Read it, shrink, and wait for it to hold still.
    const startBox = await readSteadyBox(trigger);
    const viewportWidth = page.viewportSize()!.width;
    await page.setViewportSize({
      width: viewportWidth,
      height: Math.round(startBox.y + startBox.height + PUBLISHED_HEIGHT_INSET_PX + BRANCH_ROOM_BELOW_TRIGGER_PX),
    });
    await readSteadyBox(trigger);

    // One open only. The list is measured at open in its short loading state and
    // lands afterwards, which is what makes the menu grow below the trigger. A
    // second open would be served from the fetch cache, measured at full height,
    // and flip above, where the cap would never bind.
    await trigger.click();
    const menu = page.locator(BRANCH_MENU);
    await expect(menu).toBeVisible({ timeout: 3000 });
    await expect(menu.locator('button', { hasText: branchNames[branchNames.length - 1] })).toBeAttached({ timeout: 3000 });
    await waitForMenuEntrance(menu);

    const geometry = await readMenuGeometry(page, {
      trigger: BRANCH_TRIGGER,
      menu: BRANCH_MENU,
      scroller: '.overflow-y-auto',
    });
    const publishedHeight = parsePixels(geometry.publishedHeight);
    const uncappedMenuHeight = await menu.evaluate((element) => {
      const searchRow = element.firstElementChild as HTMLElement;
      const list = element.querySelector<HTMLElement>('.overflow-y-auto');
      if (!list) throw new Error('the menu has no list');
      const borders = element.offsetHeight - element.clientHeight;
      return searchRow.offsetHeight + Math.min(list.scrollHeight, parseFloat(getComputedStyle(list).maxHeight)) + borders;
    });

    // Preconditions, so the case cannot pass vacuously: the menu opened below,
    // and without the cap its loaded height would cross the window bottom.
    expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.trigger.bottom - GEOMETRY_TOLERANCE_PX);
    expect(uncappedMenuHeight).toBeGreaterThan(publishedHeight + VIEWPORT_PADDING_PX + GEOMETRY_TOLERANCE_PX);

    // The cap. This is the assertion that separates capped from uncapped: the
    // list carries its own 200px cap and scrolls either way, so the list
    // scrolling below proves nothing about the menu's cap, only that it still
    // scrolls when shrunk.
    expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.windowHeight + GEOMETRY_TOLERANCE_PX);
    expect(geometry.menu.offsetHeight).toBeLessThanOrEqual(publishedHeight + GEOMETRY_TOLERANCE_PX);
    expect(geometry.scrollerScrollHeight).toBeGreaterThan(geometry.scrollerClientHeight);
  } finally {
    await browser.close();
  }
});

test('Settings > Agent: in a short window the agent menu caps itself to the room on its side and scrolls', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `ComboboxShortWindow ${Date.now()}`);
    await page.setViewportSize({ width: page.viewportSize()!.width, height: COMBOBOX_SHORT_WINDOW_HEIGHT_PX });
    await openSettingsTab(page, 'Agent');
    const input = page.locator('input[data-testid="project-default-agent"]');
    await expect(input).toBeVisible({ timeout: 3000 });

    // Up to the top of the panel body, so there is little room above the field as
    // well as below it. The settings body scrolls; the window does not.
    await input.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    const field = input.locator('xpath=..');
    await readSteadyBox(field);

    await field.locator('button[aria-label="Open dropdown"]').click();
    const menu = page.locator('[data-testid="project-default-agent-menu"]');
    await expect(menu).toBeVisible({ timeout: 3000 });
    await waitForMenuEntrance(menu);

    const geometry = await readMenuGeometry(page, {
      trigger: 'div:has(> input[data-testid="project-default-agent"])',
      menu: '[data-testid="project-default-agent-menu"]',
    });
    const publishedHeight = parsePixels(geometry.publishedHeight);

    // Preconditions, so the case cannot pass vacuously: the list is taller than
    // the menu's own cap, and the room on the chosen side is short enough that the
    // uncapped 12rem menu would cross the window edge.
    expect(geometry.scrollerScrollHeight).toBeGreaterThan(COMBOBOX_MENU_CAP_PX);
    expect(COMBOBOX_MENU_CAP_PX).toBeGreaterThan(publishedHeight + VIEWPORT_PADDING_PX + GEOMETRY_TOLERANCE_PX);

    // Inside the window whichever side it took, and clear of the field.
    expect(geometry.menu.top).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE_PX);
    expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.windowHeight + GEOMETRY_TOLERANCE_PX);
    const aboveField = geometry.menu.bottom <= geometry.trigger.top + GEOMETRY_TOLERANCE_PX;
    const belowField = geometry.menu.top >= geometry.trigger.bottom - GEOMETRY_TOLERANCE_PX;
    expect(aboveField || belowField).toBe(true);

    // Capped to the room, and scrolling inside.
    expect(geometry.menu.offsetHeight).toBeLessThanOrEqual(publishedHeight + GEOMETRY_TOLERANCE_PX);
    expect(geometry.scrollerScrollHeight).toBeGreaterThan(geometry.scrollerClientHeight);
  } finally {
    await browser.close();
  }
});

/**
 * The two published variables on a real fixed popover (BranchPicker's input
 * variant), for each side the hook can choose. `--popover-available-height` is
 * the room between the trigger and the window edge on that side, less the gap and
 * the window padding. `--popover-available-width` is the room from the menu's
 * aligned edge to the window edge, less the window padding.
 */
for (const side of ['below', 'above'] as const) {
  test(`a fixed popover that opens ${side} its trigger publishes the room on that side`, async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `PublishedRoom ${side} ${Date.now()}`);
      await openSettingsTab(page, 'Git');
      const trigger = page.locator(BRANCH_TRIGGER);
      await expect(trigger).toBeVisible({ timeout: 3000 });

      if (side === 'above') {
        // Leave less room under the trigger than the menu's loading state needs,
        // so the hook takes the side above it, where there is plenty.
        const startBox = await readSteadyBox(trigger);
        await page.setViewportSize({
          width: page.viewportSize()!.width,
          height: Math.round(startBox.y + startBox.height + VIEWPORT_PADDING_PX + BRANCH_ROOM_FOR_ABOVE_PX),
        });
        await readSteadyBox(trigger);
      }

      await trigger.click();
      const menu = page.locator(BRANCH_MENU);
      await expect(menu).toBeVisible({ timeout: 3000 });
      await waitForMenuEntrance(menu);

      const geometry = await readMenuGeometry(page, { trigger: BRANCH_TRIGGER, menu: BRANCH_MENU });
      const publishedHeight = parsePixels(geometry.publishedHeight);
      const publishedWidth = parsePixels(geometry.publishedWidth);

      // The side the menu really took, read from where it sits, not from what the
      // hook was asked for.
      if (side === 'below') {
        expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.trigger.bottom - GEOMETRY_TOLERANCE_PX);
        expect(publishedHeight).toBeGreaterThan(0);
        expect(Math.abs(
          publishedHeight - (geometry.windowHeight - geometry.trigger.bottom - PUBLISHED_HEIGHT_INSET_PX),
        )).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
      } else {
        expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.trigger.top + GEOMETRY_TOLERANCE_PX);
        expect(publishedHeight).toBeGreaterThan(0);
        expect(Math.abs(
          publishedHeight - (geometry.trigger.top - PUBLISHED_HEIGHT_INSET_PX),
        )).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
      }

      // The Git tab's menu is left-aligned with its trigger (preferRight is off and
      // the menu is the trigger's width), so the room is what lies to the right of
      // the aligned left edge.
      expect(Math.abs(geometry.menu.left - geometry.trigger.left)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
      expect(publishedWidth).toBeGreaterThanOrEqual(0);
      expect(Math.abs(
        publishedWidth - (geometry.windowWidth - geometry.trigger.left - VIEWPORT_PADDING_PX),
      )).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
    } finally {
      await browser.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Short window: the other menus that cap themselves to the published room
// ---------------------------------------------------------------------------

/**
 * The same contract as the Combobox and BranchPicker cases above, for the four
 * menus that were switched from a fixed `max-h` to
 * `max-h-[min(<own cap>,var(--popover-available-height,<own cap>))]`:
 *
 * - ModelCombobox (16rem), FontCombobox (12rem) and the Knowledge Graph's
 *   projects picker (26rem) hold their content when the hook measures them, so
 *   on the first open the variable is unset and the hook measures
 *   `min(content, own cap)`. The cap only binds when NEITHER side has the menu's
 *   own cap of room, so each case leaves little room on both sides of its trigger
 *   and accepts whichever side the hook picks.
 * - CommandPalettePopover (300px) mounts with its list still loading (a search row
 *   and a spinner, about 100px) and the commands arrive after the hook measured,
 *   the same shape as the branch list. It fits below in that state, then grows.
 *
 * Each case seeds enough rows that its list overflows the menu's own cap, so the
 * published room is the only thing that can hold the menu inside the window.
 */

/** Room left under the trigger, past which a model or font menu cannot fit below. */
const SHORT_MENU_ROOM_BELOW_TRIGGER_PX = 100;
/** The projects picker's trigger sits low in its panel, so it is given a little more. */
const PROJECTS_ROOM_BELOW_TRIGGER_PX = 160;
/** Room under the Command Terminal's kebab. Holds the palette's loading state (about 100px) and stays under its 300px cap. */
const PALETTE_ROOM_BELOW_TRIGGER_PX = 150;
/**
 * A window short enough that the settings body scrolls, so a field can be brought
 * to the top of it before the window is sized around the field. The Agent tab's
 * field has under 192px of room above it once it is there.
 */
const SCROLLING_BODY_WINDOW_HEIGHT_PX = 330;

/** ModelCombobox's own cap, `16rem` at the 16px root. */
const MODEL_MENU_CAP_PX = 256;
/** FontCombobox's own cap, `12rem` at the 16px root. */
const FONT_MENU_CAP_PX = 192;
/** CommandPalettePopover's own cap. */
const PALETTE_MENU_CAP_PX = 300;
/** The projects picker's own cap, `26rem` at the 16px root. */
const PROJECTS_MENU_CAP_PX = 416;

/** Enough rows that each list overflows its menu's own cap several times over. */
const SEEDED_ROW_COUNT = 30;

/**
 * `count` distinct names, letters only (`sample-aa`, `sample-ab`, ...). A model id
 * with digits parses as a version, and all but the newest of a family fold into the
 * versions section, which is collapsed and would not render the rows.
 */
function sampleNames(count: number): string[] {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: count }, (_unused, index) => (
    `sample-${letters[Math.floor(index / letters.length) % letters.length]}${letters[index % letters.length]}`
  ));
}

/**
 * Shortens the window until `roomBelowPx` is left under `anchor`, and returns the
 * anchor's box once it holds still. The window is sized from the anchor's real
 * position, not a fixed height: its position differs by a few pixels between
 * platforms, and the room under it is what each case is about. Fails when the
 * anchor moved while the window shrank, since the room is then not what was sized.
 */
async function shortenWindowUnder(page: Page, anchor: Locator, roomBelowPx: number): Promise<Box> {
  const startBox = await readSteadyBox(anchor);
  await page.setViewportSize({
    width: page.viewportSize()!.width,
    height: Math.round(startBox.y + startBox.height + PUBLISHED_HEIGHT_INSET_PX + roomBelowPx),
  });
  const settledBox = await readSteadyBox(anchor);
  expect(Math.abs(settledBox.y - startBox.y)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
  return settledBox;
}

/**
 * What every short-window case asserts about its open menu. The preconditions
 * come first so the case cannot pass vacuously: the list is taller than the menu's
 * own cap, and the room on the chosen side is short enough that an uncapped menu
 * would cross the window edge. They read the same on the old fixed cap, so on the
 * old code the failure lands on the cap assertions below, not on these.
 */
function expectMenuCappedToRoom(geometry: MenuGeometry, ownCapPx: number): void {
  const publishedHeight = parsePixels(geometry.publishedHeight);

  expect(geometry.scrollerScrollHeight).toBeGreaterThan(ownCapPx);
  expect(ownCapPx).toBeGreaterThan(publishedHeight + VIEWPORT_PADDING_PX + GEOMETRY_TOLERANCE_PX);

  // Inside the window whichever side it took, and clear of the trigger.
  expect(geometry.menu.top).toBeGreaterThanOrEqual(-GEOMETRY_TOLERANCE_PX);
  expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.windowHeight + GEOMETRY_TOLERANCE_PX);
  const aboveTrigger = geometry.menu.bottom <= geometry.trigger.top + GEOMETRY_TOLERANCE_PX;
  const belowTrigger = geometry.menu.top >= geometry.trigger.bottom - GEOMETRY_TOLERANCE_PX;
  expect(aboveTrigger || belowTrigger).toBe(true);

  // Capped to the room, and scrolling inside. A menu that scrolls through an inner
  // list also has to give that list the height: a list that never shrank would end
  // past the menu (clipped there by its overflow) and still pass the two above.
  expect(geometry.menu.offsetHeight).toBeLessThanOrEqual(publishedHeight + GEOMETRY_TOLERANCE_PX);
  expect(geometry.scrollerScrollHeight).toBeGreaterThan(geometry.scrollerClientHeight);
  expect(geometry.scrollerBottom).toBeLessThanOrEqual(geometry.menu.bottom + GEOMETRY_TOLERANCE_PX);
}

/**
 * Gives the Claude agent `modelNames` as its models, ahead of the Agent tab
 * opening. `capabilities` is replaced whole by the override, so the effort levels
 * and the model-override flag are restated: dropping either would remove a row
 * and move the field this case sizes the window around.
 */
async function seedModels(page: Page, modelNames: string[]): Promise<void> {
  await page.evaluate(async (names) => {
    const scope = window as unknown as {
      __mockAgentListOverrides: Record<string, unknown>;
      __zustandStores: { config: { getState: () => { loadAgentList: (forceRefresh?: boolean) => Promise<void> } } };
    };
    scope.__mockAgentListOverrides = {
      claude: {
        capabilities: {
          effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsModelOverride: true,
          models: names,
        },
      },
    };
    await scope.__zustandStores.config.getState().loadAgentList(true);
  }, modelNames);
}

test('Settings > Agent: in a short window the model menu caps itself to the room on its side and scrolls', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `ModelShortWindow ${Date.now()}`);
    const modelNames = sampleNames(SEEDED_ROW_COUNT);
    await seedModels(page, modelNames);
    await page.setViewportSize({ width: page.viewportSize()!.width, height: SCROLLING_BODY_WINDOW_HEIGHT_PX });
    await openSettingsTab(page, 'Agent');
    const input = page.locator('input[data-testid="project-default-model"]');
    await expect(input).toBeVisible({ timeout: 3000 });

    // To the top of the panel body, so there is little room above the field as well
    // as below it. The settings body scrolls; the window does not.
    await input.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    const field = input.locator('xpath=..');
    await shortenWindowUnder(page, field, SHORT_MENU_ROOM_BELOW_TRIGGER_PX);

    await field.locator('button[aria-label="Open dropdown"]').click();
    const menu = page.locator('[data-testid="project-default-model-menu"]');
    await expect(menu).toBeVisible({ timeout: 3000 });
    // The seed landed: every model is a top-level row, none folded into the versions section.
    await expect(menu.locator('[data-model-option]')).toHaveCount(modelNames.length);
    await waitForMenuEntrance(menu);

    const geometry = await readMenuGeometry(page, {
      trigger: 'div:has(> input[data-testid="project-default-model"])',
      menu: '[data-testid="project-default-model-menu"]',
    });
    expectMenuCappedToRoom(geometry, MODEL_MENU_CAP_PX);
  } finally {
    await browser.close();
  }
});

test('Settings > Terminal: in a short window the font menu caps itself to the room on its side and scrolls', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `FontShortWindow ${Date.now()}`);
    const fontNames = sampleNames(SEEDED_ROW_COUNT).map((name) => `Font ${name}`);
    // Before the panel opens: it asks for the fonts once, as it mounts.
    await page.evaluate((names) => {
      (window as unknown as { electronAPI: { font: { getAvailable: () => Promise<string[]> } } })
        .electronAPI.font.getAvailable = async () => names;
    }, fontNames);
    await page.setViewportSize({ width: page.viewportSize()!.width, height: SCROLLING_BODY_WINDOW_HEIGHT_PX });
    await openSettingsTab(page, 'Terminal');
    const input = page.locator('input[data-testid="terminal-font-family"]');
    await expect(input).toBeVisible({ timeout: 3000 });

    await input.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    const field = input.locator('xpath=..');
    await shortenWindowUnder(page, field, SHORT_MENU_ROOM_BELOW_TRIGGER_PX);

    await field.locator('button[aria-label="Open dropdown"]').click();
    const menu = page.locator('[data-testid="terminal-font-family-menu"]');
    await expect(menu).toBeVisible({ timeout: 3000 });
    // The seed landed: the last font is in the list.
    await expect(menu.locator('[data-font-option]')).toHaveCount(fontNames.length);
    await waitForMenuEntrance(menu);

    const geometry = await readMenuGeometry(page, {
      trigger: 'div:has(> input[data-testid="terminal-font-family"])',
      menu: '[data-testid="terminal-font-family-menu"]',
    });
    expectMenuCappedToRoom(geometry, FONT_MENU_CAP_PX);
  } finally {
    await browser.close();
  }
});

test('Command Terminal: in a short window the command palette caps itself to the room under its kebab and its list scrolls', async () => {
  const sessionId = 'palette-short-window-session';
  const { browser, page } = await launchWithTransientTerminal({
    projectId: 'palette-short-window',
    projectName: 'Palette Short Window',
    sessionId,
  });
  try {
    const commandNames = sampleNames(SEEDED_ROW_COUNT);
    await page.evaluate((names) => {
      (window as unknown as { electronAPI: { agent: { listCommands: () => Promise<unknown[]> } } })
        .electronAPI.agent.listCommands = async () => names.map((name) => ({
          name,
          displayName: `/${name}`,
          description: `Sample command ${name}`,
          argumentHint: '',
          source: 'command',
        }));
    }, commandNames);

    const commandWindow = await openTransientCommandTerminal(page, sessionId);
    // Maximized, so the window's header stays at the top of the page when the page
    // shrinks. A floating window moves when the page gets shorter (its kebab shifted
    // by about 90px), which changes the room under the kebab after it was sized.
    const maximizeButton = commandWindow.getByTestId('command-bar-maximize');
    await maximizeButton.click();
    await expect(maximizeButton).toHaveAttribute('title', /^Restore/);
    const kebabButton = commandWindow.locator('button[title="Actions"]');
    // The palette anchors to the wrapper around the kebab button, not the button.
    const kebabAnchor = commandWindow.locator('div:has(> div > button[title="Actions"])');
    await expect(kebabButton).toBeVisible({ timeout: 3000 });
    await shortenWindowUnder(page, kebabAnchor, PALETTE_ROOM_BELOW_TRIGGER_PX);

    await kebabButton.click();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    const palette = page.locator('[data-testid="command-palette-popover"]');
    await expect(palette).toBeVisible({ timeout: 3000 });
    // The seed landed: the commands arrive after the palette mounted.
    await expect(palette.locator('[data-command-item]')).toHaveCount(commandNames.length);
    await waitForMenuEntrance(palette);

    const geometry = await readMenuGeometry(page, {
      trigger: '[data-testid="command-terminal-window"] div:has(> div > button[title="Actions"])',
      menu: '[data-testid="command-palette-popover"]',
      scroller: '.overflow-y-auto',
    });
    // The palette measured its loading state, which fits under the kebab; the cap
    // is what holds it there once the commands land and the list grows.
    expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.trigger.bottom - GEOMETRY_TOLERANCE_PX);
    expectMenuCappedToRoom(geometry, PALETTE_MENU_CAP_PX);
  } finally {
    await browser.close();
  }
});

/**
 * Seeds the Knowledge Graph with `projectCount` indexed projects and a map that
 * has not been drawn yet, which is the layout that hosts the projects picker with
 * no canvas: the open project first, then the rest. Done after a project is open
 * and before the page opens, which reads both when it opens.
 */
async function seedKnowledgeGraphProjects(page: Page, projectCount: number): Promise<void> {
  await page.evaluate((count) => {
    const scope = window as unknown as {
      electronAPI: {
        knowledgeGraph: {
          graphProjects: () => Promise<unknown[]>;
          graphSnapshot: (projectId?: string | null) => Promise<unknown>;
        };
      };
      __zustandStores: { project: { getState: () => { currentProject: { id: string } | null } } };
    };
    const openProjectId = scope.__zustandStores.project.getState().currentProject?.id ?? 'open-project';
    const bucket = (documents: number, chunks: number) => ({ documents, chunks, tone: 'ok' });
    scope.electronAPI.knowledgeGraph.graphProjects = async () => Array.from({ length: count }, (_unused, index) => ({
      id: index === 0 ? openProjectId : `sample-project-${index}`,
      name: index === 0 ? 'Open project' : `Sample project ${index}`,
      conversations: 10 + index,
      taskRecords: 5,
      lastActivityMs: 1700000000000 - index * 1000,
    }));
    scope.electronAPI.knowledgeGraph.graphSnapshot = async (projectId) => ({
      projectId: projectId ?? openProjectId,
      projection: null,
      building: false,
      buildProgress: null,
      stale: false,
      semanticAvailable: true,
      coverage: {
        indexed: bucket(10, 100),
        sourceMissingButSearchable: bucket(0, 0),
        empty: bucket(0, 0),
        failed: bucket(0, 0),
        notYetIndexed: bucket(0, 0),
        totalDocumentsWithChunks: 10,
        totalChunks: 100,
        totalEmbeddedChunks: 100,
        embeddedFraction: 1,
        knownDocumentIdsMatched: 10,
      },
      index: {
        corpora: [{ corpus: 'conversation', documents: 10, chunks: 100, embeddedChunks: 100, embeds: true }],
        summaries: { written: 0, finishedTasks: 0, awaitingRewrite: 0, writtenWith: [], skipped: 0, state: 'idle', retryInMs: null, choice: null },
        storageBytes: 1048576,
      },
    });
  }, projectCount);
}

test('Knowledge Graph: in a short window the projects menu caps itself to the room on its side and its list scrolls', async () => {
  const { browser, page } = await launchPage();
  try {
    await createProject(page, `ProjectsShortWindow ${Date.now()}`);
    await seedKnowledgeGraphProjects(page, SEEDED_ROW_COUNT);
    await page.locator('[data-testid="knowledge-graph-button"]').click();
    const trigger = page.locator('[data-testid="knowledge-graph-projects"]');
    await expect(trigger).toBeVisible({ timeout: 10000 });
    await shortenWindowUnder(page, trigger, PROJECTS_ROOM_BELOW_TRIGGER_PX);

    await trigger.click();
    const menu = page.locator('[data-testid="knowledge-graph-projects-menu"]');
    await expect(menu).toBeVisible({ timeout: 3000 });
    // The seed landed: every project is a row.
    await expect(menu.locator('[data-testid="knowledge-graph-projects-row"]')).toHaveCount(SEEDED_ROW_COUNT);
    await waitForMenuEntrance(menu);

    const geometry = await readMenuGeometry(page, {
      trigger: '[data-testid="knowledge-graph-projects"]',
      menu: '[data-testid="knowledge-graph-projects-menu"]',
      scroller: '[role="listbox"]',
    });
    expectMenuCappedToRoom(geometry, PROJECTS_MENU_CAP_PX);
  } finally {
    await browser.close();
  }
});
