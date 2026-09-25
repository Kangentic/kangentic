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
 *
 * The subject changed with the surface. This used to open the template-variable
 * picker from the column's auto-command field, which sat low in the board
 * manager's own scrolling form; that field became an automation row, and the
 * template picker moved into `EditAutomationDialog`. A CENTRED nested dialog
 * cannot reproduce the geometry at any window size: as the window grows the
 * room below the trigger grows faster than the trigger descends, so the flip
 * never fires. The Add automation picker has the shape this test needs and is
 * the same hook (`usePopoverPosition`, `mode: 'dropdown'`, `strategy: 'fixed'`)
 * on the same `OverlayPopover`: its trigger is the last control in the
 * automations pane, at the bottom of a dialog that fills most of the window.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, dismissOnboardingChecklist } from './helpers';

test('a dropdown with no room below flips above and stays in the viewport', async () => {
  // Own page and viewport: a short window is what forces the trigger low
  // enough to exercise the flip, and it must not leak into other suites.
  const { browser, page } = await launchPage();
  await createProject(page, 'PopoverFlip');
  await waitForBoard(page);
  // Dismissed BEFORE the window shrinks: the onboarding checklist is taller
  // than this viewport, so its Skip button would fall below the fold while the
  // overlay covered the board.
  await dismissOnboardingChecklist(page);
  await page.setViewportSize({ width: 1280, height: 700 });

  await page.locator('[data-swimlane-name="Code Review"]').locator('text=Code Review').click();
  const dialog = page.locator('[data-testid="board-manager-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 3000 });

  // The On EXIT group's Add control: the last thing in the automations pane,
  // so it sits at the bottom of a dialog that is 88vh tall.
  const trigger = dialog.locator('[data-testid="column-automation-add"][data-trigger="exit"]');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const menu = page.locator('[data-testid="column-automation-picker"]');
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
