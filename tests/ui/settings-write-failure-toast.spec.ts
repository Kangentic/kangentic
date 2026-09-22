/**
 * Sentry DESKTOP-1C: a settings change that does not reach disk must say so.
 *
 * Main already reports the machine-level condition once per failing write source
 * (`config:writeFailed`, covered by config-write-failed-toast.spec.ts). That notice is
 * latched, and the busiest writer of source `config` is the 500 ms window-bounds
 * debounce, so it is usually spent on a window move nobody was thinking about. Every
 * settings change afterwards was silent: the panel accepted the value and it never
 * persisted.
 *
 * The second mechanism is the settings panel reading `config:set`'s `persisted` flag.
 * These cases drive it through the mock's `__mockConfigSetPersisted` hook, which makes
 * every config write resolve `{ persisted: false }` exactly as a full disk would.
 *
 * Each case owns its page: the cooldown is a per-key timestamp held in a ref on the
 * panel, so a page where an earlier case already toasted for the same key would
 * suppress the very toast the next case asserts.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject, toastCountRightNow } from './helpers';
import type { Page } from '@playwright/test';

const FAILURE_TOAST = 'This setting did not save';

/** Open the Settings panel via the title-bar gear. With a project open this also sets
 *  `projectSettingsPath`, which the project-scoped write path needs. */
async function openSettings(page: Page) {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

async function openTab(page: Page, name: string) {
  await page.getByTestId('settings-tab-list').getByRole('button', { name, exact: true }).click();
}

function failureToasts(page: Page) {
  return page.locator('[data-testid="toast"]').filter({ hasText: FAILURE_TOAST });
}

/** Makes every config write report a failed disk write, as a full disk would. */
async function failEveryConfigWrite(page: Page) {
  await page.evaluate(() => { window.__mockConfigSetPersisted = false; });
}

test.describe('settings write failure toast', () => {
  test('a global-scope setting that did not persist toasts, and a DIFFERENT setting toasts again', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-write-failure-global-${Date.now()}`);
      await openSettings(page);
      await failEveryConfigWrite(page);
      await openTab(page, 'Board');

      // `skipBoardConfigConfirm` - top-level config key `skipBoardConfigConfirm`.
      // A SettingToggleRow puts its testid on the `role="switch"` element itself
      // (ToggleCard), unlike a SettingRow, whose testid is on a wrapping div.
      await page.getByTestId('setting-row-skipBoardConfigConfirm').click();
      await expect(failureToasts(page)).toHaveCount(1, { timeout: 5000 });

      // `animationsEnabled` is a DIFFERENT top-level key, so the per-key cooldown must
      // not silence it. This is the regression the cooldown could reintroduce: a plain
      // timer would let one setting's toast swallow the next setting's failure, which
      // is the same silence this whole feature exists to remove.
      //
      // It lives on Performance now, not Board, so this crosses a tab. Keeping the
      // same two keys matters more than staying on one tab: the pair is chosen to be
      // two distinct top-level keys, which is the whole point of the assertion.
      await openTab(page, 'Performance');
      await page.getByTestId('setting-row-animationsEnabled').click();
      await expect(failureToasts(page)).toHaveCount(2, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a project-scope setting reports too', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-write-failure-project-${Date.now()}`);
      await openSettings(page);
      await failEveryConfigWrite(page);
      await openTab(page, 'Git');

      // The project half routes through a different channel
      // (`config:setProjectOverridesByPath`, not `config:set`), so it would stay silent
      // if only the global handler returned the flag.
      await page.getByTestId('setting-row-git.worktreesEnabled').click();

      await expect(failureToasts(page)).toHaveCount(1, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a field that still writes per keystroke toasts once, not once per character', async () => {
    // Text fields now commit on blur (SettingTextInput), but NUMBER fields still write
    // on every keystroke: typing "120" into a timeout writes 1, then 12, then 120. The
    // Theme tab's swatch grid is the same shape on every arrow key. That is what the
    // per-key cooldown is for, and it is why this case uses a number field.
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-write-failure-burst-${Date.now()}`);
      await openSettings(page);
      await failEveryConfigWrite(page);
      await openTab(page, 'Behavior');

      const idleTimeout = page.getByTestId('setting-row-agent.idleTimeoutMinutes').locator('input');
      await idleTimeout.click();
      await idleTimeout.fill('');
      await idleTimeout.type('120', { delay: 20 });

      await expect(failureToasts(page)).toHaveCount(1, { timeout: 5000 });
      // Hold past the last keystroke to prove nothing further arrives, rather than
      // asserting on a count that simply had not caught up yet.
      await page.waitForTimeout(500);
      await expect(failureToasts(page)).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a settings text field writes once per edit, not once per character', async () => {
    // The SettingTextInput boundary itself, measured where it is cheapest to see: with
    // every write failing, one toast means one write. Before the boundary, typing 11
    // characters was 11 writes (and 11 synchronous whole-config disk writes in main).
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-text-commit-${Date.now()}`);
      await openSettings(page);
      await failEveryConfigWrite(page);
      await openTab(page, 'Git');

      const initScript = page.getByTestId('setting-row-git.initScript').locator('input');
      await initScript.click();
      await initScript.type('npm install', { delay: 20 });
      // Still nothing: the draft has not been committed, so no write has been attempted.
      // Counted RIGHT NOW rather than with toHaveCount(0): a 12s toast dies inside the
      // expect-retry window, so a retrying zero-check would also pass against 11 toasts.
      await page.waitForTimeout(400);
      expect(await toastCountRightNow(page, FAILURE_TOAST)).toBe(0);

      // The positive half, and the reason the zero above means anything: the blur DOES
      // write, so "no toast while typing" is a boundary rather than a dead field.
      await initScript.blur();
      await expect(failureToasts(page)).toHaveCount(1, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('a REJECTED write reports too, without the data-folder clause', async () => {
    // The project-scoped handlers throw for an unknown or unopened project. That used
    // to land as a silent unhandled rejection - the same class of bug as the degraded
    // write above, and the thing #664 set out to remove.
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-write-rejects-${Date.now()}`);
      await openSettings(page);
      await page.evaluate(() => { window.__mockConfigSetRejects = 'Unknown project path'; });
      // Driven through a PROJECT-scope setting deliberately. `config:set` has no throw
      // path in production at all - only `config:setProject` and
      // `config:setProjectByPath` reject, and only for an unknown or unopened project.
      // A global-scope setting here would still pass, because the mock rejects on every
      // channel, while proving nothing about the one that can actually reject.
      await openTab(page, 'Git');

      await page.getByTestId('setting-row-git.worktreesEnabled').click();

      const toast = page.locator('[data-testid="toast"]').filter({ hasText: FAILURE_TOAST });
      await expect(toast).toHaveCount(1, { timeout: 5000 });
      // A rejected call is not evidence the data folder is unwritable, so that clause
      // must not appear.
      await expect(toast).not.toContainText('data folder');
    } finally {
      await browser.close();
    }
  });

  test('a setting that DID persist raises no toast', async () => {
    // Guards against the toast firing on the happy path, which would make every
    // settings change in normal use raise an error toast.
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-write-ok-${Date.now()}`);
      await openSettings(page);
      await openTab(page, 'Board');

      await page.getByTestId('setting-row-skipBoardConfigConfirm').click();

      // Assert the write LANDED before asserting no toast. Without this the case passes
      // just as well when the click did nothing at all, which is the failure mode
      // toastCountRightNow's docblock warns about: "no toast" and "nothing happened"
      // are the same observation until something proves the path ran.
      await expect
        .poll(() => page.evaluate(async () => (await window.electronAPI.config.getGlobal()).skipBoardConfigConfirm))
        .toBe(true);

      expect(await toastCountRightNow(page, FAILURE_TOAST)).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
