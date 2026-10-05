/**
 * The Dictation tab's Transcription card: the Mode presets, the model list that
 * names what each slot runs, and the License line under it.
 *
 * Main resolves a preset to its models (`resolveDictationSlots` in
 * src/shared/dictation-presets.ts), so the mock's `dictation.getInfo` answers
 * with a fixed selection through `window.__mockDictationInfoOverrides`. That
 * keeps these tests on what the renderer owns: which preset reads as selected,
 * how each line reads in each state, which licenses show, and what a mode
 * change writes to config.
 *
 * Each test launches its own page, because a mode click persists to config and
 * a later test must not start from it.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import { buildDictationInfo } from '../../src/main/transcription/dictation-info';

test.describe.configure({ mode: 'parallel' });

const NEMOTRON_STREAMING = {
  id: 'nemotron-streaming-0.6b-en',
  displayName: 'Nemotron streaming',
  sizeMb: 631,
  engineKind: 'online-transducer',
  languages: ['en'],
  accuracyRank: 5,
  accuracyLabel: 'High accuracy',
  license: 'NVIDIA-Open-Model-License',
};
const PARAKEET_V3 = {
  id: 'parakeet-tdt-0.6b-v3',
  displayName: 'Parakeet v3 (multilingual)',
  sizeMb: 639,
  engineKind: 'offline-nemo-transducer',
  languages: ['en', 'pt', 'es', 'it', 'fr', 'de', 'nl', 'ru', 'pl', 'uk'],
  accuracyRank: 6,
  accuracyLabel: 'High accuracy',
  license: 'CC-BY-4.0',
};

/** The Best preset on a capable machine: Nemotron live, Parakeet v3 to refine. */
const BEST_SELECTION = {
  liveModels: [NEMOTRON_STREAMING, PARAKEET_V3],
  finalModels: [PARAKEET_V3],
  selectedLiveModelId: NEMOTRON_STREAMING.id,
  selectedFinalModelId: PARAKEET_V3.id,
};

async function launchWithInfo(overrides: Record<string, unknown>): Promise<{ browser: Browser; page: Page }> {
  const result = await launchPage();
  await createProject(result.page, `Dictation Models Test ${Date.now()}`);
  await result.page.evaluate((value) => {
    (window as unknown as { __mockDictationInfoOverrides: Record<string, unknown> | null })
      .__mockDictationInfoOverrides = value;
  }, overrides);
  return result;
}

/** Open Settings on the Dictation tab with dictation on, so the Transcription
 *  card renders (off means hidden, not greyed out). */
async function openDictationTab(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.getByRole('button', { name: 'Dictation', exact: true }).click();
  const master = page.getByRole('switch', { name: 'Voice dictation' });
  if ((await master.getAttribute('aria-checked')) !== 'true') await master.click();
  await expect(master).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('dictation-model-lines')).toBeVisible();
}

/** The dictation config the renderer's config store holds now. */
async function dictationConfig(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __zustandStores?: { config: { getState: () => { config: { dictation?: Record<string, unknown> } } } };
    }).__zustandStores;
    return stores?.config.getState().config.dictation;
  });
}

test('Mode offers Best, Balanced, Light and Custom, with Best selected by default and no Punctuation row', async () => {
  const { browser, page } = await launchWithInfo(BEST_SELECTION);
  try {
    await openDictationTab(page);
    const choice = page.getByTestId('dictation-preset-choice');
    await expect(choice.getByRole('radio')).toHaveText(['Best', 'Balanced', 'Light', 'Custom']);
    await expect(page.getByTestId('dictation-preset-accurate')).toHaveAttribute('aria-checked', 'true');
    // A preset picks the models, so the two dropdowns stay hidden.
    await expect(page.getByTestId('dictation-live-model-select')).toHaveCount(0);
    await expect(page.getByTestId('settings-content')).not.toContainText('Punctuation');
  } finally {
    await browser.close();
  }
});

test('each line names its model: ready with its size, queued muted, downloading with its share', async () => {
  const { browser, page } = await launchWithInfo({ ...BEST_SELECTION, installedModels: [NEMOTRON_STREAMING.id] });
  try {
    await openDictationTab(page);
    await expect(page.getByTestId('dictation-live-model-line-value')).toHaveText('Nemotron streaming, 631 MB');
    // Not on disk and no download reported yet: queued, its size shown muted.
    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText('Parakeet v3 (multilingual), 639 MB');
    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveClass(/text-fg-muted/);

    // The always-mounted dictation hook subscribes once dictation is on.
    await page.waitForFunction(() => {
      const listeners = (window as unknown as { __mockDictationModelProgressListeners?: unknown[] })
        .__mockDictationModelProgressListeners;
      return (listeners?.length ?? 0) > 0;
    }, undefined, { timeout: 5000 });
    await page.evaluate((modelId) => {
      (window as unknown as { __emitDictationModelProgress?: (event: unknown) => void }).__emitDictationModelProgress?.({
        modelId,
        status: 'downloading',
        downloadedBytes: 0,
        totalBytes: 0,
        modelDownloadedBytes: 42,
        modelTotalBytes: 100,
      });
    }, PARAKEET_V3.id);
    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText('Parakeet v3 (multilingual), 42%');
    await expect(page.getByTestId('dictation-refinement-model-line').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    // The live line is already on disk and keeps its check.
    await expect(page.getByTestId('dictation-live-model-line').getByRole('progressbar')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// Best downloads its two models one after the other. The first one, once on
// disk, must read ready while the second is still coming, not queued.
test('a model that finished downloading reads ready while the next one downloads', async () => {
  const { browser, page } = await launchWithInfo({ ...BEST_SELECTION, installedModels: [] });
  try {
    await openDictationTab(page);
    await page.waitForFunction(() => {
      const listeners = (window as unknown as { __mockDictationModelProgressListeners?: unknown[] })
        .__mockDictationModelProgressListeners;
      return (listeners?.length ?? 0) > 0;
    }, undefined, { timeout: 5000 });
    const emitDownloading = (modelId: string, share: number) => page.evaluate(({ id, downloaded }) => {
      (window as unknown as { __emitDictationModelProgress?: (event: unknown) => void }).__emitDictationModelProgress?.({
        modelId: id, status: 'downloading', downloadedBytes: 0, totalBytes: 0, modelDownloadedBytes: downloaded, modelTotalBytes: 100,
      });
    }, { id: modelId, downloaded: share });

    await emitDownloading(NEMOTRON_STREAMING.id, 50);
    await expect(page.getByTestId('dictation-live-model-line-value')).toHaveText('Nemotron streaming, 50%');

    // Nemotron is now on disk, which the next getInfo reports; the download
    // moves on to Parakeet v3.
    await page.evaluate((value) => {
      (window as unknown as { __mockDictationInfoOverrides: Record<string, unknown> | null })
        .__mockDictationInfoOverrides = value;
    }, { ...BEST_SELECTION, installedModels: [NEMOTRON_STREAMING.id] });
    await emitDownloading(PARAKEET_V3.id, 10);

    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText('Parakeet v3 (multilingual), 10%');
    await expect(page.getByTestId('dictation-live-model-line-value')).toHaveText('Nemotron streaming, 631 MB');
    await expect(page.getByTestId('dictation-live-model-line-value').locator('svg')).toHaveCount(1);
  } finally {
    await browser.close();
  }
});

test('a preset with no refinement model reads None on that line, and the License line names only the live model\'s', async () => {
  const { browser, page } = await launchWithInfo({ ...BEST_SELECTION, selectedFinalModelId: null });
  try {
    await openDictationTab(page);
    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText('None');
    await expect(page.getByTestId('dictation-license-link')).toHaveText(['NVIDIA Open Model License']);
  } finally {
    await browser.close();
  }
});

test('the License line names each running license once and opens it outside the app', async () => {
  const { browser, page } = await launchWithInfo(BEST_SELECTION);
  try {
    await openDictationTab(page);
    const links = page.getByTestId('dictation-license-link');
    await expect(links).toHaveText(['NVIDIA Open Model License', 'CC-BY-4.0']);
    // The flex gap spaces the words, so the text nodes carry none.
    await expect(page.getByTestId('dictation-license')).toHaveText(/NVIDIA Open Model License\s*and\s*CC-BY-4\.0/);
    await links.nth(1).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __openedExternalUrls?: string[] }).__openedExternalUrls ?? []))
      .toEqual(['https://creativecommons.org/licenses/by/4.0/']);
  } finally {
    await browser.close();
  }
});

test('Balanced then Custom opens Custom on the models Balanced was running', async () => {
  const { browser, page } = await launchWithInfo(BEST_SELECTION);
  try {
    await openDictationTab(page);
    await page.getByTestId('dictation-preset-balanced').click();
    // A preset is a name main resolves, so it saves no model ids.
    await expect.poll(async () => (await dictationConfig(page))?.mode).toBe('balanced');
    expect((await dictationConfig(page))?.liveModelId ?? null).toBeNull();

    await page.getByTestId('dictation-preset-custom').click();
    await expect
      .poll(async () => {
        const dictation = await dictationConfig(page);
        return { mode: dictation?.mode, liveModelId: dictation?.liveModelId, modelId: dictation?.modelId };
      })
      .toEqual({ mode: 'custom', liveModelId: PARAKEET_V3.id, modelId: 'none' });
    await expect(page.getByTestId('dictation-live-model-select')).toHaveValue(PARAKEET_V3.id);
    await expect(page.getByTestId('dictation-final-model-select')).toHaveValue('none');
  } finally {
    await browser.close();
  }
});

/**
 * A native dropdown never wraps an option: a long one widens the open menu past
 * the field instead. So every option of the real catalogue, the one main builds
 * (`buildDictationInfo`), has to fit inside the closed field at the app's
 * smallest window (900x600). English lists every model, so it is the widest
 * case. Measured with the field's own font, against its width less its padding.
 */
test('every model option fits inside its closed dropdown at the 900x600 window floor', async () => {
  const catalogue = buildDictationInfo(
    { cpuModel: 'Test CPU', cpuCores: 8, totalRamGb: 16, hasAvx2: false, gpu: 'none', platform: 'linux', arch: 'x64' },
    { mode: 'custom' },
    [],
  );
  const { browser, page } = await launchWithInfo({
    liveModels: catalogue.liveModels,
    finalModels: catalogue.finalModels,
    selectedLiveModelId: catalogue.selectedLiveModelId,
    selectedFinalModelId: catalogue.selectedFinalModelId,
  });
  try {
    await page.setViewportSize({ width: 900, height: 600 });
    await openDictationTab(page);
    await page.getByTestId('dictation-preset-custom').click();
    for (const testId of ['dictation-live-model-select', 'dictation-final-model-select']) {
      const select = page.getByTestId(testId);
      await expect(select).toBeVisible();
      const measured = await select.evaluate((element) => {
        const field = element as HTMLSelectElement;
        const style = getComputedStyle(field);
        const context = document.createElement('canvas').getContext('2d');
        if (!context) return { room: 0, options: [] };
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return {
          room: field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          options: Array.from(field.options).map((option) => ({ text: option.text, width: context.measureText(option.text).width })),
        };
      });
      // The whole catalogue, not an empty list that passes by having nothing to measure.
      expect(measured.options.length, testId).toBeGreaterThan(3);
      const overflow = measured.options
        .filter((option) => option.width > measured.room)
        .map((option) => `"${option.text}" is ${Math.round(option.width)}px in ${Math.round(measured.room)}px`);
      expect(overflow, testId).toEqual([]);
    }
  } finally {
    await browser.close();
  }
});
