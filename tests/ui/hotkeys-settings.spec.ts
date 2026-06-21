import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Hotkeys Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openHotkeys() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  await page.getByTestId('hotkeys-tab').waitFor({ state: 'visible', timeout: 3000 });
}

async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

/** Rebind one row's shortcut by capturing the given key chord. */
async function rebind(rowTestId: string, chord: string) {
  const row = page.getByTestId(rowTestId);
  await row.getByTestId('key-capture-input').click();
  const box = page.getByTestId('key-capture-box');
  await box.waitFor({ state: 'visible', timeout: 2000 });
  await box.focus();
  await page.keyboard.press(chord);
}

test.describe('Hotkeys settings tab', () => {
  test('appears below the separator with the OS warning banner and group headers', async () => {
    await openHotkeys();
    const tab = page.getByTestId('hotkeys-tab');
    await expect(page.getByTestId('os-hotkey-banner')).toBeVisible();
    // Group headers (SectionHeader renders the label text). Scoped to the tab so
    // the sidebar's "Terminal" tab button doesn't collide.
    await expect(tab.getByText('General', { exact: true })).toBeVisible();
    await expect(tab.getByText('Task Detail', { exact: true })).toBeVisible();
    await expect(tab.getByText('Terminal', { exact: true })).toBeVisible();
    // Browser shortcuts are registered but hidden from the panel.
    await expect(tab.getByText('Browser', { exact: true })).toHaveCount(0);
    await closeSettings();
  });

  test('lists the header-click close binding with its default mouse button', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-panel.closeViaHeaderClick');
    await expect(row).toBeVisible();
    // The default binding renders as a single readable mouse-button segment, and
    // the row is rebindable (a capture input is present).
    await expect(row.getByText('Middle Click')).toBeVisible();
    await expect(row.getByTestId('key-capture-input')).toBeVisible();
    await closeSettings();
  });

  test('terminal (non-rebindable) rows are read-only with no capture input', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-terminal.copy');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('key-capture-input')).toHaveCount(0);
    await closeSettings();
  });

  test('rebinding a shortcut shows a Custom pill and enables reset; reset restores default', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-view.toggleSidebar');
    const resetButton = row.getByTestId('hotkey-reset-view.toggleSidebar');

    await expect(resetButton).toBeDisabled();
    await rebind('hotkey-row-view.toggleSidebar', 'Control+Shift+G');

    await expect(row.getByText('Custom')).toBeVisible();
    await expect(resetButton).toBeEnabled();

    await resetButton.click();
    await expect(row.getByText('Custom')).toHaveCount(0);
    await expect(resetButton).toBeDisabled();
    await closeSettings();
  });

  test('Escape cancels capture without changing the binding', async () => {
    await openHotkeys();
    const row = page.getByTestId('hotkey-row-view.toggleSidebar');
    await row.getByTestId('key-capture-input').click();
    await page.getByTestId('key-capture-box').waitFor({ state: 'visible', timeout: 2000 });

    await page.keyboard.press('Escape');
    // Back to idle: the Rebind button is visible again and no override was set.
    await expect(row.getByTestId('key-capture-input')).toBeVisible();
    await expect(row.getByText('Custom')).toHaveCount(0);
    await closeSettings();
  });

  test('binding two same-scope actions to one combo flags a conflict on both', async () => {
    await openHotkeys();
    // commandBar.toggle defaults to Mod+Shift+P (global). Rebind view.toggleSidebar
    // (also global) onto the same combo to force a conflict.
    await rebind('hotkey-row-view.toggleSidebar', 'Control+Shift+P');

    await expect(page.getByTestId('hotkey-conflict-view.toggleSidebar')).toBeVisible();
    await expect(page.getByTestId('hotkey-conflict-commandBar.toggle')).toBeVisible();
    await expect(page.getByTestId('hotkey-conflict-summary')).toBeVisible();

    // Clean up so later tests start from defaults.
    await page.getByTestId('hotkey-reset-view.toggleSidebar').click();
    await expect(page.getByTestId('hotkey-conflict-view.toggleSidebar')).toHaveCount(0);
    await closeSettings();
  });

  test('flags a combo already in use by another app (probe)', async () => {
    // Make the probe report commandBar.toggle's default combo as taken.
    await page.evaluate(() => {
      (window as unknown as { __mockProbeGlobal: Record<string, string> }).__mockProbeGlobal = {
        'Mod+Shift+P': 'taken',
      };
    });
    await openHotkeys();
    await expect(page.getByTestId('hotkey-taken-commandBar.toggle')).toBeVisible();
    await closeSettings();
    await page.evaluate(() => {
      delete (window as unknown as { __mockProbeGlobal?: Record<string, string> }).__mockProbeGlobal;
    });
  });

  test('Reset all to defaults clears every override', async () => {
    await openHotkeys();
    await rebind('hotkey-row-view.toggleSidebar', 'Control+Shift+G');
    await expect(page.getByTestId('hotkey-row-view.toggleSidebar').getByText('Custom')).toBeVisible();

    await page.getByTestId('hotkeys-reset-all').click();
    await page.getByRole('button', { name: 'Reset all', exact: true }).click();

    await expect(page.getByTestId('hotkey-row-view.toggleSidebar').getByText('Custom')).toHaveCount(0);
    await closeSettings();
  });
});
