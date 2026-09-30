/**
 * Coverage for the worker-unavailable banner in `DictationTab`
 * (src/renderer/components/settings/tabs/DictationTab.tsx, around lines
 * 291-299). It renders only when `info.workerUnavailable` is true: the
 * `kangentic-dictation` utilityProcess worker has crashed repeatedly and the
 * restart policy has given up for the current decay window (see
 * .claude/rules/dictation-out-of-process.md), and push-to-talk has no
 * fallback engine, so the settings panel is the only place this dead end is
 * surfaced. Before this file, no test exercised `DictationTab` at all - the
 * whole banner block could be deleted and no test would fail.
 *
 * `dictation.getInfo()` drives this from the main process; the mock's
 * `window.__mockDictationInfoOverrides` hook (mirroring the existing
 * `probePath()` override idiom) lets each test steer the response without
 * touching what every other UI spec's `getInfo()` call sees.
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
  await createProject(page, `Dictation Worker Unavailable Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

/** Merge over `dictation.getInfo()`'s default response for the next call.
 *  Reset to `null` after every test so nothing leaks into a sibling spec. */
async function setDictationInfoOverride(overrides: Record<string, unknown> | null): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __mockDictationInfoOverrides: Record<string, unknown> | null })
      .__mockDictationInfoOverrides = value;
  }, overrides);
}

/** Open Settings and switch to the Dictation tab, which fetches `getInfo()`
 *  fresh on mount - so setting the override before this call is what the
 *  fetch actually sees. */
async function openDictationTab(): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Dictation', exact: true }).click();
  // The Transcription card, where the banner lives, shows only with dictation
  // on: off means hidden, not greyed out.
  const master = page.getByRole('switch', { name: 'Voice dictation' });
  if ((await master.getAttribute('aria-checked')) !== 'true') await master.click();
  await expect(master).toHaveAttribute('aria-checked', 'true');
}

/** Switching to another tab unmounts `DictationTab`, so the next
 *  `openDictationTab()` remounts it and re-fetches `getInfo()` under
 *  whatever override that test set. */
async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

test.describe('DictationTab: worker-unavailable banner', () => {
  test.afterEach(async () => {
    await setDictationInfoOverride(null);
  });

  test('is absent when the worker is available (the negative case)', async () => {
    await setDictationInfoOverride(null);
    await openDictationTab();
    // A settled sibling control proves the tab actually mounted and fetched
    // info, so an absent banner here is not just an unmounted tab.
    await expect(page.getByTestId('dictation-language-select')).toBeVisible();
    await expect(page.locator('[data-testid="dictation-worker-unavailable"]')).toHaveCount(0);
    await closeSettings();
  });

  test('shows the crash message with the worker error in parentheses', async () => {
    await setDictationInfoOverride({
      workerUnavailable: true,
      workerError: 'exit code 3 (SIGSEGV)',
    });
    await openDictationTab();
    const banner = page.locator('[data-testid="dictation-worker-unavailable"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(
      'Dictation stopped after repeated crashes (exit code 3 (SIGSEGV)). Restart Kangentic to try again.',
    );
    await closeSettings();
  });

  test('shows the crash message with no parentheses when there is no worker error', async () => {
    await setDictationInfoOverride({ workerUnavailable: true });
    await openDictationTab();
    const banner = page.locator('[data-testid="dictation-worker-unavailable"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(
      'Dictation stopped after repeated crashes. Restart Kangentic to try again.',
    );
    await closeSettings();
  });
});

/**
 * The model download/status row (`dictation-model-download`) names the models
 * the current setup runs and whether they are on disk. A stopped worker
 * downloads nothing, so the row would read "Downloading" forever beside the
 * crash banner that already explains the dead end. The row is therefore
 * hidden while `info.workerUnavailable` is true and shown otherwise.
 *
 * The two tests below are a pair: they share one model pick (the mock's
 * default config leaves the live slot empty, so a model must be picked through
 * `selectedLiveModelId` or no row would render in either case) and differ only
 * in `workerUnavailable`, so the assertion on the row is the only thing that
 * can explain a different outcome.
 */
test.describe('DictationTab: model status row', () => {
  test.afterEach(async () => {
    await setDictationInfoOverride(null);
  });

  const PICKED_LIVE_MODEL = { selectedLiveModelId: 'streaming-zipformer-en' };

  test('is shown when the worker is available and a model is picked', async () => {
    await setDictationInfoOverride({ ...PICKED_LIVE_MODEL, workerUnavailable: false });
    await openDictationTab();
    await expect(page.getByTestId('dictation-language-select')).toBeVisible();
    await expect(page.getByTestId('dictation-model-download')).toBeVisible();
    await expect(page.getByTestId('dictation-worker-unavailable')).toHaveCount(0);
    await closeSettings();
  });

  test('is absent when the worker is unavailable, even with a model picked', async () => {
    await setDictationInfoOverride({ ...PICKED_LIVE_MODEL, workerUnavailable: true });
    await openDictationTab();
    // The banner and the row render from the same `info`, so once the banner
    // is up the row's absence is settled and needs no fixed wait.
    await expect(page.getByTestId('dictation-worker-unavailable')).toBeVisible();
    await expect(page.getByTestId('dictation-language-select')).toBeVisible();
    await expect(page.getByTestId('dictation-model-download')).toHaveCount(0);
    await closeSettings();
  });
});
