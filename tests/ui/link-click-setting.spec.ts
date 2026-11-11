/**
 * Settings > Behavior > Links: which browser a plain click on a link opens.
 *
 * What a user loses if this goes: a control that does not show the choice in force,
 * or one that never reaches the saved config, so a click keeps opening the browser
 * they moved away from. The click itself is pinned in terminal-link-click.spec.ts.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

async function openBehavior(page: Page): Promise<void> {
  await createProject(page, `link-click-setting-${Date.now()}`);
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('settings-tab-list').getByRole('button', { name: 'Behavior', exact: true }).click();
}

async function savedLinkClickTarget(page: Page): Promise<unknown> {
  const globalConfig = await page.evaluate(() => window.electronAPI.config.getGlobal());
  return (globalConfig as { linkClickTarget?: string }).linkClickTarget;
}

test.describe('Settings > Behavior > Links', () => {
  test('shows the Links card with the default browser chosen, and saves a change to the Kangentic browser', async () => {
    const { browser, page } = await launchPage();
    try {
      await openBehavior(page);

      const choice = page.getByTestId('link-click-target-choice');
      await expect(choice).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Links', exact: true })).toBeVisible();
      await expect(choice.getByRole('radio')).toHaveText(['Default browser', 'Kangentic browser']);
      await expect(choice.getByRole('radio', { name: 'Default browser' })).toHaveAttribute('aria-checked', 'true');
      await expect(choice.getByRole('radio', { name: 'Kangentic browser' })).toHaveAttribute('aria-checked', 'false');

      await choice.getByRole('radio', { name: 'Kangentic browser' }).click();

      await expect(choice.getByRole('radio', { name: 'Kangentic browser' })).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => savedLinkClickTarget(page), { timeout: 3000 }).toBe('kangentic');

      // And back, so the saved value follows the control both ways.
      await choice.getByRole('radio', { name: 'Default browser' }).click();
      await expect.poll(() => savedLinkClickTarget(page), { timeout: 3000 }).toBe('default');
    } finally {
      await browser.close();
    }
  });
});
