/**
 * Coverage for `settingCooldownKey` (src/renderer/components/settings/AppSettingsPanel.tsx):
 * the failed-write toast's 60s cooldown is keyed by the LEAF dot-path a write touches
 * (e.g. `git.initScript`), not by the top-level config key (`git`).
 *
 * Nearly every setting lives under a nested parent, so a top-level-key bucket would silence a
 * whole tab after its first failure: a failed `git.worktreesEnabled` would suppress a DIFFERENT
 * setting under the same `git` key (`git.initScript`) failing moments later, which is the exact
 * silence the per-setting cooldown exists to remove (Sentry DESKTOP-1C). This mirrors
 * settings-write-failure-toast.spec.ts's shape, but drives two DIFFERENT leaves under the SAME
 * top-level key rather than two different top-level keys, which is the case that specifically
 * distinguishes a leaf-keyed cooldown from a top-level-keyed one.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Page } from '@playwright/test';

const FAILURE_TOAST = 'This setting did not save';

async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByTestId('settings-tab-list').getByRole('button', { name, exact: true }).click();
}

function failureToasts(page: Page) {
  return page.locator('[data-testid="toast"]').filter({ hasText: FAILURE_TOAST });
}

/** Makes every config write report a failed disk write, as a full disk would. */
async function failEveryConfigWrite(page: Page): Promise<void> {
  await page.evaluate(() => { window.__mockConfigSetPersisted = false; });
}

test.describe('settings write failure toast - per-leaf cooldown', () => {
  test('two different LEAF settings under the same top-level key both toast within the cooldown window', async () => {
    const { browser, page } = await launchPage();
    try {
      await createProject(page, `settings-cooldown-leaf-${Date.now()}`);
      await openSettings(page);
      await failEveryConfigWrite(page);
      await openTab(page, 'Git');

      // Both settings below write under the SAME top-level `git` key. Reverting
      // settingCooldownKey to `Object.keys(partial)[0]` would bucket BOTH of these to
      // "git", so the second failure would be silently suppressed by the first's cooldown.
      await page.getByTestId('setting-row-git.worktreesEnabled').click();
      await expect(failureToasts(page)).toHaveCount(1, { timeout: 5000 });

      const initScript = page.getByTestId('setting-row-git.initScript').locator('input');
      await initScript.click();
      await initScript.type('npm install', { delay: 20 });
      await initScript.blur();

      await expect(failureToasts(page)).toHaveCount(2, { timeout: 5000 });
    } finally {
      await browser.close();
    }
  });
});
