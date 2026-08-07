/**
 * A dropdown that does not fit below its trigger must flip above, and either
 * way must stay inside the viewport.
 *
 * The bug this pins: `usePopoverPosition` measured the popover with
 * `getBoundingClientRect()`, but `OverlayPopover` plays a grow-in animation
 * starting at `transform: scale(0.96)` and the measuring effect runs on the
 * commit that mounts it. So the popover measured ~4% short, and on a marginal
 * fit the hook concluded "fits below" for a menu that then painted at full size
 * and spilled off the bottom of the screen. The fix reads `offsetWidth` /
 * `offsetHeight`, which are layout dimensions and ignore transforms.
 *
 * The assertion is containment rather than a placement string: "opened above"
 * is the mechanism, "did not run off screen" is the property the user cares
 * about, and it holds for both branches.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject } from './helpers';

test('a dropdown with no room below flips above and stays in the viewport', async () => {
  // Own page and viewport: a short window is what forces the trigger low
  // enough to exercise the flip, and it must not leak into other suites.
  const { browser, page } = await launchPage();
  await page.setViewportSize({ width: 1280, height: 700 });
  await createProject(page, 'PopoverFlip');
  await waitForBoard(page);

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Code Review').click();
  const dialog = page.locator('[data-testid="board-manager-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 3000 });

  // The template-variable picker is a tall menu (10 entries) whose trigger sits
  // at the bottom of the Automation section, so in a short window there is not
  // enough room below it.
  await dialog.locator('[data-testid="auto-command-input"]').fill('/code-review');
  const trigger = dialog.locator('[data-testid="template-variable-trigger"]');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const menu = page.locator('[data-testid="template-variable-menu"]');
  await expect(menu).toBeVisible();

  // Poll past the grow-in animation so the rect is the settled one.
  await expect.poll(async () => {
    const menuBox = await menu.boundingBox();
    const viewportHeight = page.viewportSize()!.height;
    if (!menuBox || menuBox.height === 0) return null;
    // `y`, not `top`: a Playwright bounding box is {x, y, width, height}, and
    // reading `.top` yields undefined, which silently fails every comparison.
    // 1px of tolerance for sub-pixel rounding, per cross-platform-parity.
    return menuBox.y >= -1 && menuBox.y + menuBox.height <= viewportHeight + 1;
  }, { timeout: 3000 }).toBe(true);

  // Non-vacuous: the trigger really was low enough that opening downward would
  // have overflowed, so the containment above was actually load-bearing.
  const triggerBox = (await trigger.boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  const viewportHeight = page.viewportSize()!.height;
  expect(triggerBox.y + triggerBox.height + menuBox.height).toBeGreaterThan(viewportHeight);

  await browser.close();
});
