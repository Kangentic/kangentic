/**
 * UI tests for the Browser tab in the App Settings panel.
 *
 * Covers two independent surfaces that share the same tab:
 *   - "Browser settings tab" describe: Clear Browser Data action (confirm
 *     dialog, success/error toasts, button idle state).
 *   - "Settings -> Browser tab" describe: project-overridable
 *     browser.enabled toggle and browser.defaultUrl input persistence.
 *
 * Helpers (launchPage, openBrowserTab, closeSettings) are shared because
 * both describe blocks need the same Settings panel scaffold.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Browser Settings Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openBrowserTab() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(page.getByText('Enable Browser Pane')).toBeVisible();
}

async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

async function getBrowserOverrides() {
  return page.evaluate(async () => {
    const overrides = await window.electronAPI.config.getProjectOverrides();
    return overrides?.browser ?? null;
  });
}

test.describe('Browser settings tab', () => {
  test('exposes Clear Browser Data row with destructive button', async () => {
    await openBrowserTab();
    await expect(page.getByText('Clear Browser Data')).toBeVisible();
    await expect(page.getByTestId('browser-clear-storage')).toBeVisible();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');
    await closeSettings();
  });

  test('Clear data -> Cancel keeps button idle and fires no toast', async () => {
    await openBrowserTab();
    await page.getByTestId('browser-clear-storage').click();

    await expect(page.locator('h3:has-text("Clear browser data?")')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h3:has-text("Clear browser data?")')).toBeHidden();

    // No toast should appear
    await expect(page.getByTestId('toast')).toHaveCount(0);
    // Button is back to idle (not disabled, label "Clear data")
    await expect(page.getByTestId('browser-clear-storage')).toBeEnabled();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');
    await closeSettings();
  });

  test('Clear data -> Confirm wipes via IPC and shows success toast', async () => {
    await openBrowserTab();

    // Spy: count clearStorage invocations on the mock
    await page.evaluate(() => {
      (window as unknown as { __browserClearCalls: number }).__browserClearCalls = 0;
      const original = window.electronAPI.browser.clearStorage;
      window.electronAPI.browser.clearStorage = async () => {
        (window as unknown as { __browserClearCalls: number }).__browserClearCalls += 1;
        return original();
      };
    });

    await page.getByTestId('browser-clear-storage').click();
    const dialog = page.locator('h3:has-text("Clear browser data?")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
    await expect(dialog).toBeVisible();
    // Confirm uses the destructive label - scoped to the dialog footer to
    // disambiguate from the settings-row button that has the same label
    await dialog.getByRole('button', { name: 'Clear data', exact: true }).click();

    await expect(page.getByTestId('toast').filter({ hasText: 'Browser data cleared. Reload the browser pane to apply.' })).toBeVisible();

    const callCount = await page.evaluate(
      () => (window as unknown as { __browserClearCalls: number }).__browserClearCalls,
    );
    expect(callCount).toBe(1);

    // Button returns to idle after the action resolves
    await expect(page.getByTestId('browser-clear-storage')).toBeEnabled();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');
    await closeSettings();
  });

  test('confirm dialog has no "Don\'t ask again" checkbox', async () => {
    await openBrowserTab();
    await page.getByTestId('browser-clear-storage').click();
    await expect(page.locator('h3:has-text("Clear browser data?")')).toBeVisible();
    await expect(page.getByText("Don't ask again")).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await closeSettings();
  });

  test('shows error toast and returns button to idle when clearStorage rejects', async () => {
    await openBrowserTab();

    // Monkeypatch clearStorage to reject with a specific error before clicking.
    await page.evaluate(() => {
      window.electronAPI.browser.clearStorage = async () => {
        throw new Error('simulated electron failure');
      };
    });

    await page.getByTestId('browser-clear-storage').click();

    const dialog = page.locator('h3:has-text("Clear browser data?")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear data', exact: true }).click();

    // Error toast must contain the static prefix and the thrown message.
    await expect(
      page.getByTestId('toast').filter({ hasText: 'Failed to clear browser data' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('toast').filter({ hasText: 'simulated electron failure' }),
    ).toBeVisible();

    // Button must return to idle state: enabled and labelled "Clear data".
    await expect(page.getByTestId('browser-clear-storage')).toBeEnabled();
    await expect(page.getByTestId('browser-clear-storage')).toContainText('Clear data');

    await closeSettings();
  });
});

test.describe('Settings -> Browser tab', () => {
  test.afterEach(async () => {
    // Reset overrides between tests so each starts in a known state.
    await page.evaluate(() => window.electronAPI.config.setProjectOverrides({}));
  });

  test('Enable Browser Pane and Default URL controls render', async () => {
    await openBrowserTab();

    await expect(page.getByText('Enable Browser Pane')).toBeVisible();
    await expect(page.getByText('Default URL', { exact: true })).toBeVisible();
    await expect(page.locator('input[placeholder="http://localhost:5173"]')).toBeVisible();

    await closeSettings();
  });

  test('toggling Enable Browser Pane persists browser.enabled override', async () => {
    await openBrowserTab();

    // BrowserTab currently exposes a single ToggleSwitch (browser.enabled).
    // If a second toggle is added, swap to a row-scoped selector
    // (e.g. `page.getByText('Enable Browser Pane').locator('xpath=ancestor::div[contains(@class,"space-y")]').getByRole('switch')`).
    const toggle = page.getByRole('switch').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await expect.poll(async () => (await getBrowserOverrides())?.enabled).toBe(false);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await getBrowserOverrides())?.enabled).toBe(true);

    await closeSettings();
  });

  test('Default URL input is disabled when browser.enabled === false', async () => {
    await page.evaluate(() => window.electronAPI.config.setProjectOverrides({
      browser: { enabled: false },
    }));

    await openBrowserTab();

    const urlInput = page.locator('input[placeholder="http://localhost:5173"]');
    await expect(urlInput).toBeDisabled();

    await closeSettings();
  });

  test('typing a default URL persists it to project overrides', async () => {
    await openBrowserTab();

    const urlInput = page.locator('input[placeholder="http://localhost:5173"]');
    await urlInput.fill('http://localhost:4321');
    // Blur to ensure onChange has propagated through the synchronous mock.
    await urlInput.blur();

    await expect.poll(async () => (await getBrowserOverrides())?.defaultUrl).toBe('http://localhost:4321');

    await closeSettings();
  });

  test('clearing the input persists empty string (not undefined)', async () => {
    await page.evaluate(() => window.electronAPI.config.setProjectOverrides({
      browser: { defaultUrl: 'http://localhost:5173' },
    }));

    await openBrowserTab();

    const urlInput = page.locator('input[placeholder="http://localhost:5173"]');
    await expect(urlInput).toHaveValue('http://localhost:5173');

    await urlInput.fill('');
    await urlInput.blur();

    // Empty string is the documented sentinel for "no project default".
    await expect.poll(async () => (await getBrowserOverrides())?.defaultUrl).toBe('');

    await closeSettings();
  });
});
