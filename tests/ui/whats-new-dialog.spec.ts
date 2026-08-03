/**
 * UI tests for the post-update "What's New" dialog: the notes for the version
 * the app is currently RUNNING, shown once on the first launch after the version
 * changes and reopenable from the status-bar version pill.
 *
 * Content is deliberately never asserted. The notes are the repo's real
 * RELEASE_NOTES.md, inlined into the bundle at build time (see
 * src/renderer/lib/baked-release-notes.ts), and that file is rewritten by
 * `/release` at every cut. Asserting on any phrase in it would fail on the next
 * release. These tests assert structure instead: the dialog element, its
 * rendered-markdown body being non-empty, focus behaviour, and the persisted
 * marker. tests/ui/release-notes-modal.spec.ts can assert exact text only
 * because it injects its own fixture notes over IPC; there is no such injection
 * point here by design.
 *
 * Each test launches its own browser so no state crosses tests.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

/** The version the mock's app.getVersion() reports (mock-electron-api.js). */
const MOCK_APP_VERSION = '0.1.0';

async function launchWithState(preConfigScript?: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  if (preConfigScript) await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  return { browser, page };
}

/** Seeds a marker that does NOT match the mocked app version, which is what a
 *  user who just upgraded looks like. */
function upgradedPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      state.config.lastWhatsNewShownVersion = '0.0.1';
    });
  `;
}

/** Reads the persisted marker through the dev-only store bridge (App.tsx). */
async function readMarker(target: Page): Promise<string> {
  return target.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { config: { lastWhatsNewShownVersion: string } } } };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    return stores.config.getState().config.lastWhatsNewShownVersion;
  });
}

test.describe("What's New dialog", () => {
  test('does not open when the running version has already been shown', async () => {
    // The regression guard for the whole tier. The mock seeds the marker to the
    // version it reports, so this dialog must stay closed on a default boot - an
    // unexpected auto-open would put a full-screen backdrop over every other
    // spec and swallow their clicks.
    const { browser, page } = await launchWithState();
    try {
      await page.waitForSelector('[data-testid="status-bar-version-pill"]');
      await expect(page.getByTestId('whats-new-dialog')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('auto-opens once when the running version differs from the recorded one', async () => {
    const { browser, page } = await launchWithState(upgradedPreConfig());
    try {
      const dialog = page.getByTestId('whats-new-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.getByRole('heading', { name: `What's new in v${MOCK_APP_VERSION}` })).toBeVisible();

      // Structural, not textual: the markdown body rendered something.
      await expect(dialog.locator('.markdown-body')).not.toBeEmpty();

      // The marker is written when it OPENS, not on close, so quitting with the
      // dialog still up does not re-arm it for the next launch.
      await expect.poll(() => readMarker(page)).toBe(MOCK_APP_VERSION);
    } finally {
      await browser.close();
    }
  });

  test('an auto-opened dialog does not trap focus', async () => {
    // An unbidden modal must not steal focus from a PTY mid-keystroke, so
    // `trapFocus` is off for the auto-open. Mirrors the pre-restart modal's
    // equivalent assertion in release-notes-modal.spec.ts.
    const { browser, page } = await launchWithState(upgradedPreConfig());
    try {
      const dialog = page.getByTestId('whats-new-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).not.toHaveAttribute('tabindex');
    } finally {
      await browser.close();
    }
  });

  test('the status-bar version pill reopens it, and a user-initiated open traps focus', async () => {
    const { browser, page } = await launchWithState();
    try {
      await expect(page.getByTestId('whats-new-dialog')).toHaveCount(0);

      await page.getByTestId('status-bar-version-pill').click();

      const dialog = page.getByTestId('whats-new-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('tabindex', '-1');
    } finally {
      await browser.close();
    }
  });

  test('Close and Escape both dismiss it', async () => {
    const { browser, page } = await launchWithState();
    try {
      await page.getByTestId('status-bar-version-pill').click();
      const dialog = page.getByTestId('whats-new-dialog');
      await expect(dialog).toBeVisible();

      // By testid, not by name: BaseDialog's header X is also labelled "Close".
      await page.getByTestId('whats-new-close').click();
      await expect(dialog).toBeHidden();

      await page.getByTestId('status-bar-version-pill').click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    } finally {
      await browser.close();
    }
  });

  test('the GitHub Release link points at the running version', async () => {
    const { browser, page } = await launchWithState();
    try {
      await page.getByTestId('status-bar-version-pill').click();
      await page.getByTestId('whats-new-github-link').click();

      await expect.poll(() => page.evaluate(() => window.__openedExternalUrls))
        .toEqual([`https://github.com/Kangentic/kangentic/releases/tag/v${MOCK_APP_VERSION}`]);
    } finally {
      await browser.close();
    }
  });

  test('the no-notes toast stays clickable over an open what\'s-new dialog', async () => {
    // The notes-less update path shows a persistent toast instead of a modal, so
    // the store deliberately leaves what's-new open. That is only correct if the
    // toast actually reaches the user: toasts render at z-[60] and BaseDialog at
    // z-50, so the toast should sit above the dialog's `fixed inset-0` backdrop.
    // Asserting store state cannot prove that - this clicks the toast's action
    // for real, so Playwright's actionability check fails if the backdrop is
    // swallowing the pointer events.
    const { browser, page } = await launchWithState();
    try {
      await page.getByTestId('status-bar-version-pill').click();
      await expect(page.getByTestId('whats-new-dialog')).toBeVisible();

      await page.evaluate(() => {
        if (!window.__mockFireUpdateDownloaded) {
          throw new Error('window.__mockFireUpdateDownloaded is not installed by the mock');
        }
        window.__mockFireUpdateDownloaded({ version: '9.9.9', releaseNotes: '' });
      });

      await expect(page.getByTestId('whats-new-dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Restart to update' }).click();

      expect(await page.evaluate(() => window.__mockInstallUpdateCalls ?? [])).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('a downloaded update takes the screen from an open what\'s-new dialog', async () => {
    const { browser, page } = await launchWithState();
    try {
      await page.getByTestId('status-bar-version-pill').click();
      await expect(page.getByTestId('whats-new-dialog')).toBeVisible();

      await page.evaluate(() => {
        if (!window.__mockFireUpdateDownloaded) {
          throw new Error('window.__mockFireUpdateDownloaded is not installed by the mock');
        }
        window.__mockFireUpdateDownloaded({ version: '9.9.9', releaseNotes: 'Some notes' });
      });

      // Never both: each is a BaseDialog with its own full-screen backdrop.
      await expect(page.getByTestId('release-notes-dialog')).toBeVisible();
      await expect(page.getByTestId('whats-new-dialog')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
});
