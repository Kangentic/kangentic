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
import { emitModelProgress, waitForProgressListener } from './helpers/dictation-model-progress';
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
 * The model list (`dictation-model-lines`) names the model each slot runs and
 * whether it is on disk. A stopped worker downloads nothing, so the list would
 * read as queued forever beside the crash banner that already explains the dead
 * end. The list is therefore hidden while `info.workerUnavailable` is true and
 * shown otherwise.
 *
 * The two tests below are a pair: they share one model pick and differ only in
 * `workerUnavailable`, so the assertion on the list is the only thing that can
 * explain a different outcome.
 */
const STREAMING_ZIPFORMER = {
  id: 'streaming-zipformer-en',
  displayName: 'Streaming Zipformer',
  sizeMb: 70,
  engineKind: 'online-transducer',
  languages: ['en'],
  accuracyRank: 1,
  accuracyLabel: 'Basic accuracy',
  license: 'Apache-2.0',
};
const PICKED_LIVE_MODEL = { selectedLiveModelId: STREAMING_ZIPFORMER.id, liveModels: [STREAMING_ZIPFORMER] };

test.describe('DictationTab: model list', () => {
  test.afterEach(async () => {
    await setDictationInfoOverride(null);
  });

  test('is shown when the worker is available and a model is picked', async () => {
    await setDictationInfoOverride({ ...PICKED_LIVE_MODEL, workerUnavailable: false });
    await openDictationTab();
    await expect(page.getByTestId('dictation-language-select')).toBeVisible();
    await expect(page.getByTestId('dictation-model-lines')).toBeVisible();
    await expect(page.getByTestId('dictation-worker-unavailable')).toHaveCount(0);
    await closeSettings();
  });

  test('is absent when the worker is unavailable, even with a model picked', async () => {
    await setDictationInfoOverride({ ...PICKED_LIVE_MODEL, workerUnavailable: true });
    await openDictationTab();
    // The banner and the list render from the same `info`, so once the banner
    // is up the list's absence is settled and needs no fixed wait.
    await expect(page.getByTestId('dictation-worker-unavailable')).toBeVisible();
    await expect(page.getByTestId('dictation-language-select')).toBeVisible();
    await expect(page.getByTestId('dictation-model-lines')).toHaveCount(0);
    await closeSettings();
  });
});

/**
 * A failed download's raw error ("Download failed (404) for https://<long url>")
 * can be far wider than a line. The line names the failure and the model, and
 * the error itself rides in the line's info tip, so the line keeps one short
 * value whatever the error says. The geometry is read inside `page.evaluate`
 * and is relative (an edge against another edge, with a tolerance), so font
 * metrics and scrollbar widths on a Linux CI runner do not matter.
 */
test.describe('DictationTab: a long download error stays behind its line\'s info tip', () => {
  const LONG_ERROR = `Download failed (404) for https://models.example.test/releases/download/asr-models/${'segment-'.repeat(40)}streaming-zipformer-en.tar.bz2`;
  const EDGE_TOLERANCE_PX = 2;

  test.afterEach(async () => {
    await setDictationInfoOverride(null);
    // `done` clears the store's progress, so the error does not reach a sibling spec.
    await emitModelProgress(page, { modelId: STREAMING_ZIPFORMER.id, status: 'done', downloadedBytes: 0, totalBytes: 0 });
  });

  test('names the failure on its line, keeps the whole error on the info tip, and overflows neither the tile nor the scroller', async () => {
    await setDictationInfoOverride(PICKED_LIVE_MODEL);
    await openDictationTab();
    await expect(page.getByTestId('dictation-model-lines')).toBeVisible();
    // The always-mounted dictation hook subscribes once dictation is on, so an
    // event pushed before that would reach no one.
    await waitForProgressListener(page);

    await emitModelProgress(page, {
      modelId: STREAMING_ZIPFORMER.id,
      status: 'error',
      downloadedBytes: 0,
      totalBytes: 0,
      error: LONG_ERROR,
    });

    const line = page.getByTestId('dictation-live-model-line');
    await expect(page.getByTestId('dictation-live-model-line-value')).toHaveText('Download failed, Streaming Zipformer');
    await expect(line.getByRole('button', { name: /^About Live model/ })).toHaveAttribute('title', LONG_ERROR);

    // Polled: the panel slides in, and the assertion is on layout once it settles.
    await expect.poll(async () => page.evaluate((tolerance) => {
      const byTestId = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);
      const tile = byTestId('dictation-model-lines');
      const value = byTestId('dictation-live-model-line-value');
      const scroller = byTestId('settings-content');
      if (!tile || !value || !scroller) return ['the list, the value or the settings scroller is missing'];
      const violations: string[] = [];
      if (value.getBoundingClientRect().right > tile.getBoundingClientRect().right + tolerance) {
        violations.push('the value ends past the tile\'s right edge');
      }
      if (scroller.scrollWidth > scroller.clientWidth + tolerance) {
        violations.push(`the settings scroller overflows by ${scroller.scrollWidth - scroller.clientWidth}px`);
      }
      return violations;
    }, EDGE_TOLERANCE_PX), { timeout: 5000 }).toEqual([]);

    await closeSettings();
  });
});
