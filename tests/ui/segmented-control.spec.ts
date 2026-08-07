/**
 * UI tests for the shared `SegmentedControl`, exercised through its live adopter
 * (`ViewToggle`).
 *
 * Two properties are worth a test rather than a review pass:
 *
 *  - **Height parity with `Select`.** The control exists to sit in a row beside
 *    the app's other single-line inputs, and it derives its height from padding
 *    (`p-0.5` track + `py-1` + `text-sm`) rather than a fixed `h-[34px]`, exactly
 *    as `FIELD_CONTROL_CLASS` does. Nothing mechanical ties those two derivations
 *    together, so a change to either silently makes one control the ragged one in
 *    its row. This test is that tie.
 *  - **The radiogroup keyboard model.** `role="radiogroup"` promises a screen
 *    reader one tab stop with arrow-key selection. Rendering a row of buttons
 *    with that role but leaving every option tabbable is the easy regression, and
 *    it is invisible on screen.
 *
 * The thumb is asserted as "covers the selected option", not at a pixel offset:
 * it is measured from live layout, so pinning coordinates would encode this
 * machine's font metrics (see `.claude/rules/cross-platform-parity.md`).
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const PROJECT_NAME = `Segmented Test ${Date.now()}`;
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

const group = () => page.locator('[data-testid="view-toggle-group"]');
const boardOption = () => page.locator('[data-testid="view-toggle-board"]');
const backlogOption = () => page.locator('[data-testid="view-toggle-backlog"]');

/** Leave the board view selected, whichever test ran last. */
test.afterEach(async () => {
  await boardOption().click();
  await expect(boardOption()).toHaveAttribute('aria-checked', 'true');
});

test.describe('SegmentedControl', () => {
  test('matches the shared Select control height', async () => {
    const segmentedBox = await group().boundingBox();
    expect(segmentedBox).not.toBeNull();

    // Open the board manager purely to get a real `Select` on screen. Any
    // column works; the Agent section always renders selects.
    await page.locator('[data-swimlane-name="To Do"]').locator('text=To Do').click();
    const dialog = page.locator('[data-testid="board-manager-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const select = dialog.locator('select').first();
    await expect(select).toBeVisible();
    const selectBox = await select.boundingBox();
    expect(selectBox).not.toBeNull();

    // Both are padding-derived from the same type scale, so they should agree
    // exactly. The tolerance absorbs sub-pixel font-metric differences between
    // Windows and CI's headless Linux, not a design drift: a real mismatch (a
    // dropped `py-1`, a fixed height) moves this by 4px or more.
    expect(Math.abs(segmentedBox!.height - selectBox!.height)).toBeLessThanOrEqual(1.5);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
  });

  test('exposes one tab stop and moves selection with arrow keys', async () => {
    await expect(group()).toHaveAttribute('role', 'radiogroup');
    await expect(boardOption()).toHaveAttribute('role', 'radio');

    // Roving tabindex: the selected option is the only reachable one.
    await expect(boardOption()).toHaveAttribute('aria-checked', 'true');
    await expect(boardOption()).toHaveAttribute('tabindex', '0');
    await expect(backlogOption()).toHaveAttribute('tabindex', '-1');

    await boardOption().focus();
    await page.keyboard.press('ArrowRight');
    await expect(backlogOption()).toHaveAttribute('aria-checked', 'true');
    await expect(backlogOption()).toHaveAttribute('tabindex', '0');
    await expect(boardOption()).toHaveAttribute('tabindex', '-1');
    // Selection is the view, not just a highlight.
    await expect(page.locator('[data-testid="backlog-view"]')).toBeVisible();

    // Wraps, so a two-option control toggles on a repeated press.
    await page.keyboard.press('ArrowRight');
    await expect(boardOption()).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('End');
    await expect(backlogOption()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(boardOption()).toHaveAttribute('aria-checked', 'true');
  });

  test('slides the thumb onto the selected option', async () => {
    const thumb = group().locator('.kng-segmented-thumb');
    await expect(thumb).toBeAttached();

    // The thumb is measured from live layout, so assert containment rather than
    // coordinates: it should sit over whichever option is selected. Polled
    // because the thumb slides over ~150ms, so a single read after a click can
    // land mid-transition.
    const covers = async (option: ReturnType<typeof boardOption>) => {
      await expect.poll(async () => {
        const thumbBox = await thumb.boundingBox();
        const optionBox = await option.boundingBox();
        if (!thumbBox || !optionBox || thumbBox.width === 0) return false;
        // Same span as the option it marks, within sub-pixel rounding.
        return Math.abs(thumbBox.x - optionBox.x) <= 1.5
          && Math.abs(thumbBox.width - optionBox.width) <= 1.5;
      }, { timeout: 3000 }).toBe(true);
    };

    await covers(boardOption());
    await backlogOption().click();
    await expect(backlogOption()).toHaveAttribute('aria-checked', 'true');
    await covers(backlogOption());
  });
});
