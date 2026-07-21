/**
 * UI tests for the Mobile Devices settings tab.
 *
 * Covers the shared/global (below-separator) surface: the enable toggle, the
 * relay mode Select (resolved default vs. custom override) and its draft
 * relay URL input, the pairing ceremony (start pairing -> QR render ->
 * simulated SAS -> confirm), and the paired-device list with
 * revoke-via-ConfirmDialog. Mirrors the structure of browser-settings.spec.ts
 * and hotkeys-settings.spec.ts, the closest precedents for a global settings
 * tab with a toggle + input + list + destructive action.
 *
 * The UI tier's webServer runs plain `vite` (development mode), so
 * __KANGENTIC_DEV__ is always true here and the relay mode Select renders
 * all three options ("Local", "Kangentic Cloud", "Custom Relay") - "Local"
 * is a dev-only Select option, gated behind __KANGENTIC_DEV__ in the
 * component, but is always offered under this tier's dev webServer. Unlike
 * an earlier version of this module, "hosted" resolves to
 * KANGENTIC_HOSTED_RELAY_URL unconditionally (not build-mode-dependent), so
 * this tier actually exercises the "Kangentic Cloud" label and its resolved
 * URL, not just "Local". These literals are hard-coded rather than imported
 * from src/shared/relay.ts, since playwright.config.ts sets no `define` and
 * importing a runtime export from that module into a .spec.ts throws at
 * module load.
 *
 * Every test resets mobileBridge.enabled/relayMode/relayUrl in beforeEach
 * (never afterEach) so the first test to run in a worker does not depend on
 * a prior test having already set a baseline - the mock's default config
 * omits `mobileBridge` entirely, so the component's `?? false` / inferred
 * 'hosted' mode fallbacks are what a fresh page actually renders.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';
import { MOBILE_CAPABILITY_VERBS } from '../../src/shared/types';
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
async function setMobileBridgeConfig(partial: { enabled?: boolean; relayMode?: 'hosted' | 'local' | 'custom'; relayUrl?: string }): Promise<void> {
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
    // Known baseline before every test: bridge enabled, hosted relay mode,
    // empty custom relay URL, no list/status/testRelay overrides left over
    // from a previous test.
    await setMobileBridgeConfig({ enabled: true, relayMode: 'hosted', relayUrl: '' });
    await page.evaluate(() => {
      delete (window as unknown as { __mockMobileDevices?: MobilePairedDevice[] }).__mockMobileDevices;
      delete (window as unknown as { __mockMobileBridgeStatus?: object }).__mockMobileBridgeStatus;
      delete (window as unknown as { __mockTestRelay?: unknown }).__mockTestRelay;
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

  test('hosted mode renders the enable toggle, relay mode select, resolved URL, and section headers', async () => {
    await openMobileTab();
    await expect(page.getByRole('switch')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-relay-mode"]')).toHaveValue('hosted');
    await expect(page.locator('[data-testid="mobile-relay-mode"]')).toContainText('Kangentic Cloud');
    // Read-only resolved URL, not an editable input - the whole point of a
    // resolved mode is that a normal user never sees a text field here. The
    // hosted-relay constant is returned verbatim (not passed through
    // new URL() normalization, unlike a saved custom value).
    await expect(page.locator('[data-testid="mobile-relay-resolved-url"]')).toHaveText('wss://relay.kangentic.com');
    await expect(page.locator('[data-testid="mobile-relay-url-input"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Pair a Device' })).toBeVisible();
    await expect(page.getByText('Paired Devices')).toBeVisible();
    await closeSettings();
  });

  test('the relay mode select offers Local, Kangentic Cloud, and Custom Relay in a dev build', async () => {
    await openMobileTab();
    const select = page.locator('[data-testid="mobile-relay-mode"]');
    const optionLabels = await select.locator('option').allTextContents();
    expect(optionLabels).toEqual(['Local', 'Kangentic Cloud', 'Custom Relay']);
    await closeSettings();
  });

  test('selecting Local resolves to the local dev relay address', async () => {
    await openMobileTab();

    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('local');

    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayMode).toBe('local');
    await expect(page.locator('[data-testid="mobile-relay-resolved-url"]')).toHaveText('ws://127.0.0.1:8080');
    await expect(page.locator('[data-testid="mobile-relay-url-input"]')).toHaveCount(0);

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

  test('selecting Custom Relay reveals the relay URL input and hides the resolved-default line', async () => {
    await openMobileTab();

    await expect(page.locator('[data-testid="mobile-relay-resolved-url"]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-relay-url-input"]')).toHaveCount(0);

    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('custom');

    await expect(page.locator('[data-testid="mobile-relay-url-input"]')).toBeVisible();
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayMode).toBe('custom');
    // Regression check: with an empty custom draft, resolveRelayUrl falls
    // back to the hosted relay internally, but that fallback must never be
    // surfaced next to a Select that reads "Custom Relay" - it read as
    // "picking Custom didn't do anything" (the hosted relay address was
    // still shown underneath). The line is hidden in custom mode now.
    await expect(page.locator('[data-testid="mobile-relay-resolved-url"]')).toHaveCount(0);

    await closeSettings();
  });

  test('editing the relay URL persists the normalized value once, on blur', async () => {
    await setMobileBridgeConfig({ relayMode: 'custom', relayUrl: '' });
    await openMobileTab();

    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    // Typing alone (no blur yet) must not write to config - the whole point
    // of a commit boundary is that each keystroke does not dispose/redial
    // every bridge session.
    await urlInput.pressSequentially('wss://relay.mock.dev');
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayUrl).toBe('');

    await urlInput.blur();
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayUrl).toBe('wss://relay.mock.dev/');

    await closeSettings();
  });

  test('an invalid relay URL shows an inline error and blocks the save', async () => {
    await setMobileBridgeConfig({ relayMode: 'custom', relayUrl: '' });
    await openMobileTab();

    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await urlInput.fill('http://relay.mock.dev');
    await urlInput.blur();

    await expect(page.locator('[data-testid="mobile-relay-url-error"]')).toBeVisible();
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayUrl).toBe('');

    await closeSettings();
  });

  test('the relay URL input is disabled when mobileBridge.enabled === false', async () => {
    await setMobileBridgeConfig({ enabled: false, relayMode: 'custom' });
    await openMobileTab();

    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await expect(urlInput).toBeDisabled();

    await closeSettings();
  });

  test('Test connection renders the reachable and no-response trailing states', async () => {
    await openMobileTab();

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: true, version: '0.4.0' });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    await expect(page.getByText('v0.4.0')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: false, reason: 'ECONNREFUSED' });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    const noResponse = page.getByText('No response');
    await expect(noResponse).toBeVisible();
    await expect(noResponse).toHaveAttribute('title', 'ECONNREFUSED');

    await closeSettings();
  });

  test('a test result does not shift the resolved-URL pill below it', async () => {
    await openMobileTab();

    const resolvedUrl = page.locator('[data-testid="mobile-relay-resolved-url"]');
    const before = await resolvedUrl.boundingBox();
    expect(before).not.toBeNull();

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: false, reason: 'ECONNREFUSED' });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    await expect(page.getByText('No response')).toBeVisible();

    const after = await resolvedUrl.boundingBox();
    expect(after).not.toBeNull();
    // Sub-pixel tolerance rather than exact equality: font metrics and
    // fractional layout rounding differ between local Windows and the headless
    // Linux CI runner, and the invariant under test is "the fixed-height slot
    // stops the pill from reflowing", not "the float is bit-identical".
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);

    await closeSettings();
  });

  test('switching relay mode clears a stale test result rather than showing it next to the new mode', async () => {
    await openMobileTab();

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: false, reason: 'ECONNREFUSED' });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    await expect(page.getByText('No response')).toBeVisible();

    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('custom');
    await expect(page.getByText('No response')).toHaveCount(0);

    await closeSettings();
  });

  test('retargeting mid-probe discards the stale reply AND resets the spinner (does not strand the button disabled)', async () => {
    // Regression coverage for the requestId-generation guard in
    // handleTestRelay(): a probe that resolves AFTER the user has already
    // edited the relay URL must not (a) repopulate the result slot with a
    // verdict for the abandoned URL, or (b) leave testingRelay stuck true
    // (which the earlier, buggier version did by guarding the `finally`
    // reset on the same requestId check as the result assignment).
    await setMobileBridgeConfig({ relayMode: 'custom', relayUrl: 'wss://relay-one.mock.dev' });
    await openMobileTab();

    const testConnectionButton = page.locator('[data-testid="mobile-relay-test-connection"]');
    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');

    // A deferred mock: the probe never resolves until the test explicitly
    // releases it via window.__resolveTestRelay, so the test can hold the
    // in-flight window open long enough to retarget underneath it.
    await page.evaluate(() => {
      let release: ((result: { reachable: boolean; reason?: string }) => void) | null = null;
      (window as unknown as {
        __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; reason?: string }>;
        __resolveTestRelay: (result: { reachable: boolean; reason?: string }) => void;
      }).__mockTestRelay = () => new Promise((resolve) => { release = resolve; });
      (window as unknown as { __resolveTestRelay: (result: { reachable: boolean; reason?: string }) => void }).__resolveTestRelay = (result) => {
        release?.(result);
      };
    });

    await testConnectionButton.click();
    await expect(testConnectionButton).toBeDisabled();

    // Retarget while the probe is still in flight: fill (not append) so the
    // draft stays non-empty throughout, keeping the button's OTHER disable
    // condition (empty custom draft) out of play - this isolates the
    // testingRelay-stuck bug from that unrelated disable reason.
    await urlInput.fill('wss://relay-two.mock.dev');

    // Release the now-abandoned probe with a verdict for relay-one.
    await page.evaluate(() => {
      (window as unknown as { __resolveTestRelay: (result: { reachable: boolean; reason?: string }) => void }).__resolveTestRelay({
        reachable: false,
        reason: 'STALE_PROBE_FOR_RELAY_ONE',
      });
    });

    // Half 2 FIRST, as the gate for half 1: the button recovering to
    // enabled/non-spinning is the only observable signal that the async
    // try/finally chain has actually settled. Checking the negative (half 1)
    // before this would race - a `toHaveCount(0)` sampled before React
    // flushes the (buggy) setRelayTestResult(result) call would pass for the
    // wrong reason, on a mutation that DOES render the stale result a moment
    // later. Waiting for this positive signal first guarantees the try
    // block already ran (and either set or skipped the result) before we
    // inspect it below.
    await expect(testConnectionButton).toBeEnabled();
    await expect(testConnectionButton.locator('svg.animate-spin')).toHaveCount(0);

    // Half 1: the stale verdict must never have rendered.
    await expect(page.getByText('No response')).toHaveCount(0);

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

  test('"Copy pairing link" writes the pairing URI to the clipboard and shows Copied feedback', async () => {
    await openMobileTab();

    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    // Capture instead of hitting the real clipboard: headless clipboard
    // permissions vary by platform, and the captured value is the assertion
    // that matters (the exact URI the phone would paste).
    await page.evaluate(() => {
      const captured: string[] = [];
      (window as unknown as { __copiedPairingLinks: string[] }).__copiedPairingLinks = captured;
      navigator.clipboard.writeText = (text: string) => {
        captured.push(text);
        return Promise.resolve();
      };
    });

    await page.getByRole('button', { name: 'Copy pairing link' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const copied = await page.evaluate(
      () => (window as unknown as { __copiedPairingLinks: string[] }).__copiedPairingLinks,
    );
    expect(copied).toEqual(['kangentic-pair://mock']);

    // The feedback label reverts so the link can be copied again.
    await expect(page.getByRole('button', { name: 'Copy pairing link' })).toBeVisible({ timeout: 5000 });

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

  test('shows a relay status indicator next to Paired Devices once a device is paired', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'status-device-1', displayName: 'Status Device', capabilities: [], pairedAt: new Date().toISOString() },
      ];
      (window as unknown as { __mockMobileBridgeStatus: object }).__mockMobileBridgeStatus = { relayState: 'connected' };
    });

    await openMobileTab();

    const indicator = page.locator('[data-testid="mobile-relay-status"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Connected');

    await closeSettings();
  });

  test('does not show a relay status indicator when there are no paired devices', async () => {
    await openMobileTab();
    await expect(page.locator('[data-testid="mobile-relay-status"]')).toHaveCount(0);
    await closeSettings();
  });

  test('renders no relay status indicator for "idle", even with a device paired (a device-less desktop must never read "Disconnected")', async () => {
    // relayStatusDisplay('idle') deliberately returns null: the aggregate is
    // 'idle' only because no BridgeSession exists yet for this device (e.g.
    // mid-sync), and showing "Disconnected" here would misreport a desktop
    // that in fact has no live-session problem to report.
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'idle-device-1', displayName: 'Idle Device', capabilities: [], pairedAt: new Date().toISOString() },
      ];
      (window as unknown as { __mockMobileBridgeStatus: object }).__mockMobileBridgeStatus = { relayState: 'idle' };
    });

    await openMobileTab();

    await expect(page.locator('li', { hasText: 'Idle Device' })).toBeVisible();
    await expect(page.locator('[data-testid="mobile-relay-status"]')).toHaveCount(0);

    await closeSettings();
  });

  test('shows the "Connecting…" state in amber while a session is dialing', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'connecting-device-1', displayName: 'Connecting Device', capabilities: [], pairedAt: new Date().toISOString() },
      ];
      (window as unknown as { __mockMobileBridgeStatus: object }).__mockMobileBridgeStatus = { relayState: 'connecting' };
    });

    await openMobileTab();

    const indicator = page.locator('[data-testid="mobile-relay-status"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Connecting…');
    await expect(indicator).toHaveClass(/text-amber-400/);

    await closeSettings();
  });

  test('shows the "Reconnecting…" state in amber, distinct from "Connecting…"', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'reconnecting-device-1', displayName: 'Reconnecting Device', capabilities: [], pairedAt: new Date().toISOString() },
      ];
      (window as unknown as { __mockMobileBridgeStatus: object }).__mockMobileBridgeStatus = { relayState: 'reconnecting' };
    });

    await openMobileTab();

    const indicator = page.locator('[data-testid="mobile-relay-status"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Reconnecting…');
    await expect(indicator).not.toContainText('Connecting…');
    await expect(indicator).toHaveClass(/text-amber-400/);

    await closeSettings();
  });

  test('shows the "Disconnected" state in the danger color when the relay is closed', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'closed-device-1', displayName: 'Closed Device', capabilities: [], pairedAt: new Date().toISOString() },
      ];
      (window as unknown as { __mockMobileBridgeStatus: object }).__mockMobileBridgeStatus = { relayState: 'closed' };
    });

    await openMobileTab();

    const indicator = page.locator('[data-testid="mobile-relay-status"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Disconnected');
    await expect(indicator).toHaveClass(/text-danger/);

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
    await expect(switches).toHaveCount(MOBILE_CAPABILITY_VERBS.length);
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
