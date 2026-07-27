/**
 * UI tests for the Mobile Devices settings tab.
 *
 * Covers the shared/global (below-separator) surface: the enable toggle, the
 * relay mode Select (resolved default vs. custom override) and its draft
 * relay URL input, the pairing ceremony (start pairing -> QR render ->
 * simulated SAS -> the phone's confirm frame auto-enrolling the device, with
 * no second desktop-side confirmation), and the paired-device list (key
 * fingerprint, live connection state, paired date, rename, revoke-via-
 * ConfirmDialog). Mirrors the structure of browser-settings.spec.ts and
 * hotkeys-settings.spec.ts, the closest precedents for a global settings tab
 * with a toggle + input + list + destructive action.
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

/**
 * Drives the full pairing ceremony (start -> SAS -> phone confirm frame) so
 * the named device lands in the mock's real (non-override) device list.
 * __mockCompleteMobilePairing stands in for the phone tapping Confirm: the
 * desktop auto-enrolls with no second tap of its own.
 */
async function pairDevice(displayName: string): Promise<void> {
  await page.getByRole('button', { name: 'Pair a device' }).click();
  await expect(page.getByAltText('Pairing QR code')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as {
      __mockFireMobilePairingSas: (payload: { digits: string; phoneStaticPublicKeyHex: string }) => void;
    }).__mockFireMobilePairingSas({ digits: '135790', phoneStaticPublicKeyHex: 'deadbeef' });
  });
  await expect(page.getByTestId('mobile-pair-sas-digits')).toHaveText('135790');

  await page.evaluate((name) => {
    (window as unknown as { __mockCompleteMobilePairing: (displayName: string) => void }).__mockCompleteMobilePairing(name);
  }, displayName);

  await expect(page.locator('li', { hasText: displayName })).toBeVisible();
}

/** Revokes a real, previously-paired device by name via the ConfirmDialog. */
async function revokeDevice(displayName: string): Promise<void> {
  await page.locator('li', { hasText: displayName }).getByTestId('mobile-device-revoke').click();
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

  test('the waiting panel shows the SAS digits with no emoji, and the phone confirm frame auto-enrolls the device with no second tap', async () => {
    await openMobileTab();

    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as {
        __mockFireMobilePairingSas: (payload: { digits: string; phoneStaticPublicKeyHex: string }) => void;
      }).__mockFireMobilePairingSas({ digits: '123456', phoneStaticPublicKeyHex: 'deadbeef' });
    });

    const waitingPanel = page.getByTestId('mobile-pair-waiting');
    await expect(waitingPanel).toBeVisible();
    await expect(page.getByTestId('mobile-pair-sas-digits')).toHaveText('123456');
    // No emoji rendered anywhere in the waiting panel - the digits alone
    // carry the full transcript-hash comparison.
    await expect(waitingPanel).not.toContainText(/[\u{1F300}-\u{1FAFF}]/u);

    // The phone's confirm frame arrives - the desktop auto-enrolls with no
    // "Codes match" button anywhere for the human to click.
    await page.evaluate(() => {
      (window as unknown as { __mockCompleteMobilePairing: (displayName: string) => void }).__mockCompleteMobilePairing('SAS Confirm Device');
    });

    await expect(page.getByText('Paired: SAS Confirm Device')).toBeVisible();
    await expect(page.locator('li', { hasText: 'SAS Confirm Device' })).toBeVisible();
    await expect(page.getByAltText('Pairing QR code')).toHaveCount(0);

    // Clean up so later tests in this worker don't accumulate leftover devices.
    await revokeDevice('SAS Confirm Device');

    await closeSettings();
  });

  test('cancelling from the waiting panel cancels pairing without adding a device', async () => {
    await openMobileTab();

    await page.getByRole('button', { name: 'Pair a device' }).click();
    await page.evaluate(() => {
      (window as unknown as {
        __mockFireMobilePairingSas: (payload: { digits: string; phoneStaticPublicKeyHex: string }) => void;
      }).__mockFireMobilePairingSas({ digits: '654321', phoneStaticPublicKeyHex: 'facefeed' });
    });
    await expect(page.getByTestId('mobile-pair-waiting')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByTestId('mobile-pair-waiting')).toHaveCount(0);
    await expect(page.getByAltText('Pairing QR code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();

    await closeSettings();
  });

  test('a "cancelled" pairing-ended push clears the ceremony but shows no error message', async () => {
    // Exercises the pairingEnded push handler's kind gate directly (the
    // main-process 'cancelled' path - e.g. the panel closing mid-ceremony -
    // not just the desktop's own Cancel button, which is covered by the
    // "cancelling from the waiting panel" test above).
    await openMobileTab();
    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as {
        __mockFireMobilePairingEnded: (payload: { reason: string; kind: 'cancelled' | 'failed' }) => void;
      }).__mockFireMobilePairingEnded({ reason: 'CANCELLED_REASON_TEXT_SHOULD_NOT_SHOW', kind: 'cancelled' });
    });

    await expect(page.getByAltText('Pairing QR code')).toHaveCount(0);
    const startButton = page.getByRole('button', { name: 'Pair a device' });
    await expect(startButton).toBeVisible();
    await expect(page.getByText('CANCELLED_REASON_TEXT_SHOULD_NOT_SHOW')).toHaveCount(0);

    await closeSettings();
  });

  test('a "failed" pairing-ended push shows the reason as an inline error', async () => {
    await openMobileTab();
    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as {
        __mockFireMobilePairingEnded: (payload: { reason: string; kind: 'cancelled' | 'failed' }) => void;
      }).__mockFireMobilePairingEnded({ reason: 'MOCK_PAIRING_FAILURE_REASON', kind: 'failed' });
    });

    await expect(page.getByAltText('Pairing QR code')).toHaveCount(0);
    const startButton = page.getByRole('button', { name: 'Pair a device' });
    await expect(startButton).toBeVisible();
    const errorText = page.getByText('MOCK_PAIRING_FAILURE_REASON');
    await expect(errorText).toBeVisible();
    await expect(errorText).toHaveClass(/text-danger/);

    await closeSettings();
  });

  test('Part 4 regression: closing Settings mid-ceremony and reopening lets "Pair a device" show a fresh QR again', async () => {
    // Historically the "Pair a device" click silently no-op'd the second time
    // if the panel was closed while a ceremony was in progress - the
    // main-process activePairing guard threw, and the tab awaited the
    // rejection with no catch. startPairing() now self-heals (supersedes a
    // stale ceremony) and the tab cancels on unmount, so this must always
    // show a QR.
    await openMobileTab();
    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await closeSettings();
    await openMobileTab();

    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();
    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await closeSettings();
  });

  test('closing Settings mid-ceremony calls cancelPairing (genuine unmount, not the re-subscribe effect)', async () => {
    await page.evaluate(() => {
      window.__mockCancelPairingCallCount = 0;
    });

    await openMobileTab();
    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    const cancelCallCountBeforeClose = await page.evaluate(() => window.__mockCancelPairingCallCount || 0);

    await closeSettings();

    const cancelCallCountAfterClose = await page.evaluate(() => window.__mockCancelPairingCallCount || 0);
    // Not an exact-count assertion: this UI tier serves the app via Vite dev
    // mode, and React.StrictMode (always on, src/renderer/index.tsx) double-
    // invokes every effect's mount-time cleanup as a synthetic
    // mount/unmount/remount simulation in development, so the mount-time
    // cleanup can ALSO tick this same counter before the real close ever
    // happens (harmless in production, where StrictMode's double-invoke does
    // not occur). The real, falsifiable claim is that the genuine close
    // increments the counter at least once more - a deleted/broken unmount
    // effect would leave it unchanged.
    expect(cancelCallCountAfterClose).toBeGreaterThan(cancelCallCountBeforeClose);
  });

  test('a stale pairing-failure banner does not survive a tab unmount/remount', async () => {
    // The failure reason lives in the module-global useMobileStore, so it
    // must be cleared on unmount (MobileDevicesTab.tsx's own-unmount effect)
    // or it would otherwise reappear as stale text the next time this tab
    // mounts - it was previously only ever cleared by starting a NEW pairing.
    await openMobileTab();
    await page.getByRole('button', { name: 'Pair a device' }).click();
    await expect(page.getByAltText('Pairing QR code')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as {
        __mockFireMobilePairingEnded: (payload: { reason: string; kind: 'cancelled' | 'failed' }) => void;
      }).__mockFireMobilePairingEnded({ reason: 'STALE_FAILURE_REASON_MUST_NOT_PERSIST', kind: 'failed' });
    });
    await expect(page.getByText('STALE_FAILURE_REASON_MUST_NOT_PERSIST')).toBeVisible();

    await closeSettings();
    await openMobileTab();

    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();
    await expect(page.getByText('STALE_FAILURE_REASON_MUST_NOT_PERSIST')).toHaveCount(0);

    await closeSettings();
  });

  test('a paired device shows its key fingerprint, connection state, and paired date', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        {
          deviceId: 'a1b2c3d4e5f60789fedcba9876543210',
          displayName: 'Seeded iPhone',
          capabilities: [],
          pairedAt: '2026-01-01T00:00:00.000Z',
          connectionState: 'connected',
        },
      ];
    });

    await openMobileTab();

    const deviceRow = page.locator('li', { hasText: 'Seeded iPhone' });
    await expect(deviceRow).toBeVisible();
    // Matches @kangentic/protocol's formatKeyFingerprint: first 16 hex chars
    // as four space-separated groups of four.
    await expect(deviceRow.getByTestId('mobile-device-fingerprint')).toHaveText('a1b2 c3d4 e5f6 0789');
    await expect(deviceRow.getByTestId('mobile-device-connection')).toContainText('Connected');
    await expect(deviceRow).toContainText('Paired');

    await closeSettings();
  });

  test('a device with no live session shows no connection badge (idle is not an error)', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        {
          deviceId: 'idle-device-1',
          displayName: 'Idle Device',
          capabilities: [],
          pairedAt: new Date().toISOString(),
          connectionState: 'idle',
        },
      ];
    });

    await openMobileTab();

    const deviceRow = page.locator('li', { hasText: 'Idle Device' });
    await expect(deviceRow).toBeVisible();
    await expect(deviceRow.getByTestId('mobile-device-connection')).toHaveCount(0);

    await closeSettings();
  });

  test('shows the "Connecting…" and "Reconnecting…" connection states in amber, distinct from each other', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'connecting-device-1', displayName: 'Connecting Device', capabilities: [], pairedAt: new Date().toISOString(), connectionState: 'connecting' },
        { deviceId: 'reconnecting-device-1', displayName: 'Reconnecting Device', capabilities: [], pairedAt: new Date().toISOString(), connectionState: 'reconnecting' },
      ];
    });

    await openMobileTab();

    // Anchored regex, not a plain string: Playwright's string `hasText` is a
    // case-insensitive SUBSTRING match, and "Reconnecting Device" contains
    // "connecting device" as a substring, so a plain-string filter here
    // would resolve to both list items.
    const connecting = page.locator('li', { hasText: /^Connecting Device/ }).getByTestId('mobile-device-connection');
    await expect(connecting).toContainText('Connecting…');
    await expect(connecting).toHaveClass(/text-amber-400/);

    const reconnecting = page.locator('li', { hasText: /^Reconnecting Device/ }).getByTestId('mobile-device-connection');
    await expect(reconnecting).toContainText('Reconnecting…');
    await expect(reconnecting).not.toContainText('Connecting…');
    await expect(reconnecting).toHaveClass(/text-amber-400/);

    await closeSettings();
  });

  test('shows the "Disconnected" connection state in the danger color when the relay is closed', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'closed-device-1', displayName: 'Closed Device', capabilities: [], pairedAt: new Date().toISOString(), connectionState: 'closed' },
      ];
    });

    await openMobileTab();

    const indicator = page.locator('li', { hasText: 'Closed Device' }).getByTestId('mobile-device-connection');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('Disconnected');
    await expect(indicator).toHaveClass(/text-danger/);

    await closeSettings();
  });

  test('shows the "Offline" connection state muted, distinct from a relay that is reconnecting', async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'offline-device-1', displayName: 'Offline Device', capabilities: [], pairedAt: new Date().toISOString(), connectionState: 'offline' },
      ];
    });

    await openMobileTab();

    const indicator = page.locator('li', { hasText: 'Offline Device' }).getByTestId('mobile-device-connection');
    await expect(indicator).toBeVisible();
    // "The relay is fine, your phone is not attached" - a steady state, so it
    // reads muted and static rather than borrowing "Reconnecting…"'s amber
    // spinner, which means "the relay link dropped and is backing off".
    await expect(indicator).toContainText('Offline');
    await expect(indicator).toHaveClass(/text-fg-faint/);
    await expect(indicator).not.toContainText('Reconnecting…');

    await closeSettings();
  });

  test('a device that connects after the list was rendered updates its own badge, even while another device stays connected', async () => {
    // The regression this whole change exists for. The main process used to
    // notify only when the panel-wide AGGREGATE relay state moved, and
    // precedence pins that at 'connected' the moment any one device connects -
    // so a second device's own transitions never notified, and its row stayed
    // frozen on "Connecting…" while the phone was already serving data.
    await page.evaluate(() => {
      (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices = [
        { deviceId: 'steady-device-1', displayName: 'Steady Device', capabilities: [], pairedAt: new Date().toISOString(), connectionState: 'connected' },
        { deviceId: 'joining-device-1', displayName: 'Joining Device', capabilities: [], pairedAt: new Date().toISOString(), connectionState: 'connecting' },
      ];
    });

    await openMobileTab();

    const joining = page.locator('li', { hasText: /^Joining Device/ }).getByTestId('mobile-device-connection');
    await expect(joining).toContainText('Connecting…');

    // The freshly-paired device establishes. The first device never moves, so
    // the aggregate is 'connected' before AND after.
    await page.evaluate(() => {
      const devices = (window as unknown as { __mockMobileDevices: MobilePairedDevice[] }).__mockMobileDevices;
      const joiningDevice = devices.find((device) => device.deviceId === 'joining-device-1');
      if (joiningDevice) joiningDevice.connectionState = 'connected';
      (window as unknown as { __mockFireMobileStateChanged: () => void }).__mockFireMobileStateChanged();
    });

    await expect(joining).toContainText('Connected');
    await expect(joining).not.toContainText('Connecting…');
    // The steady device is undisturbed by the refetch.
    await expect(page.locator('li', { hasText: /^Steady Device/ }).getByTestId('mobile-device-connection')).toContainText('Connected');

    await closeSettings();
  });

  test('renaming a device persists via renameDevice and updates the list', async () => {
    await openMobileTab();
    await pairDevice('Rename Target Device');

    const deviceRow = page.locator('li', { hasText: 'Rename Target Device' });
    await deviceRow.getByTestId('mobile-device-rename').click();
    // Editing replaces the display-name <div> (a text node deviceRow's
    // hasText matched) with an <input> whose current value is NOT part of
    // the DOM's textContent - so a hasText-filtered locator stops matching
    // anything the instant edit mode renders. Re-locate the row without
    // the text filter (there is only one paired device in this test).
    const editingRow = page.getByTestId('mobile-device-row');
    const renameInput = editingRow.locator('input');
    await renameInput.fill('Renamed Device');
    await renameInput.press('Enter');

    await expect(page.locator('li', { hasText: 'Renamed Device' })).toBeVisible();
    await expect.poll(async () =>
      page.evaluate(async () => {
        const devices = await window.electronAPI.mobile.listDevices();
        return devices.some((device) => device.displayName === 'Renamed Device');
      }),
    ).toBe(true);

    await revokeDevice('Renamed Device');
    await closeSettings();
  });

  test('Escape while renaming cancels the edit, discards the draft, and leaves Settings open', async () => {
    // Pins BOTH halves of the rename input's Escape handling, which are two
    // separate source lines that fail in different ways:
    //   1. `event.stopPropagation()` - Settings dismisses on a bubble-phase
    //      document keydown (shared.tsx), so without this the Escape that
    //      cancels the rename also tears down the whole panel. Falsified by
    //      deleting that line: the Settings heading goes hidden.
    //   2. `setRenamingDeviceId(null)` - drops out of edit mode. Only
    //      independently falsifiable once (1) exists; before it, the panel
    //      unmount discarded the draft on its own and masked this line.
    // Neither may commit the draft, which is the third assertion.
    await openMobileTab();
    await pairDevice('Escape Target Device');

    const deviceRow = page.locator('li', { hasText: 'Escape Target Device' });
    await deviceRow.getByTestId('mobile-device-rename').click();
    const editingRow = page.getByTestId('mobile-device-row');
    const renameInput = editingRow.locator('input');
    await renameInput.fill('Should Not Be Saved');
    await renameInput.press('Escape');

    // The edit closes: the input unmounts back to the static name + actions.
    await renameInput.waitFor({ state: 'detached', timeout: 3000 });

    // Settings is still open AND still interactive, asserted by re-entering
    // edit mode rather than by a bare toBeVisible() on the heading: the
    // panel's dismiss is animated, so an immediate visibility sample can pass
    // even when Escape did close it - which is exactly the regression this
    // test exists to catch. A click that lands proves the panel is alive.
    await deviceRow.getByTestId('mobile-device-rename').click();
    const reopenedInput = editingRow.locator('input');
    await expect(reopenedInput).toBeVisible();
    await reopenedInput.press('Escape');
    await reopenedInput.waitFor({ state: 'detached', timeout: 3000 });
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // The draft was never committed, in the list or in the roster.
    await expect(page.locator('li', { hasText: 'Escape Target Device' })).toBeVisible();
    await expect(page.getByText('Should Not Be Saved')).toHaveCount(0);
    await expect.poll(async () =>
      page.evaluate(async () => {
        const devices = await window.electronAPI.mobile.listDevices();
        return devices.some((device) => device.displayName === 'Should Not Be Saved');
      }),
    ).toBe(false);

    await revokeDevice('Escape Target Device');
    await closeSettings();
  });

  test('committing a whitespace-only rename draft is a no-op: renameDevice is never called and the name is unchanged', async () => {
    await openMobileTab();
    await pairDevice('Whitespace Target Device');

    // Spy on the mock's renameDevice so a "no-op" claim is falsifiable
    // (the display name alone could stay put even if renameDevice fired with
    // whitespace and the mock happened to render it identically). The
    // original is stashed on window (not a local closure const) so a later,
    // separate page.evaluate call can restore it - see the cleanup below.
    await page.evaluate(() => {
      const calls: Array<{ deviceId: string; displayName: string }> = [];
      (window as unknown as { __renameDeviceCalls: typeof calls }).__renameDeviceCalls = calls;
      (window as unknown as { __renameDeviceOriginal: typeof window.electronAPI.mobile.renameDevice }).__renameDeviceOriginal =
        window.electronAPI.mobile.renameDevice;
      window.electronAPI.mobile.renameDevice = (deviceId: string, displayName: string) => {
        calls.push({ deviceId, displayName });
        return (window as unknown as { __renameDeviceOriginal: typeof window.electronAPI.mobile.renameDevice }).__renameDeviceOriginal(
          deviceId,
          displayName,
        );
      };
    });

    const deviceRow = page.locator('li', { hasText: 'Whitespace Target Device' });
    await deviceRow.getByTestId('mobile-device-rename').click();
    const editingRow = page.getByTestId('mobile-device-row');
    const renameInput = editingRow.locator('input');
    await renameInput.fill('   ');
    await renameInput.press('Enter');

    // Edit mode still closes (commitRename clears renamingDeviceId
    // unconditionally, before the trim check), but the trimmed-empty draft
    // must never reach renameDevice, and the original name stays.
    await expect(editingRow.locator('input')).toHaveCount(0);
    await expect(page.locator('li', { hasText: 'Whitespace Target Device' })).toBeVisible();
    const renameCallCount = await page.evaluate(
      () => (window as unknown as { __renameDeviceCalls: unknown[] }).__renameDeviceCalls.length,
    );
    expect(renameCallCount).toBe(0);

    // Restore the un-patched mock method so this spy never leaks into a
    // sibling test sharing this worker's page (cross-platform-parity.md).
    await page.evaluate(() => {
      window.electronAPI.mobile.renameDevice = (
        window as unknown as { __renameDeviceOriginal: typeof window.electronAPI.mobile.renameDevice }
      ).__renameDeviceOriginal;
    });

    await revokeDevice('Whitespace Target Device');
    await closeSettings();
  });

  test('revoke: Cancel keeps the device, Revoke removes it via revokeDevice() and the confirm text includes the fingerprint', async () => {
    await openMobileTab();
    await pairDevice('Revoke Target Device');

    // Cancel path: dialog closes, device stays in the list.
    await page.locator('li', { hasText: 'Revoke Target Device' }).getByTestId('mobile-device-revoke').click();
    const dialog = page.locator('h3:has-text("Revoke device")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Revoke Target Device');
    // The revoke confirm text names the fingerprint too, so revoking against
    // a real device list of same-named devices is unambiguous.
    await expect(dialog).toContainText(/\([0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}\)/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('li', { hasText: 'Revoke Target Device' })).toBeVisible();

    // Confirm path: the device is actually removed by the mock's revokeDevice().
    await revokeDevice('Revoke Target Device');

    await closeSettings();
  });
});
