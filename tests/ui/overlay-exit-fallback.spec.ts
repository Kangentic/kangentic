/**
 * useOverlayPhase's exit fallback: every overlay must still unmount when its
 * exit `animationend` never fires. Chromium dropped it on 1 to 3 percent of
 * closes with animation durations forced to 0s, and a hidden window stalls it.
 * Before the fix that left the overlay mounted forever, because `requestClose`
 * is a no-op once the phase is `exiting`, so Escape, the X, and a backdrop
 * click all went dead.
 *
 * The stylesheet `beforeAll` installs reproduces the failure on demand instead
 * of waiting for the rare real drop: `animation: none` never dispatches
 * `animationend` at all, which is the exact condition the fallback covers.
 */
import { test, expect } from '@playwright/test';
import { launchPage, waitForBoard, createProject, createTask } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `Overlay Exit Fallback Test ${Date.now()}`;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, PROJECT_NAME);

  // Installed once for the whole file: a stylesheet rule, not an inline style,
  // so it keeps matching every future element that picks up one of these exit
  // classes across all tests below. `!important` beats index.css's own
  // same-specificity class rule regardless of injection order.
  await page.addStyleTag({
    content:
      '.overlay-content-out, .overlay-backdrop-out, .overlay-panel-out, ' +
      '.overlay-popover-out, .overlay-command-bar-out { animation: none !important; }',
  });
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('Overlay exit fallback (animationend never fires)', () => {
  test('New Task dialog (BaseDialog, dialog variant) still closes on Escape', async () => {
    const column = page.locator('[data-swimlane-name="To Do"]');
    await column.locator('text=Add task').click();

    const dialog = page.getByTestId('new-task-dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');

    // EXIT_FALLBACK_MS is 300ms; give real headroom over that for CI/local
    // timing variance. Without the fallback this dialog stays mounted
    // indefinitely, so a generous timeout costs nothing on the passing path.
    await expect(dialog).toHaveCount(0, { timeout: 5000 });
  });

  test('Settings panel (SettingsPanelShell, panel variant) still closes on Escape', async () => {
    await page.locator('[data-testid="settings-button"]').click();

    const panel = page.getByTestId('settings-panel');
    await expect(panel).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(panel).toHaveCount(0, { timeout: 5000 });
  });

  test('Task-detail window (WindowFrame, dialog variant) still closes on Escape', async () => {
    // WindowFrame is the site the fix touched directly: it used to run its OWN
    // private 300ms fallback (removed) and now relies solely on the hook's.
    // This is the regression test for that removal.
    const title = `Overlay Fallback Task ${Date.now()}`;
    await createTask(page, title);

    const card = page.locator('[data-testid="swimlane"]').locator(`text=${title}`).first();
    await card.click();

    const detailDialog = page.getByTestId('task-detail-dialog');
    await expect(detailDialog).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(detailDialog).toHaveCount(0, { timeout: 5000 });
    await waitForBoard(page);
  });
});
