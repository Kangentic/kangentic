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

/**
 * The sentence main composes (`READ_ONLY_VOLUME_MESSAGE` in src/main/updater.ts).
 * Copied rather than imported: this tier runs the renderer against the mock
 * bridge with no main process, and the contract under test is precisely that
 * the renderer toasts whatever main sent VERBATIM, so a literal is the honest
 * fixture. main's own half is pinned in tests/unit/updater-retry.test.ts.
 */
const READ_ONLY_VOLUME_MESSAGE =
  'Kangentic cannot install updates while it runs from a read-only volume. '
  + 'Move Kangentic to your Applications folder to keep it up to date.';

/** The default toast lifetime, `notifications.toasts.durationSeconds` in DEFAULT_CONFIG. */
const DEFAULT_TOAST_MS = 4000;

async function fireUpdateBlocked(target: Page, message: string) {
  await target.evaluate((payload) => {
    // Installed unconditionally at mock-bootstrap time (mock-electron-api.js);
    // a missing hook here is a real test-infra bug, not a state a test should
    // silently tolerate.
    if (!window.__mockFireUpdateBlocked) {
      throw new Error('window.__mockFireUpdateBlocked is not installed by the mock');
    }
    window.__mockFireUpdateBlocked(payload);
  }, message);
}

/**
 * DESKTOP-1A is the only updater failure the app says anything about, and the
 * renderer's whole job in it is four lines in App.tsx. Without this file those
 * four lines can be deleted with every unit test still green: the main-side
 * suite stops at `webContents.send`, and the mock-parity test only asserts the
 * bridge method exists.
 */
test.describe('Update-blocked toast', () => {
  test('toasts the message main sent, verbatim and unstyled by the renderer', async () => {
    await fireUpdateBlocked(page, READ_ONLY_VOLUME_MESSAGE);

    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    // Verbatim: the renderer must not reformat, truncate, or prefix it. main
    // owns the wording so the two halves cannot drift into two sentences.
    await expect(toast).toHaveText(READ_ONLY_VOLUME_MESSAGE);
  });

  test('uses the warning variant, not error', async () => {
    await fireUpdateBlocked(page, READ_ONLY_VOLUME_MESSAGE);

    // Deliberately different from the config write-failure toast next to it in
    // App.tsx: nothing is broken and nothing was lost, the app simply cannot
    // update itself from where it was launched.
    await expect(page.getByTestId('toast')).toHaveClass(/border-yellow-500\/50/);
  });

  test('persists past the default toast lifetime instead of auto-dismissing', async () => {
    await fireUpdateBlocked(page, READ_ONLY_VOLUME_MESSAGE);

    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();

    // The condition does not resolve on its own, so neither does the toast. A
    // regression to a timed toast would let the one notice this app run gets
    // disappear while the user was looking elsewhere. Generous margin over the
    // 4s default so the assertion is about duration: 0, not about timing.
    await page.waitForTimeout(DEFAULT_TOAST_MS * 2);
    await expect(toast).toBeVisible();
  });

  test('the user can dismiss it', async () => {
    await fireUpdateBlocked(page, READ_ONLY_VOLUME_MESSAGE);
    await expect(page.getByTestId('toast')).toBeVisible();

    // A persistent toast the user cannot get rid of would be worse than the
    // silence it replaced.
    await page.getByTestId('toast-dismiss').click();
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});
