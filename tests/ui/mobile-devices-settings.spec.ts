/**
 * UI tests for the Mobile Devices settings tab.
 *
 * Covers the shared/global (below-separator) surface: the enable toggle and
 * relay URL input persisting to global config, the pairing ceremony (start
 * pairing -> QR render -> simulated SAS -> confirm), and the paired-device
 * list with revoke-via-ConfirmDialog. Mirrors the structure of
 * browser-settings.spec.ts and hotkeys-settings.spec.ts, the closest
 * precedents for a global settings tab with a toggle + input + list +
 * destructive action.
 *
 * Every test resets mobileBridge.enabled/relayUrl in beforeEach (never
 * afterEach) so the first test to run in a worker does not depend on a
 * prior test having already set a baseline - the mock's default config
 * omits `mobileBridge` entirely, so the component's `?? false` / `?? ''`
 * fallbacks are what a fresh page actually renders.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';
import type { AppConfig, MobilePairedDevice } from '../../src/shared/types';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Mobile Devices Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openMobileTab() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Mobile Devices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pair a Device' })).toBeVisible();
}

async function closeSettings() {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

async function getGlobalConfig(): Promise<AppConfig> {
  return page.evaluate(async () => window.electronAPI.config.getGlobal());
}

/**
 * Sets mobileBridge config via the real config-store action (not the raw
 * IPC mock directly) so the already-mounted MobileDevicesTab reactively
 * re-renders. A raw `window.electronAPI.config.set(...)` call updates the
 * mock's persisted state but bypasses the Zustand store the component
 * subscribes to, leaving the rendered UI stale until some other event
 * happens to trigger a refetch.
 */
async function setMobileBridgeConfig(partial: { enabled?: boolean; relayUrl?: string }): Promise<void> {
  await page.evaluate(async (mobileBridgePartial) => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { updateConfig: (partial: { mobileBridge: typeof mobileBridgePartial }) => Promise<void> } } };
    }).__zustandStores;
    await stores.config.getState().updateConfig({ mobileBridge: mobileBridgePartial });
  }, partial);
}

/** Drives the full pairing ceremony (start -> SAS -> confirm) so the named device lands in the mock's real (non-override) device list, exercising confirmPairing() for real. */
async function pairDevice(displayName: string): Promise<void> {
  await page.getByRole('button', { name: 'Pair a device' }).click();
  await expect(page.getByAltText('Pairing QR code')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as {
      __mockFireMobilePairingSas: (payload: { digits: string; emoji: string[]; phoneStaticPublicKeyHex: string }) => void;
    }).__mockFireMobilePairingSas({ digits: '135790', emoji: ['star'], phoneStaticPublicKeyHex: 'deadbeef' });
  });
  await expect(page.getByText('135790')).toBeVisible();

  const deviceNameInput = page.locator('input[placeholder="Device name (e.g. My iPhone)"]');
  await deviceNameInput.fill(displayName);
  await page.getByRole('button', { name: 'Codes match' }).click();

  await expect(page.locator('li', { hasText: displayName })).toBeVisible();
}

/** Revokes a real, previously-paired device by name via the ConfirmDialog. */
async function revokeDevice(displayName: string): Promise<void> {
  await page.locator('li', { hasText: displayName }).getByTitle('Revoke').click();
  const dialog = page.locator('h3:has-text("Revoke device")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.locator('li', { hasText: displayName })).toHaveCount(0);
}

test.describe('Mobile Devices settings tab', () => {
  test.beforeEach(async () => {
    // Known baseline before every test: bridge enabled, empty relay URL, no
    // list/status overrides left over from a previous test.
    await setMobileBridgeConfig({ enabled: true, relayUrl: '' });
    await page.evaluate(() => {
      delete (window as unknown as { __mockMobileDevices?: MobilePairedDevice[] }).__mockMobileDevices;
      delete (window as unknown as { __mockMobileBridgeStatus?: object }).__mockMobileBridgeStatus;
    });
  });

  test('tab appears below the separator and is visible with no project open', async () => {
    // Independent, project-less page: confirms the tab is a GLOBAL_ONLY_TABS
    // entry (rendered even before any project is opened), not a per-project tab.
    const { browser: freshBrowser, page: freshPage } = await launchPage();
    try {
      await freshPage.locator('[data-testid="settings-button"]').click();
      await freshPage.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
      const tabButton = freshPage.getByRole('button', { name: 'Mobile Devices', exact: true });
      await expect(tabButton).toBeVisible();
      await tabButton.click();
      await expect(freshPage.getByRole('heading', { name: 'Pair a Device' })).toBeVisible();
    } finally {
      await freshBrowser.close();
    }
  });

  test('renders the enable toggle, relay URL input, and section headers', async () => {
    await openMobileTab();
    await expect(page.getByRole('switch')).toBeVisible();
    await expect(page.locator('input[placeholder="wss://relay.example.com"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pair a Device' })).toBeVisible();
    await expect(page.getByText('Paired Devices')).toBeVisible();
    await closeSettings();
  });

  test('toggling enable persists mobileBridge.enabled to global config', async () => {
    await openMobileTab();

    const toggle = page.getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.enabled).toBe(false);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.enabled).toBe(true);

    await closeSettings();
  });

  test('editing the relay URL persists mobileBridge.relayUrl to global config', async () => {
    await openMobileTab();

    const urlInput = page.locator('input[placeholder="wss://relay.example.com"]');
    await urlInput.fill('wss://relay.mock.dev');
    await urlInput.blur();

    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayUrl).toBe('wss://relay.mock.dev');

    await closeSettings();
  });

  test('the relay URL input is disabled when mobileBridge.enabled === false', async () => {
    await setMobileBridgeConfig({ enabled: false });
    await openMobileTab();

    const urlInput = page.locator('input[placeholder="wss://relay.example.com"]');
    await expect(urlInput).toBeDisabled();

    await closeSettings();
  });

  test('clicking "Pair a device" starts pairing and renders a QR code', async () => {
    await openMobileTab();

    await page.getByRole('button', { name: 'Pair a device' }).click();

    const qrImage = page.getByAltText('Pairing QR code');
    await expect(qrImage).toBeVisible();
    // The QR is rendered from a real qrcode.toDataURL() call in the component,
    // so assert it produced actual image data rather than an empty/broken src.
    await expect.poll(async () => (await qrImage.getAttribute('src'))?.startsWith('data:image')).toBe(true);

    await closeSettings();
  });

  test('cancelling an in-progress pairing clears the QR and returns to the start button', async () => {
    await openMobileTab();

    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByAltText('Pairing QR code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();

    await closeSettings();
  });

  test('a simulated SAS renders digits/emoji, and confirming adds the device to the list', async () => {
    await openMobileTab();

    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as {
        __mockFireMobilePairingSas: (payload: { digits: string; emoji: string[]; phoneStaticPublicKeyHex: string }) => void;
      }).__mockFireMobilePairingSas({
        digits: '123456',
        emoji: ['rocket', 'lock', 'star'],
        phoneStaticPublicKeyHex: 'deadbeef',
      });
    });

    await expect(page.getByText('123456')).toBeVisible();
    await expect(page.getByText('rocket lock star')).toBeVisible();

    const deviceNameInput = page.locator('input[placeholder="Device name (e.g. My iPhone)"]');
    await deviceNameInput.fill('SAS Confirm Device');
    await page.getByRole('button', { name: 'Codes match' }).click();

    // confirmPairing() resolves and the store re-fetches listDevices(), which
    // the mock has already pushed the new device into.
    await expect(page.locator('li', { hasText: 'SAS Confirm Device' })).toBeVisible();
    // Pairing UI collapses back to the idle "Pair a device" button.
    await expect(page.getByAltText('Pairing QR code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();

    // Clean up so later tests in this worker don't accumulate leftover devices.
    await revokeDevice('SAS Confirm Device');

    await closeSettings();
  });

  test('"Codes don\'t match" cancels pairing without adding a device', async () => {
    await openMobileTab();

    await page.getByRole('button', { name: 'Pair a device' }).click();
    await page.evaluate(() => {
      (window as unknown as {
        __mockFireMobilePairingSas: (payload: { digits: string; emoji: string[]; phoneStaticPublicKeyHex: string }) => void;
      }).__mockFireMobilePairingSas({ digits: '654321', emoji: ['ghost'], phoneStaticPublicKeyHex: 'facefeed' });
    });
    await expect(page.getByText('654321')).toBeVisible();

    await page.getByRole('button', { name: "Codes don't match" }).click();

    await expect(page.getByText('654321')).toHaveCount(0);
    await expect(page.getByAltText('Pairing QR code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();

    await closeSettings();
  });

  test('paired-device list renders seeded devices with a toggle per capability, checked for granted verbs', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        {
          deviceId: 'seed-device-1',
          displayName: 'Seeded iPhone',
          capabilities: ['read-stream', 'read-board'],
          pairedAt: new Date().toISOString(),
        },
      ];
    });

    await openMobileTab();

    const deviceRow = page.locator('li', { hasText: 'Seeded iPhone' });
    await expect(deviceRow).toBeVisible();
    await expect(deviceRow.getByRole('switch', { name: 'Live output', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(deviceRow.getByRole('switch', { name: 'Board', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(deviceRow.getByRole('switch', { name: 'Interactive terminal', exact: true })).toHaveAttribute('aria-checked', 'false');

    await closeSettings();
  });

  test('devices with no capabilities show every toggle unchecked', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        {
          deviceId: 'seed-device-2',
          displayName: 'Bare Device',
          capabilities: [],
          pairedAt: new Date().toISOString(),
        },
      ];
    });

    await openMobileTab();

    const deviceRow = page.locator('li', { hasText: 'Bare Device' });
    await expect(deviceRow).toBeVisible();
    const switches = deviceRow.getByRole('switch');
    await expect(switches).toHaveCount(9);
    for (const toggle of await switches.all()) {
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    }

    await closeSettings();
  });

  test('toggling a capability grants it and persists via setDeviceCapabilities', async () => {
    await openMobileTab();
    await pairDevice('Capability Toggle Device');

    const deviceRow = page.locator('li', { hasText: 'Capability Toggle Device' });
    // Pairing grants only the read-only default set - interactive-terminal
    // (a write/control verb) starts ungranted.
    const terminalToggle = deviceRow.getByRole('switch', { name: 'Interactive terminal', exact: true });
    await expect(terminalToggle).toHaveAttribute('aria-checked', 'false');

    await terminalToggle.click();
    await expect(terminalToggle).toHaveAttribute('aria-checked', 'true');

    // Persisted through setDeviceCapabilities + a devices re-fetch, not just local UI state.
    await expect.poll(async () =>
      page.evaluate(async () => {
        const devices = await window.electronAPI.mobile.listDevices();
        return devices.find((device) => device.displayName === 'Capability Toggle Device')?.capabilities.includes('interactive-terminal');
      }),
    ).toBe(true);

    // Toggling off removes it again.
    await terminalToggle.click();
    await expect(terminalToggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () =>
      page.evaluate(async () => {
        const devices = await window.electronAPI.mobile.listDevices();
        return devices.find((device) => device.displayName === 'Capability Toggle Device')?.capabilities.includes('interactive-terminal');
      }),
    ).toBe(false);

    await revokeDevice('Capability Toggle Device');
    await closeSettings();
  });

  test('revoke: Cancel keeps the device, Revoke removes it via revokeDevice()', async () => {
    await openMobileTab();
    await pairDevice('Revoke Target Device');

    // Cancel path: dialog closes, device stays in the list.
    await page.locator('li', { hasText: 'Revoke Target Device' }).getByTitle('Revoke').click();
    const dialog = page.locator('h3:has-text("Revoke device")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Revoke Target Device');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('li', { hasText: 'Revoke Target Device' })).toBeVisible();

    // Confirm path: the device is actually removed by the mock's revokeDevice().
    await revokeDevice('Revoke Target Device');

    await closeSettings();
  });
});
