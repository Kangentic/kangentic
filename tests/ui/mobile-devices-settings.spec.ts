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
 * all three options ("Local", "Kangentic Relay", "Custom Relay") - "Local"
 * is a dev-only Select option, gated behind __KANGENTIC_DEV__ in the
 * component, but is always offered under this tier's dev webServer. "hosted"
 * resolves to KANGENTIC_HOSTED_RELAY_URL unconditionally (not build-mode-
 * dependent), so this tier actually exercises the "Kangentic Relay" label
 * and its resolved URL, not just "Local". "local" is DIFFERENT: unlike
 * "hosted", resolveRelayMode() gates what "local" resolves TO on
 * __KANGENTIC_DEV__ too (not just whether the Select offers it) - a
 * production build falls through to the hosted relay instead of loopback,
 * so a persisted relayMode: 'local' can never reach a real user's phone as
 * plaintext ws://127.0.0.1:8080. This tier's dev webServer is exactly why
 * the "Local" test below still resolves to loopback: it runs the dev
 * branch.
 *
 * Be precise about what that buys, though: this tier CANNOT falsify the gate.
 * A dev build resolved "local" to loopback both before and after the gate
 * existed, so the "Local" test below passes either way - it pins that dev-mode
 * behavior did not regress, not that the production gate is present. The
 * red-green coverage for the gate itself lives entirely in the unit tier
 * (tests/unit/relay-url.test.ts and tests/unit/config-handler-wiring.test.ts),
 * which compiles __KANGENTIC_DEV__ = false and so exercises the branch this
 * webServer can never reach.
 *
 * These literals are hard-coded rather than imported from
 * src/shared/relay.ts, since playwright.config.ts sets no `define` and
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
  await expect(page.getByRole('heading', { name: 'Mobile', exact: true })).toBeVisible();
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
      await expect(freshPage.getByRole('heading', { name: 'Mobile', exact: true })).toBeVisible();
    } finally {
      await freshBrowser.close();
    }
  });

  test("Mobile's app-docs tail stays interactive with the bridge off and opens the mobile docs", async () => {
    // Bridge OFF is the interesting case: this is the Mobile section's
    // documentation tail, which sits OUTSIDE the enabled-gated wrapper
    // (opacity-40 pointer-events-none when disabled), because a user who has
    // not installed the app yet is exactly the user who has not enabled the
    // bridge. The click succeeding proves the escape.
    await setMobileBridgeConfig({ enabled: false, relayMode: 'hosted', relayUrl: '' });
    await openMobileTab();

    const section = page.locator('[data-testid="mobile-get-app"]');
    await expect(section).toBeVisible();

    // Anchor on the section's own content BEFORE asserting anything is absent.
    // QrImage renders null until its async toDataURL() resolves, so a bare
    // "no <img>" count can sample that gap and pass vacuously against a QR
    // that simply had not painted yet. Waiting for the docs link first makes
    // the three absence checks below statements about a settled section.
    const docsLink = section.locator('[data-testid="mobile-get-app-docs-link"]');
    await expect(docsLink).toBeVisible();

    // The section is a blurb plus exactly one link, not the two QR blocks it
    // used to be: the launch-phase signup steps live in the mobile-launch
    // announcement and on the docs page, so this tab never goes stale.
    // ExternalLinkButton draws a lucide <svg>, so only a returning QrImage
    // trips the image count. A future App Store / Play badge image would trip
    // it too - deliberately, so that regrowing this section is a decision
    // rather than an accident. The button count and the two step-block ids
    // catch what an image count alone cannot: a half-revert that restores the
    // step markup and its copy without (or before) its QR.
    await expect(section.locator('img')).toHaveCount(0);
    await expect(section.getByRole('button')).toHaveCount(1);
    await expect(section.locator('[data-testid="mobile-get-app-step-group"]')).toHaveCount(0);
    await expect(section.locator('[data-testid="mobile-get-app-step-optin"]')).toHaveCount(0);

    await page.evaluate(() => {
      window.__openedExternalUrls = [];
    });
    await docsLink.click();
    await expect
      .poll(() => page.evaluate(() => window.__openedExternalUrls))
      .toEqual(['https://www.kangentic.com/mobile/']);

    await closeSettings();
  });

  test("Mobile's app-docs tail survives pairing: it is not an empty-state prompt", async () => {
    // The mirror of the bridge-off case above. The section is unconditional in
    // BOTH directions, and this pins the direction that is tempting to "tidy
    // up": hiding it once a device exists, on the theory that a paired user has
    // already got the app. They have not necessarily got it on their NEXT
    // device, and the link is the docs landing page (notifications, security,
    // relay self-hosting), whose audience is mostly people who already paired.
    await openMobileTab();
    await pairDevice('Pixel 9');

    await expect(page.locator('[data-testid="mobile-get-app"]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-get-app-docs-link"]')).toBeVisible();

    await revokeDevice('Pixel 9');
    await closeSettings();
  });

  test('hosted mode renders the enable toggle, relay mode select, resolved URL, and section headers', async () => {
    await openMobileTab();
    await expect(page.getByRole('switch')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-relay-mode"]')).toHaveValue('hosted');
    await expect(page.locator('[data-testid="mobile-relay-mode"]')).toContainText('Kangentic Relay');
    // ONE address control for every mode: the same input, read-only where the
    // address is resolved for you. readOnly rather than disabled so the address
    // stays selectable and copyable, which the Pill this replaced also allowed.
    // The hosted-relay constant is returned verbatim (not passed through
    // new URL() normalization, unlike a saved custom value).
    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await expect(urlInput).toHaveValue('wss://relay.kangentic.com');
    await expect(urlInput).toHaveAttribute('readonly', '');
    await expect(urlInput).not.toBeDisabled();
    // The shield marks the Kangentic-operated relay, and only it.
    await expect(page.locator('[title="Kangentic-operated relay"]')).toBeVisible();
    // The tab is two peer sections, Relay and Mobile. "Relay" must be the
    // section heading and NOT also a row label inside it: the relay controls
    // used to live in a SettingRow whose own label was "Relay" too, which put
    // two headings for one thing on the tab. "Paired Devices" is deliberately
    // a sub-label within Mobile rather than a third peer heading.
    await expect(page.getByRole('heading', { name: 'Relay', exact: true })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Mobile', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Paired Devices' })).toHaveCount(0);
    await expect(page.getByText('Paired Devices')).toBeVisible();
    await closeSettings();
  });

  test('the relay mode select offers Local, Kangentic Relay, and Custom Relay in a dev build', async () => {
    await openMobileTab();
    const select = page.locator('[data-testid="mobile-relay-mode"]');
    const optionLabels = await select.locator('option').allTextContents();
    expect(optionLabels).toEqual(['Local', 'Kangentic Relay', 'Custom Relay']);
    await closeSettings();
  });

  test('selecting Local resolves to the local dev relay address', async () => {
    await openMobileTab();

    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('local');

    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayMode).toBe('local');
    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await expect(urlInput).toHaveValue('ws://127.0.0.1:8080');
    // Read-only like hosted, but NOT shielded: local is loopback, not the
    // Kangentic-operated relay, so marking it would be untrue.
    await expect(urlInput).toHaveAttribute('readonly', '');
    await expect(page.locator('[title="Kangentic-operated relay"]')).toHaveCount(0);

    await closeSettings();
  });

  test('the address field is the whole provenance claim: the shield marks only the hosted relay, and no badge returns', async () => {
    // There was an "Official" chip beside the address until 2026-08-07. It had no
    // contrast case: resolveRelayMode() collapses a stored 'local' to 'hosted' in
    // production, so a real user only ever reached 'hosted' (address + chip) or
    // 'custom' (no address pill at all), making the chip present in every case
    // the pill was. The shield that replaced it is keyed to 'hosted' ALONE, which
    // is what earns it - the same box in local and custom mode shows none.
    //
    // "Whole" claim is literal: the shield is aria-hidden (a sighted-only
    // affordance), so the input's own aria-label is the ONLY carrier of the
    // provenance fact for a screen reader. It has to track the shield exactly,
    // state for state, or a screen reader user gets told about a relay operator
    // that is not (or is) actually the one in the box.
    await openMobileTab();

    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    const officialMark = page.locator('[title="Kangentic-operated relay"]');
    await expect(urlInput).toHaveValue('wss://relay.kangentic.com');
    await expect(officialMark).toBeVisible();
    await expect(urlInput).toHaveAttribute('aria-label', 'Relay address, the Kangentic-operated relay');
    await expect(page.locator('[data-testid="mobile-relay-official-badge"]')).toHaveCount(0);
    // The domain and the shield are the signal, so the word must not reappear as
    // a chip or anywhere else in the relay row.
    await expect(page.getByText('Official', { exact: true })).toHaveCount(0);

    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('local');
    await expect(urlInput).toHaveValue('ws://127.0.0.1:8080');
    await expect(officialMark).toHaveCount(0);
    await expect(urlInput).toHaveAttribute('aria-label', 'Relay address');

    // Custom keeps the same box, now editable, and still unshielded.
    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('custom');
    await expect(urlInput).toBeVisible();
    await expect(urlInput).not.toHaveAttribute('readonly', '');
    await expect(officialMark).toHaveCount(0);
    await expect(urlInput).toHaveAttribute('aria-label', 'Relay address');

    await closeSettings();
  });

  test("the Relay section's docs tail stays live with the bridge off", async () => {
    // The point of the test: this link sits OUTSIDE the enabled-gated wrapper
    // (opacity-40 pointer-events-none). Someone deciding whether to route
    // agent traffic through our relay has not enabled the bridge yet, so a
    // link inside the gate would be dead for exactly its audience. Clicking
    // it while disabled is what proves the escape - and nothing else would
    // catch a later refactor tidying it back into the gated relay controls.
    await setMobileBridgeConfig({ enabled: false, relayMode: 'hosted', relayUrl: '' });
    await openMobileTab();

    const relayDocsLink = page.locator('[data-testid="mobile-relay-docs-link"]');
    await expect(relayDocsLink).toBeVisible();

    await page.evaluate(() => {
      window.__openedExternalUrls = [];
    });
    await relayDocsLink.click();
    // The relay section's OVERVIEW, not a leaf. Someone opening this from
    // settings is asking what the relay does; the overview answers that and
    // routes on to the hosted page or the self-hosting how-to. The two
    // sections' tails must also stay distinct targets - Relay goes to /relay/,
    // Mobile goes to /mobile/ - which is the collision this split fixed.
    await expect
      .poll(() => page.evaluate(() => window.__openedExternalUrls))
      .toEqual(['https://www.kangentic.com/relay/']);

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

  test('selecting Custom Relay makes the address field editable and empty, never prefilled with the hosted fallback', async () => {
    await openMobileTab();

    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await expect(urlInput).toHaveValue('wss://relay.kangentic.com');
    await expect(urlInput).toHaveAttribute('readonly', '');

    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('custom');

    await expect(urlInput).not.toHaveAttribute('readonly', '');
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayMode).toBe('custom');
    // Regression check, and the reason the field's value is the DRAFT in custom
    // mode rather than resolveRelayUrl(): with an empty custom draft
    // resolveRelayUrl falls back to the hosted relay internally, but that
    // fallback must never surface under a Select reading "Custom Relay" - it read
    // as "picking Custom didn't do anything", the hosted address still sitting
    // there. Now that one box serves both modes, prefilling it would be the same
    // bug wearing the editable field's clothes.
    await expect(urlInput).toHaveValue('');

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

  test('blurring the read-only relay address field in hosted mode does not persist relayMode: custom', async () => {
    // The address field is now mounted in every mode and is readOnly rather
    // than disabled (so the resolved address stays selectable and copyable),
    // but readOnly blocks typing, not focus/blur. commitRelayDraft used to run
    // unconditionally on blur, so clicking into the hosted address to copy it
    // and then clicking away silently rewrote mobileBridge to
    // relayMode: 'custom' with whatever relayDraft happened to hold. This
    // pins the guard: a blur while NOT in custom mode is a no-op.
    await openMobileTab();

    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await expect(urlInput).toHaveAttribute('readonly', '');
    await urlInput.click();
    await urlInput.blur();

    // No expect.poll here on purpose. The mock's config.set mutates its
    // shared config object synchronously (no internal await), so by the time
    // Playwright's blur() action resolves, a buggy commit has already landed
    // if it was going to. Reading it immediately is the correct check for
    // this negative claim, not a race against an async write.
    const persisted = await getGlobalConfig();
    expect(persisted.mobileBridge?.relayMode).toBe('hosted');
    expect(persisted.mobileBridge?.relayUrl ?? '').toBe('');

    await closeSettings();
  });

  test('switching back to hosted after drafting (but never re-saving) a custom relay URL, then blurring the now read-only field, does not resurrect that draft as relayMode: custom', async () => {
    // The worse variant of the bug above. relayDraft is component state that
    // outlives a mode switch - nothing resets it when the Select changes -
    // so without the guard a blur back in hosted mode would not just flip the
    // mode again, it would carry along a real, now-irrelevant draft URL
    // rather than an empty one.
    await openMobileTab();

    const select = page.locator('[data-testid="mobile-relay-mode"]');
    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');

    await select.selectOption('custom');
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayMode).toBe('custom');
    await urlInput.fill('wss://relay.stale-draft.dev');
    await urlInput.blur();
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayUrl).toBe('wss://relay.stale-draft.dev/');

    await select.selectOption('hosted');
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayMode).toBe('hosted');
    await expect(urlInput).toHaveAttribute('readonly', '');

    await urlInput.click();
    await urlInput.blur();

    // Same reasoning as the simple case above: the mock's config.set mutates
    // synchronously, so this read is not racing a would-be commit.
    expect((await getGlobalConfig()).mobileBridge?.relayMode).toBe('hosted');

    await setMobileBridgeConfig({ relayMode: 'hosted', relayUrl: '' });
    await closeSettings();
  });

  test('Test connection renders the reachable and no-response trailing states', async () => {
    await openMobileTab();

    // Signal, not the old Server glyph: agent-execution-fields.tsx's identical
    // Test connection button must keep this same icon (see its own comment),
    // so a drift here would silently break that lockstep.
    await expect(page.locator('[data-testid="mobile-relay-test-connection"] .lucide-signal')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; latencyMs?: number; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: true, version: '0.4.0', latencyMs: 42 });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    const result = page.locator('[data-testid="mobile-relay-test-result"]');
    // The verdict leads and the latency trails it. The relay's own service
    // version is not a compatibility signal, so it stays out of the verdict
    // text and rides in the tooltip.
    await expect(result).toHaveText('Reachable, 42 ms');
    await expect(result).toHaveAttribute('data-reachable', 'true');
    await expect(result).toHaveAttribute('title', 'Relay v0.4.0');
    // Facts get weight, not hue (the same rule WelcomeScreen states at :293 for
    // its CLI-detection probe): the verdict is a bare caption with NO box of its
    // own, and only the icon carries the outcome. A filled box made a one-shot
    // health check the loudest thing on the row, and as a Pill it was the single
    // rounded-full element in a panel of rounded rectangles. The token, not a raw
    // green-500/green-400 pair, so this tracks all 11 themes the way the shield on
    // the address field does - and because --kng-active means "an agent is
    // working" everywhere else in the app.
    await expect(result).not.toHaveClass(/\bbg-/);
    await expect(result).not.toHaveClass(/rounded/);
    await expect(result.locator('svg')).toHaveClass(/text-active/);

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; latencyMs?: number; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: false, reason: 'ECONNREFUSED' });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    const noResponse = page.getByText('No response');
    await expect(noResponse).toBeVisible();
    await expect(noResponse).toHaveAttribute('title', 'ECONNREFUSED');
    // Same treatment on the failure branch, via the attention token.
    await expect(result).not.toHaveClass(/\bbg-/);
    await expect(result.locator('svg')).toHaveClass(/text-attention/);
    // The reason is what makes the failure actionable, so it is printed, not
    // left hover-only on the verdict.
    await expect(page.locator('[data-testid="mobile-relay-test-error"]')).toHaveText('ECONNREFUSED');

    await closeSettings();
  });

  test('a relay that reports neither a version nor a latency renders the bare verdict, not a half-built one', async () => {
    // Regression coverage for the two absent-field paths. The hosted relay's
    // documented /healthz body is {"status":"ok"}, and RemoteServerStatus is
    // shared with a probe that does not time its request, so both clauses have
    // to be genuinely optional rather than interpolated unconditionally into
    // "Reachable,  ms" / a "Relay vundefined" tooltip. The mock's DEFAULT
    // testRelay is exactly this shape, so no __mockTestRelay is installed here.
    await openMobileTab();

    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    const result = page.locator('[data-testid="mobile-relay-test-result"]');
    await expect(result).toHaveText('Reachable');
    await expect(result).not.toHaveAttribute('title', /.*/);
    // A reachable probe prints no failure line.
    await expect(page.locator('[data-testid="mobile-relay-test-error"]')).toHaveCount(0);

    await closeSettings();
  });

  test('a test result does not shift the address field beside it', async () => {
    await openMobileTab();

    const resolvedUrl = page.locator('[data-testid="mobile-relay-url-input"]');
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
    // stops the field from reflowing", not "the float is bit-identical".
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);

    await closeSettings();
  });

  test('the address field and the test verdict share one vertical center', async () => {
    // A cross-COLUMN invariant, which the no-reflow test above deliberately
    // does not cover: that one measures a single element before and after, so it
    // stays green with these two several px out of line. They sit in
    // different columns of one grid row precisely so `items-center` centers both
    // in a single shared row box; as two independent flex stacks (a gap-2 column
    // beside a gap-1 one) their centers sat 5px apart.
    //
    // Anchored to the address field, which is the only thing left in column 1
    // (the resolved-URL Pill and the Official badge that used to share the cell
    // are both gone) and which renders in every mode that renders this row.
    await openMobileTab();

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; latencyMs?: number; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: true, version: '0.4.0', latencyMs: 42 });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    const verdict = page.locator('[data-testid="mobile-relay-test-result"]');
    await expect(verdict).toBeVisible();

    const [urlBox, resultBox, buttonBox] = await Promise.all([
      page.locator('[data-testid="mobile-relay-url-input"]').boundingBox(),
      verdict.boundingBox(),
      page.locator('[data-testid="mobile-relay-test-connection"]').boundingBox(),
    ]);
    expect(urlBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    // Centers rather than tops, and this is the whole point of measuring centers:
    // the 34px address field and the 24px verdict chip SHOULD differ in height,
    // so a top- or bottom-edge check would be meaningless here. A 1px tolerance
    // rather than exact equality, because Blink lays out in 1/64px units and
    // `items-center` halves whatever cross-axis remainder the row has, which
    // rounds differently on local Windows than on the headless Linux CI runner.
    const urlCenter = (urlBox?.y ?? 0) + (urlBox?.height ?? 0) / 2;
    const resultCenter = (resultBox?.y ?? 0) + (resultBox?.height ?? 0) / 2;
    expect(Math.abs(resultCenter - urlCenter)).toBeLessThanOrEqual(1);

    // The horizontal counterpart of the fixed-height slot. The verdict shares its
    // grid column with the Test connection button, so a verdict WIDER than the
    // button would widen that auto-sized column and narrow the Select beside it
    // every time a probe finishes.
    //
    // Asserted as the verdict against the button in the SAME render, not as the
    // Select's width before vs after the probe. Those two are equivalent
    // (fits => the column cannot grow => the Select cannot shrink), but the
    // before/after form compares two strings measured in different type sizes,
    // and glyph advance width is font-dependent in a way line height is not:
    // this repo bundles no webfont, so the stack resolves to Segoe UI locally
    // and a fontconfig substitute on the Linux CI runner. That delta is also
    // QUANTIZED, not noisy - the column either grows or it does not - so a
    // looser tolerance would not have absorbed the divergence, only moved
    // where it lands. Comparing two boxes from one render is font-relative and
    // says the same thing on every platform.
    expect(resultBox?.width ?? 0).toBeLessThanOrEqual(buttonBox?.width ?? 0);

    await closeSettings();
  });

  test('in custom mode the address field sits under the picker at its width, level with the verdict', async () => {
    // Custom and hosted share ONE skeleton and now ONE control: picker over
    // address, probe button over verdict, the only difference being whether the
    // address box accepts typing. The editable form used to sit in its own
    // SettingRow below this whole row, which put the verdict and its failure
    // reason ABOVE the input being tested. This pins the corrected placement in
    // the mode where it was worst.
    await openMobileTab();
    await setMobileBridgeConfig({ relayMode: 'custom' });
    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await urlInput.fill('wss://relay.example.com');

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; latencyMs?: number; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: true, version: null, latencyMs: 7 });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    const verdict = page.locator('[data-testid="mobile-relay-test-result"]');
    await expect(verdict).toBeVisible();

    const [selectBox, inputBox, verdictBox] = await Promise.all([
      page.locator('[data-testid="mobile-relay-mode"]').boundingBox(),
      urlInput.boundingBox(),
      verdict.boundingBox(),
    ]);
    expect(selectBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(verdictBox).not.toBeNull();

    // It occupies column 1, so it shares the Select's left edge and width - the
    // same slot the read-only form of this field occupies in hosted mode.
    expect(Math.abs((inputBox?.x ?? 0) - (selectBox?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((inputBox?.width ?? 0) - (selectBox?.width ?? 0))).toBeLessThanOrEqual(1);
    // BELOW the picker, and on the same grid row as the verdict rather than
    // several rows above it. Centers, since the 34px input and the 24px chip are
    // allowed to differ in height.
    expect(inputBox?.y ?? 0).toBeGreaterThan((selectBox?.y ?? 0) + (selectBox?.height ?? 0) - 1);
    const inputCenter = (inputBox?.y ?? 0) + (inputBox?.height ?? 0) / 2;
    const verdictCenter = (verdictBox?.y ?? 0) + (verdictBox?.height ?? 0) / 2;
    expect(Math.abs(verdictCenter - inputCenter)).toBeLessThanOrEqual(1);

    await setMobileBridgeConfig({ relayMode: 'hosted' });
    await closeSettings();
  });

  test('the relay row prints ONE error line: a draft validation error suppresses the probe reason', async () => {
    // Both can be set at once, and used to render in two different places in the
    // same red: the probe reason above the input, the draft's validation error
    // below it. They also say nearly the same thing, because the main process
    // re-runs validateRelayUrl and reports the same cause back as an unreachable
    // reason. One line, draft error wins.
    await openMobileTab();
    await setMobileBridgeConfig({ relayMode: 'custom' });

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; latencyMs?: number; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: false, reason: 'PROBE REASON SHOULD BE SUPPRESSED' });
    });
    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    await urlInput.fill('http://not-a-websocket-url');
    await urlInput.blur();
    await expect(page.locator('[data-testid="mobile-relay-url-error"]')).toBeVisible();

    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    await expect(page.locator('[data-testid="mobile-relay-test-result"]')).toHaveAttribute('data-reachable', 'false');

    // The validation error still owns the single line, and the probe reason is
    // nowhere on the page - not merely visually second.
    await expect(page.locator('[data-testid="mobile-relay-url-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-relay-test-error"]')).toHaveCount(0);
    await expect(page.getByText('PROBE REASON SHOULD BE SUPPRESSED')).toHaveCount(0);

    // Fixing the draft hands the line back to the probe, so the precedence is a
    // priority and not a permanent mute.
    await urlInput.fill('wss://relay.example.com');
    await urlInput.blur();
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    await expect(page.locator('[data-testid="mobile-relay-test-error"]')).toHaveText('PROBE REASON SHOULD BE SUPPRESSED');
    await expect(page.locator('[data-testid="mobile-relay-url-error"]')).toHaveCount(0);

    await setMobileBridgeConfig({ relayMode: 'hosted', relayUrl: '' });
    await closeSettings();
  });

  test('the test verdict stays in the button column instead of sliding under the Select', async () => {
    // The verdict belongs to column 2, under the button that produced it. Break
    // the address cell in column 1 and grid auto-placement pulls the verdict slot
    // into column 1 instead. Nothing else in the layout would look wrong, which
    // is exactly why this needs pinning.
    await openMobileTab();
    await setMobileBridgeConfig({ relayMode: 'custom' });
    await page.locator('[data-testid="mobile-relay-url-input"]').fill('wss://relay.example.com');

    await page.evaluate(() => {
      (window as unknown as { __mockTestRelay: (relayUrl: string) => Promise<{ reachable: boolean; version?: string | null; latencyMs?: number; reason?: string }> }).__mockTestRelay =
        () => Promise.resolve({ reachable: true, version: null, latencyMs: 7 });
    });
    await page.locator('[data-testid="mobile-relay-test-connection"]').click();
    const verdict = page.locator('[data-testid="mobile-relay-test-result"]');
    await expect(verdict).toBeVisible();

    const [buttonBox, resultBox] = await Promise.all([
      page.locator('[data-testid="mobile-relay-test-connection"]').boundingBox(),
      verdict.boundingBox(),
    ]);
    expect(buttonBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    // The verdict hugs the button's leading edge, indented by the button's own
    // px-3 so its icon sits under the button's icon rather than out at the border
    // box. Asserted as a band rather than an exact offset: the point is that it is
    // in column 2 at all. Had it flowed into column 1 it would sit at the Select's
    // left edge, hundreds of px to the left, so a loose bound still catches the
    // grid-auto-placement bug this was written for.
    expect(resultBox?.x ?? 0).toBeGreaterThanOrEqual((buttonBox?.x ?? 0) - 1);
    expect(resultBox?.x ?? 0).toBeLessThanOrEqual((buttonBox?.x ?? 0) + 20);

    await setMobileBridgeConfig({ relayMode: 'hosted' });
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

  test('switching the relay mode away from custom clears a stale draft validation error, not just the probe result', async () => {
    // The relay row's error line moved from a custom-only SettingRow (which
    // unmounted along with the mode) into the always-rendered grid row. The
    // mode Select's onChange cleared relayTestResult on a mode switch but not
    // relayDraftError, so an invalid custom draft's red error line survived
    // underneath the newly-selected hosted relay's read-only address - an
    // error about a draft the user was no longer editing.
    await setMobileBridgeConfig({ relayMode: 'custom', relayUrl: '' });
    await openMobileTab();

    const urlInput = page.locator('[data-testid="mobile-relay-url-input"]');
    const errorLine = page.locator('[data-testid="mobile-relay-url-error"]');
    await urlInput.fill('http://not-a-websocket-url');
    await urlInput.blur();
    await expect(errorLine).toBeVisible();

    await page.locator('[data-testid="mobile-relay-mode"]').selectOption('hosted');

    await expect(errorLine).toHaveCount(0);
    // The mode switch itself landed too, so the error's disappearance is not
    // a coincidence of some unrelated re-render.
    await expect.poll(async () => (await getGlobalConfig()).mobileBridge?.relayMode).toBe('hosted');

    await setMobileBridgeConfig({ relayMode: 'hosted', relayUrl: '' });
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

  test('a search matching only one section id in a two-id header still reveals that section\'s body (regression)', async () => {
    // Regression coverage for a header/body search-visibility mismatch: each
    // of the Relay and Mobile sections is one SectionHeader with a
    // MULTI-id searchIds array, but the body below it used to be gated (or not
    // gated at all) on a DIFFERENT rule than its own header. A query matching
    // only part of a section's id set could then show the heading while
    // hiding the very body content the query was about, or - worse - hide the
    // heading while the ungated body kept rendering underneath nothing.
    //
    // "websocket" is a keyword ONLY on mobileBridge.relayUrl (not on
    // mobileBridge.relayMode) - see settings-registry.ts. It discriminates
    // between "any of the Relay section's ids matched" (correct: body must
    // show) and "the specific id `relayMode` matched" (the historical bug:
    // body stays hidden because relayMode is what the body used to gate on).
    await setMobileBridgeConfig({ enabled: true, relayMode: 'custom', relayUrl: '' });
    await openMobileTab();

    const searchInput = page.getByTestId('settings-search');
    await searchInput.fill('websocket');

    // The heading is not the falsifier here (SectionHeader's own gate already
    // matches on any of RELAY_SEARCH_IDS and was not touched by the historical
    // bug) - it is a sanity anchor confirming the section is even present.
    await expect(page.getByRole('heading', { name: 'Relay', exact: true })).toBeVisible();
    // The load-bearing assertion: the Custom Relay Address field - the exact
    // control "websocket" is searching for - must render under a heading that
    // claims to have a match.
    await expect(page.locator('[data-testid="mobile-relay-url-input"]')).toBeVisible();

    await searchInput.fill('');
    await expect(page.getByRole('heading', { name: 'Mobile', exact: true })).toBeVisible();
    await closeSettings();

    // "official" is a keyword ONLY on mobileBridge.relayMode - it does not
    // appear on any of the Mobile section's ids (pairing / devices / getApp).
    // This is the mirror direction: a query that matches a DIFFERENT
    // section's id entirely must not leave the Mobile section's body
    // (buttons, docs tail) rendering orphaned under no heading.
    await setMobileBridgeConfig({ enabled: true, relayMode: 'hosted', relayUrl: '' });
    await openMobileTab();
    await searchInput.fill('official');

    await expect(page.getByRole('heading', { name: 'Mobile', exact: true })).toHaveCount(0);
    // Load-bearing: both halves of the Mobile section body - the pairing
    // button and the unconditional docs tail - must actually be hidden
    // (display:none), not merely under a missing heading.
    await expect(page.locator('[data-testid="mobile-pair-start"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="mobile-get-app"]')).not.toBeVisible();
    // The Relay section is unaffected by a query naming its own id: it stays
    // visible, so this is not "everything collapsed", only Mobile.
    await expect(page.getByRole('heading', { name: 'Relay', exact: true })).toBeVisible();

    await searchInput.fill('');
    await expect(page.getByRole('heading', { name: 'Mobile', exact: true })).toBeVisible();
    await closeSettings();

    // Mirror image of the "official" scenario above, with the two sections'
    // roles swapped: "get the app" is a keyword ONLY on mobileBridge.getApp
    // (a Mobile-section id) - see settings-registry.ts - and appears on
    // neither of the Relay section's ids (relayMode / relayUrl). This is not
    // redundant with the "official" scenario: Relay and Mobile hide their
    // bodies through genuinely different mechanisms (Relay's is
    // `{relaySectionVisible && (...)}`, which unmounts; Mobile's is a
    // `className` toggle to `hidden`), wired to two independently computed
    // booleans - a bug that swaps which id list feeds which boolean, or that
    // hardcodes one of the two to always stay visible, needs a pin in BOTH
    // directions to be caught.
    await setMobileBridgeConfig({ enabled: true, relayMode: 'hosted', relayUrl: '' });
    await openMobileTab();
    await searchInput.fill('get the app');

    await expect(page.getByRole('heading', { name: 'Relay', exact: true })).toHaveCount(0);
    // Load-bearing: the Relay section body - its controls and its
    // unconditional docs tail - must actually be gone, not merely rendering
    // under a missing heading.
    await expect(page.locator('[data-testid="mobile-relay-mode"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="mobile-relay-docs-link"]')).not.toBeVisible();
    // Mobile is unaffected by a query naming its own id: it stays visible, so
    // this is not "everything collapsed", only Relay.
    await expect(page.getByRole('heading', { name: 'Mobile', exact: true })).toBeVisible();

    await searchInput.fill('');
    await expect(page.getByRole('heading', { name: 'Relay', exact: true })).toBeVisible();
    await closeSettings();
  });
});
