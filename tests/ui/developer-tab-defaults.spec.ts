/**
 * UI tests for the Developer settings tab's default-value computation for
 * `persistConsoleLogs` and `recordIpcTraffic` when the user has never touched
 * either toggle (no stored value in `AppConfig.developer`).
 *
 * This pins the intent documented at the two call sites (DeveloperTab.tsx's
 * inline `??` defaults and their mirror, `defaultDeveloperFlag` in
 * src/shared/developer-flag-defaults.ts, consumed by src/main/index.ts's
 * safeReadDeveloperFlag):
 *   - Persistent Console Logs defaults ON in any dev build (regular npm start
 *     dogfooding AND /preview) - its write path is async-queued, so it has no
 *     measurable dogfooding cost.
 *   - Record IPC Traffic defaults OFF for the regular (non-ephemeral) dev
 *     session - it has a real per-call disk-I/O cost, so it stays opt-in
 *     there - but defaults ON for the ephemeral `/preview` instance, whose
 *     data dir (including its logs) is wiped on close, bounding the growth.
 *
 * The UI tier is correct here (not unit): the decision itself already has
 * dedicated unit coverage on the shared pure function
 * (tests/unit/developer-flag-defaults.test.ts); what is uniquely untested
 * without a real DOM is that DeveloperTab.tsx's `??` expressions actually
 * wire that decision to the rendered `<ToggleSwitch>`'s `aria-checked` state
 * for a real user opening Settings -> Developer. No PTY or Electron main
 * process is needed, so this stays out of tests/e2e/.
 *
 * The Playwright `ui` project serves Vite in dev mode (`npx vite`, no
 * `--mode production`), so `__KANGENTIC_DEV__` is `true` for these tests -
 * exercising the "dev build" branch, which is the branch relevant to a
 * developer opening the app via `npm start` or `/preview`.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Developer Tab Defaults Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Open Settings and switch to the Developer tab. */
async function openDeveloperTab() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Developer', exact: true }).click();
}

/** Close settings via Escape. */
async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

/** Locate a ToggleRow's <button role="switch"> by its exact title text. The
 *  title lives in a sibling div of the switch inside the row container, so
 *  two `..` hops from the title element reach the row, which scopes the
 *  `getByRole('switch')` query to that row alone. */
function toggleForTitle(title: string) {
  return page.getByText(title, { exact: true }).locator('..').locator('..').getByRole('switch');
}

test.describe('Developer Tab - persistConsoleLogs / recordIpcTraffic defaults', () => {
  test('Persistent Console Logs defaults ON, Record IPC Traffic defaults OFF, for the regular (non-ephemeral) dev session', async () => {
    // window.electronAPI.dev is undefined in the mock (mirrors a real,
    // non-ephemeral dogfooding session, where `dev` is present but
    // isEphemeralPreview is false) - DeveloperTab.tsx reads it via `?.`, so
    // this exercises the "not ephemeral" branch without needing to stub it.
    await openDeveloperTab();

    await expect(toggleForTitle('Persistent Console Logs')).toHaveAttribute('aria-checked', 'true');
    await expect(toggleForTitle('Record IPC Traffic')).toHaveAttribute('aria-checked', 'false');

    await closeSettings();
  });

  test('Record IPC Traffic defaults ON when the session is the ephemeral /preview instance', async () => {
    // Stub window.electronAPI.dev.isEphemeralPreview = true, then force the
    // config store to reload so DeveloperTab re-renders with the new read.
    // Cleaned up in `finally` so it does not leak into later tests on this
    // shared page.
    await page.evaluate(() => {
      (window.electronAPI as unknown as { dev: { isEphemeralPreview: boolean } }).dev = {
        isEphemeralPreview: true,
      };
    });

    try {
      await openDeveloperTab();

      await expect(toggleForTitle('Record IPC Traffic')).toHaveAttribute('aria-checked', 'true');
      // Persistent Console Logs does not depend on ephemeral state - still ON.
      await expect(toggleForTitle('Persistent Console Logs')).toHaveAttribute('aria-checked', 'true');

      await closeSettings();
    } finally {
      await page.evaluate(() => {
        delete (window.electronAPI as unknown as { dev?: unknown }).dev;
      });
    }
  });

  // Deliberately last in this file: the mock's config.set() deep-merges and
  // (like the real deepMergeConfig) SKIPS `undefined` values, so a stored
  // `false` set here cannot be unset back to "never touched" afterward - only
  // overwritten with another explicit value. Ordering this test last means no
  // later test in this file depends on the developer config being unset.
  test('an explicit stored false always wins over the dev-build default', async () => {
    // Persist an explicit `false` for both toggles, then reload the config
    // store so DeveloperTab picks it up. This is the `??` fallthrough guard:
    // `??` only falls through on null/undefined, so a stored `false` must be
    // respected rather than overridden by the dev-build default.
    await page.evaluate(() => {
      return window.electronAPI.config.set({
        developer: { persistConsoleLogs: false, recordIpcTraffic: false },
      });
    });
    await page.evaluate(() => {
      const stores = (window as unknown as {
        __zustandStores?: { config: { getState: () => { loadConfig: () => Promise<void> } } };
      }).__zustandStores;
      return stores?.config.getState().loadConfig();
    });

    await openDeveloperTab();

    await expect(toggleForTitle('Persistent Console Logs')).toHaveAttribute('aria-checked', 'false');
    await expect(toggleForTitle('Record IPC Traffic')).toHaveAttribute('aria-checked', 'false');

    await closeSettings();
  });
});
