import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

// Each describe is isolated per worker (separate process; per-test page launch / goto reset),
// so the file's tests can fan out across the UI workers safely.
test.describe.configure({ mode: 'parallel' });

let page: Page;

test.beforeEach(async () => {
  const launched = await launchPage();
  page = launched.page;
  await createProject(page, 'TestProject');
});

test.afterEach(async () => {
  await page.context().browser()?.close();
});

async function fireUpdateDownloaded(target: Page, info: { version: string; releaseNotes: string }) {
  await target.evaluate((payload) => {
    // Installed unconditionally at mock-bootstrap time (mock-electron-api.js);
    // a missing hook here is a real test-infra bug, not a state a test
    // should silently tolerate.
    if (!window.__mockFireUpdateDownloaded) {
      throw new Error('window.__mockFireUpdateDownloaded is not installed by the mock');
    }
    window.__mockFireUpdateDownloaded(payload);
  }, info);
}

/** Reads the config store's persisted `lastSeenReleaseNotesVersion`, exposed
 *  dev-only via `window.__zustandStores` (see App.tsx). */
async function readLastSeenReleaseNotesVersion(target: Page): Promise<string> {
  return target.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { config: { lastSeenReleaseNotesVersion: string } } } };
    }).__zustandStores;
    if (!stores) throw new Error('window.__zustandStores not exposed');
    return stores.config.getState().config.lastSeenReleaseNotesVersion;
  });
}

test.describe('Release notes modal', () => {
  test('update-downloaded with notes opens the modal with rendered markdown', async () => {
    await fireUpdateDownloaded(page, {
      version: '9.9.9',
      releaseNotes: '## What\'s New\n\n- A brand new thing',
    });

    const dialog = page.getByTestId('release-notes-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Version 9.9.9 is ready to install' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: "What's New" })).toBeVisible();
    await expect(dialog.getByText('A brand new thing')).toBeVisible();
  });

  test('Restart to update calls installUpdate', async () => {
    await fireUpdateDownloaded(page, { version: '9.9.9', releaseNotes: 'Some notes' });
    await page.getByTestId('release-notes-dialog').getByRole('button', { name: 'Restart to update' }).click();

    const calls = await page.evaluate(() => window.__mockInstallUpdateCalls ?? []);
    expect(calls).toHaveLength(1);
  });

  test('Later dismisses the modal and leaves a reopenable title-bar indicator', async () => {
    await fireUpdateDownloaded(page, { version: '9.9.9', releaseNotes: 'Some notes' });
    const dialog = page.getByTestId('release-notes-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Later' }).click();
    await expect(dialog).toBeHidden();

    const indicator = page.getByTestId('update-available-button');
    await expect(indicator).toBeVisible();

    await indicator.click();
    await expect(page.getByTestId('release-notes-dialog')).toBeVisible();
  });

  test('GitHub Release link opens the release page for this version', async () => {
    await fireUpdateDownloaded(page, { version: '9.9.9', releaseNotes: 'Some notes' });
    await page.getByTestId('release-notes-github-link').click();

    const calls = await page.evaluate(() => window.__openedExternalUrls ?? []);
    expect(calls).toEqual(['https://github.com/Kangentic/kangentic/releases/tag/v9.9.9']);
  });

  test('update-downloaded with no notes falls back to the persistent toast, no modal', async () => {
    await fireUpdateDownloaded(page, { version: '9.9.9', releaseNotes: '' });

    await expect(page.getByTestId('release-notes-dialog')).toHaveCount(0);
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Version 9.9.9 is ready to install');
    await expect(page.getByTestId('update-available-button')).toHaveCount(0);
  });

  test('a second update-downloaded push for an already-seen version keeps the indicator but does not reopen the modal', async () => {
    await fireUpdateDownloaded(page, { version: '9.9.9', releaseNotes: 'Some notes' });
    const dialog = page.getByTestId('release-notes-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Later' }).click();
    await expect(dialog).toHaveCount(0);

    // dismiss() persists lastSeenReleaseNotesVersion via a fire-and-forget
    // updateConfig call (not synchronously with the click), so poll for the
    // write to land before re-firing the same version - otherwise the
    // second push could race ahead of the persisted "already seen" state.
    await expect.poll(() => readLastSeenReleaseNotesVersion(page)).toBe('9.9.9');

    await fireUpdateDownloaded(page, { version: '9.9.9', releaseNotes: 'Some notes' });

    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('update-available-button')).toBeVisible();
  });

  test('an auto-opened modal does not steal focus; reopening via the title-bar indicator traps it', async () => {
    // Anchor a known focus target before the update lands, so we can prove
    // the auto-opened modal never pulls focus away from it.
    const searchButton = page.locator('[data-testid="open-search-button"]');
    await searchButton.focus();
    await expect(searchButton).toBeFocused();

    await fireUpdateDownloaded(page, { version: '9.9.9', releaseNotes: 'Some notes' });
    const dialog = page.getByTestId('release-notes-dialog');
    await expect(dialog).toBeVisible();

    // Auto-opened: focus must stay put and the content wrapper must not be a
    // focus trap (no tabindex="-1"), so an unbidden modal never interrupts a
    // PTY mid-keystroke.
    await expect(searchButton).toBeFocused();
    await expect(dialog).not.toHaveAttribute('tabindex');

    await dialog.getByRole('button', { name: 'Later' }).click();
    const indicator = page.getByTestId('update-available-button');
    await expect(indicator).toBeVisible();
    await indicator.click();
    await expect(dialog).toBeVisible();

    // Reopened via the title-bar indicator: this is a user-initiated reopen,
    // so it traps focus normally, pulling it into the dialog.
    await expect.poll(async () => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(dialog).toHaveAttribute('tabindex', '-1');
  });
});
