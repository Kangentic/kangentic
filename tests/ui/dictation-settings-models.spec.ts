/**
 * The Dictation tab's Transcription card: the Mode presets, the model list that
 * names what each slot runs, and the License line under it.
 *
 * Main resolves a preset to its models (`resolveDictationSlots` in
 * src/shared/dictation-presets.ts), so the mock's `dictation.getInfo` answers
 * with a fixed selection through `window.__mockDictationInfoOverrides`. That
 * keeps these tests on what the renderer owns: which preset reads as selected,
 * how each line reads in each state, which licenses show, what a mode change
 * writes to config, what a language change writes in each mode, and that the
 * saved Mode reaches the warm-up request.
 *
 * Each test launches its own page, because a mode click persists to config and
 * a later test must not start from it.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import { emitModelProgress, waitForProgressListener } from './helpers/dictation-model-progress';
import { buildDictationInfo } from '../../src/main/transcription/dictation-info';
import { PRESET_MODEL_IDS } from '../../src/shared/dictation-presets';
import type { DictationHardwareProfile, DictationModelOption } from '../../src/shared/types';

test.describe.configure({ mode: 'parallel' });

/** Any machine: the catalogue lists every registry model whatever the hardware,
 *  so the profile only has to be well formed. */
const CATALOGUE_HARDWARE: DictationHardwareProfile = {
  cpuModel: 'Test CPU', cpuCores: 8, totalRamGb: 16, hasAvx2: false, gpu: 'none', platform: 'linux', arch: 'x64',
};

/** The catalogue main builds for the Dictation tab (`buildDictationInfo`). The
 *  model fixtures below are read out of it, so their size, license, languages and
 *  accuracy are the registry's own and cannot drift from it. */
const REGISTRY_CATALOGUE = buildDictationInfo(CATALOGUE_HARDWARE, { mode: 'custom' }, []);

function registryModel(modelId: string): DictationModelOption {
  const model = [...REGISTRY_CATALOGUE.liveModels, ...REGISTRY_CATALOGUE.finalModels]
    .find((option) => option.id === modelId);
  if (!model) throw new Error(`${modelId} is not in the registry's model catalogue`);
  return model;
}

const NEMOTRON_STREAMING = registryModel(PRESET_MODEL_IDS.nemotronEnglish);
const PARAKEET_V3 = registryModel(PRESET_MODEL_IDS.parakeetV3);

/** How a model's line reads in each state. The name, size and download share
 *  come from the fixture, so a registry edit moves the fixture and these
 *  together; what the specs pin is the format around them. */
function readyText(model: DictationModelOption): string {
  return `${model.displayName}, ${model.sizeMb} MB`;
}
function downloadingText(model: DictationModelOption, percent: number): string {
  return `${model.displayName}, ${percent}%`;
}
function failedText(model: DictationModelOption): string {
  return `Download failed, ${model.displayName}`;
}

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
    await expect(page.getByTestId('dictation-live-model-line-value')).toHaveText(readyText(NEMOTRON_STREAMING));
    // Not on disk and no download reported yet: queued, its size shown muted.
    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText(readyText(PARAKEET_V3));
    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveClass(/text-fg-muted/);

    // The always-mounted dictation hook subscribes once dictation is on.
    await waitForProgressListener(page);
    await emitModelProgress(page, {
      modelId: PARAKEET_V3.id,
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: 0,
      modelDownloadedBytes: 42,
      modelTotalBytes: 100,
    });
    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText(downloadingText(PARAKEET_V3, 42));
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
    await waitForProgressListener(page);
    const emitDownloading = (modelId: string, share: number) => emitModelProgress(page, {
      modelId, status: 'downloading', downloadedBytes: 0, totalBytes: 0, modelDownloadedBytes: share, modelTotalBytes: 100,
    });

    await emitDownloading(NEMOTRON_STREAMING.id, 50);
    await expect(page.getByTestId('dictation-live-model-line-value')).toHaveText(downloadingText(NEMOTRON_STREAMING, 50));

    // Nemotron is now on disk, which the next getInfo reports; the download
    // moves on to Parakeet v3.
    await page.evaluate((value) => {
      (window as unknown as { __mockDictationInfoOverrides: Record<string, unknown> | null })
        .__mockDictationInfoOverrides = value;
    }, { ...BEST_SELECTION, installedModels: [NEMOTRON_STREAMING.id] });
    await emitDownloading(PARAKEET_V3.id, 10);

    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText(downloadingText(PARAKEET_V3, 10));
    await expect(page.getByTestId('dictation-live-model-line-value')).toHaveText(readyText(NEMOTRON_STREAMING));
    await expect(page.getByTestId('dictation-live-model-line-value').locator('svg')).toHaveCount(1);
  } finally {
    await browser.close();
  }
});

// A download error names the model that failed (`progress.modelId`). Best
// downloads its two models one after the other, so the one still waiting its
// turn is not the one that failed and has to keep reading queued. Before the
// error was matched to its model, every line not yet on disk read "Download
// failed" on any error.
test('a download error names one model: only that line reads Download failed, the other stays queued', async () => {
  const { browser, page } = await launchWithInfo({ ...BEST_SELECTION, installedModels: [] });
  try {
    await openDictationTab(page);
    await waitForProgressListener(page);
    const refinementLine = page.getByTestId('dictation-refinement-model-line');
    const refinementValue = page.getByTestId('dictation-refinement-model-line-value');
    const liveLine = page.getByTestId('dictation-live-model-line');
    const liveValue = page.getByTestId('dictation-live-model-line-value');

    await emitModelProgress(page, {
      modelId: PARAKEET_V3.id,
      status: 'error',
      downloadedBytes: 0,
      totalBytes: 0,
      error: 'No space left on device',
    });

    // The refinement model failed: the warning word before its name, and the
    // reason in the line's info tip (a line holds one short value).
    await expect(refinementValue).toHaveText(failedText(PARAKEET_V3));
    await expect(refinementValue.locator('.text-warning')).toHaveText('Download failed');
    await expect(refinementLine.getByRole('button', { name: 'About Refinement model: No space left on device' }))
      .toHaveAttribute('title', 'No space left on device');

    // The live model did not: still queued, its name and size muted, no warning.
    await expect(liveValue).toHaveText(readyText(NEMOTRON_STREAMING));
    await expect(liveValue).toHaveClass(/text-fg-muted/);
    await expect(liveLine).not.toContainText('Download failed');
    await expect(liveLine.locator('svg.text-warning')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('an error naming the live model leaves the refinement line queued', async () => {
  const { browser, page } = await launchWithInfo({ ...BEST_SELECTION, installedModels: [] });
  try {
    await openDictationTab(page);
    await waitForProgressListener(page);
    const refinementLine = page.getByTestId('dictation-refinement-model-line');
    const refinementValue = page.getByTestId('dictation-refinement-model-line-value');
    const liveLine = page.getByTestId('dictation-live-model-line');
    const liveValue = page.getByTestId('dictation-live-model-line-value');

    await emitModelProgress(page, {
      modelId: NEMOTRON_STREAMING.id,
      status: 'error',
      downloadedBytes: 0,
      totalBytes: 0,
      error: 'Network unreachable',
    });

    await expect(liveValue).toHaveText(failedText(NEMOTRON_STREAMING));
    await expect(liveValue.locator('.text-warning')).toHaveText('Download failed');
    await expect(liveLine.getByRole('button', { name: 'About Live model: Network unreachable' }))
      .toHaveAttribute('title', 'Network unreachable');

    await expect(refinementValue).toHaveText(readyText(PARAKEET_V3));
    await expect(refinementValue).toHaveClass(/text-fg-muted/);
    await expect(refinementLine).not.toContainText('Download failed');
    await expect(refinementLine.locator('svg.text-warning')).toHaveCount(0);
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

// A cloud refinement is the Refinement dropdown's "Cloud endpoint" choice, which saves
// engineMode 'remote'. The tab itself decides what that reads as: the refinement line
// says Cloud endpoint and the License line drops the refinement slot, because the
// cloud runs no on-device model. The fixture keeps `selectedFinalModelId` set to
// Parakeet v3 on purpose. Real main reports null for the final under cloud, but then
// reverting the tab's handling would still read None and still list only the live
// license, and this test could not fail. A non-null final is what proves the tab, not
// main, is dropping it.
test('a cloud refinement reads Cloud endpoint and the License line names only the live model\'s', async () => {
  const { browser, page } = await launchWithInfo(BEST_SELECTION);
  try {
    await seedDictation(page, {
      enabled: true, mode: 'custom', engineMode: 'remote', liveModelId: NEMOTRON_STREAMING.id,
    });
    await openDictationTab(page);
    // The premise: the tab is really in the cloud shape.
    await expect(page.getByTestId('dictation-final-model-select')).toHaveValue('cloud');
    await expect(page.getByTestId('dictation-cloud-fields')).toBeVisible();

    await expect(page.getByTestId('dictation-refinement-model-line-value')).toHaveText('Cloud endpoint');
    await expect(page.getByTestId('dictation-license-link')).toHaveText(['NVIDIA Open Model License']);
    await expect(page.getByTestId('dictation-license')).not.toContainText('CC-BY-4.0');
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

/** An English-only refinement model (Parakeet v2), so a Custom config can name a
 *  refinement model that does not cover German. Read from the registry like the
 *  two above. */
const PARAKEET_ENGLISH = registryModel('parakeet-tdt-0.6b-en');

/** Two live models (one English only, one multilingual) and two refinement
 *  models (one English only, one multilingual), so every Custom case below can
 *  seed a model that covers German and one that does not. */
const LANGUAGE_SELECTION = {
  liveModels: [NEMOTRON_STREAMING, PARAKEET_V3],
  finalModels: [PARAKEET_V3, PARAKEET_ENGLISH],
  selectedLiveModelId: NEMOTRON_STREAMING.id,
  selectedFinalModelId: PARAKEET_V3.id,
};

/** Write the dictation block through the config store, the way the settings
 *  panel persists it (config.set, then a refresh of the global and effective
 *  config). Seeds a starting state the Mode and model controls then read. */
async function seedDictation(page: Page, dictation: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (value) => {
    const stores = (window as unknown as {
      __zustandStores: { config: { getState: () => { updateConfig: (partial: Record<string, unknown>) => Promise<unknown> } } };
    }).__zustandStores;
    await stores.config.getState().updateConfig({ dictation: value });
  }, dictation);
}

/** What the mock persisted for the dictation block (the saved GLOBAL config, read
 *  back through the bridge, not the renderer's copy). An unset field reads null. */
async function savedDictation(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const saved = await window.electronAPI.config.getGlobal();
    const dictation = saved.dictation ?? {};
    return {
      language: dictation.language ?? null,
      mode: dictation.mode ?? null,
      engineMode: dictation.engineMode ?? null,
      liveModelId: dictation.liveModelId ?? null,
      modelId: dictation.modelId ?? null,
    };
  });
}

// Picking a language in a preset mode saves the language and NO model ids: main
// resolves the preset for the new language each session. Before, the tab wrote
// the preset's ids for that language, which pinned them into the config.
const PRESET_LANGUAGE_CASES = [
  { preset: 'accurate', label: 'Best' },
  { preset: 'balanced', label: 'Balanced' },
  { preset: 'fast', label: 'Light' },
] as const;

for (const { preset, label } of PRESET_LANGUAGE_CASES) {
  test(`${label} mode: picking a language saves the language and no model ids`, async () => {
    const { browser, page } = await launchWithInfo(LANGUAGE_SELECTION);
    try {
      // Starts as it would after a preset pick: the mode saved, no model ids.
      await seedDictation(page, { enabled: true, mode: preset });
      await openDictationTab(page);
      await expect(page.getByTestId(`dictation-preset-${preset}`)).toHaveAttribute('aria-checked', 'true');

      await page.getByTestId('dictation-language-select').selectOption('de');

      await expect
        .poll(() => savedDictation(page))
        .toEqual({ language: 'de', mode: preset, engineMode: 'auto', liveModelId: null, modelId: null });
      // The mode is untouched, so the preset still reads as selected.
      await expect(page.getByTestId(`dictation-preset-${preset}`)).toHaveAttribute('aria-checked', 'true');
    } finally {
      await browser.close();
    }
  });
}

// Custom keeps its models when they already cover the new language, so a language
// change does not throw away a pick the user made on purpose.
test('Custom mode: picking a language both models cover saves only the language and keeps the models', async () => {
  const { browser, page } = await launchWithInfo(LANGUAGE_SELECTION);
  try {
    // Parakeet v3 covers German and an empty refinement slot covers everything.
    await seedDictation(page, { enabled: true, mode: 'custom', liveModelId: PARAKEET_V3.id, modelId: 'none' });
    await openDictationTab(page);
    await expect(page.getByTestId('dictation-live-model-select')).toHaveValue(PARAKEET_V3.id);
    await expect(page.getByTestId('dictation-final-model-select')).toHaveValue('none');

    await page.getByTestId('dictation-language-select').selectOption('de');

    // engineMode stays unset: only the language was written.
    await expect
      .poll(() => savedDictation(page))
      .toEqual({ language: 'de', mode: 'custom', engineMode: null, liveModelId: PARAKEET_V3.id, modelId: 'none' });
  } finally {
    await browser.close();
  }
});

test('Custom mode: a cloud refinement survives a language change the live model covers', async () => {
  const { browser, page } = await launchWithInfo(LANGUAGE_SELECTION);
  try {
    await seedDictation(page, { enabled: true, mode: 'custom', engineMode: 'remote', liveModelId: PARAKEET_V3.id });
    await openDictationTab(page);
    await expect(page.getByTestId('dictation-live-model-select')).toHaveValue(PARAKEET_V3.id);
    await expect(page.getByTestId('dictation-final-model-select')).toHaveValue('cloud');

    await page.getByTestId('dictation-language-select').selectOption('de');

    // A cloud refinement covers any language, so it is kept, not reset to auto.
    await expect
      .poll(() => savedDictation(page))
      .toEqual({ language: 'de', mode: 'custom', engineMode: 'remote', liveModelId: PARAKEET_V3.id, modelId: null });
  } finally {
    await browser.close();
  }
});

// A model that cannot transcribe the new language sends Custom to the Light
// preset's models for that language (Whisper base multilingual, no refinement),
// on the machine rather than the cloud, so the config never names a model that
// cannot run the language.
const LIGHT_GERMAN_FALLBACK = {
  language: 'de',
  mode: 'custom',
  engineMode: 'auto',
  liveModelId: 'whisper-base-multi',
  modelId: 'none',
};

test('Custom mode: a live model that does not cover the language falls back to the Light models', async () => {
  const { browser, page } = await launchWithInfo(LANGUAGE_SELECTION);
  try {
    // Nemotron streaming is English only. The cloud refinement is on, so the
    // fallback also has to put the engine back on the machine.
    await seedDictation(page, {
      enabled: true, mode: 'custom', engineMode: 'remote', liveModelId: NEMOTRON_STREAMING.id, modelId: PARAKEET_V3.id,
    });
    await openDictationTab(page);
    await expect(page.getByTestId('dictation-live-model-select')).toHaveValue(NEMOTRON_STREAMING.id);

    await page.getByTestId('dictation-language-select').selectOption('de');

    await expect.poll(() => savedDictation(page)).toEqual(LIGHT_GERMAN_FALLBACK);
  } finally {
    await browser.close();
  }
});

test('Custom mode: a refinement model that does not cover the language falls back to the Light models', async () => {
  const { browser, page } = await launchWithInfo(LANGUAGE_SELECTION);
  try {
    // The live model covers German; only the English-only refinement model does not.
    await seedDictation(page, {
      enabled: true, mode: 'custom', liveModelId: PARAKEET_V3.id, modelId: PARAKEET_ENGLISH.id,
    });
    await openDictationTab(page);
    await expect(page.getByTestId('dictation-live-model-select')).toHaveValue(PARAKEET_V3.id);
    await expect(page.getByTestId('dictation-final-model-select')).toHaveValue(PARAKEET_ENGLISH.id);

    await page.getByTestId('dictation-language-select').selectOption('de');

    await expect.poll(() => savedDictation(page)).toEqual(LIGHT_GERMAN_FALLBACK);
  } finally {
    await browser.close();
  }
});

/** The last non-null payload `dictation.prewarm` received. The hook also calls
 *  prewarm(null) while dictation is off, which is not a warm request. */
async function lastWarmedConfig(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const calls = (window.electronAPI.dictation as unknown as {
      __prewarmCalls: Array<Record<string, unknown> | null>;
    }).__prewarmCalls;
    const requests = calls.filter((call) => call !== null);
    return requests.length > 0 ? requests[requests.length - 1] : null;
  });
}

// Main resolves a Balanced or Light user's models from the saved Mode. If the
// renderer stopped sending it, main would fall back to the machine's default
// preset for them.
test('the saved Mode rides the prewarm request once dictation is on', async () => {
  const { browser, page } = await launchWithInfo(BEST_SELECTION);
  try {
    await seedDictation(page, { enabled: true, mode: 'balanced' });
    // The warm-up is debounced, so it arrives a moment after the config lands.
    await expect
      .poll(() => lastWarmedConfig(page))
      .toMatchObject({ mode: 'balanced', engineMode: 'auto', language: 'en' });
  } finally {
    await browser.close();
  }
});

test('changing the saved Mode warms the engine again with the new Mode', async () => {
  const { browser, page } = await launchWithInfo(BEST_SELECTION);
  try {
    await seedDictation(page, { enabled: true, mode: 'balanced' });
    await expect.poll(() => lastWarmedConfig(page)).toMatchObject({ mode: 'balanced' });

    await seedDictation(page, { mode: 'fast' });
    await expect.poll(() => lastWarmedConfig(page)).toMatchObject({ mode: 'fast' });
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
  const { browser, page } = await launchWithInfo({
    liveModels: REGISTRY_CATALOGUE.liveModels,
    finalModels: REGISTRY_CATALOGUE.finalModels,
    selectedLiveModelId: REGISTRY_CATALOGUE.selectedLiveModelId,
    selectedFinalModelId: REGISTRY_CATALOGUE.selectedFinalModelId,
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

/** One dropdown option as the browser holds it: the model id it saves and the text it shows. */
interface SelectOption {
  value: string;
  text: string;
}

async function selectOptions(page: Page, testId: string): Promise<SelectOption[]> {
  const select = page.getByTestId(testId);
  await expect(select).toBeVisible();
  return select.evaluate((element) =>
    Array.from((element as HTMLSelectElement).options).map((option) => ({ value: option.value, text: option.text })),
  );
}

/** The same models, least accurate first: the reverse of the order the tab must show.
 *  Feeding the tab this order is what makes its sort observable, since a tab that
 *  stopped sorting would show it as given. */
function leastAccurateFirst(models: DictationModelOption[]): DictationModelOption[] {
  return [...models].sort((first, second) => first.accuracyRank - second.accuracyRank);
}

// Custom opens both dropdowns. Each lists its slot's models most accurate first (the
// sort lives in the tab, not in the lists main sends), then the empty choice (and, for
// Refinement, the cloud one). Each model reads as its name, how accurate it is, and
// its download size.
test('Custom lists each dropdown\'s models most accurate first, each as "name - accuracy (N MB)"', async () => {
  const liveModels = leastAccurateFirst(REGISTRY_CATALOGUE.liveModels);
  const finalModels = leastAccurateFirst(REGISTRY_CATALOGUE.finalModels);
  const { browser, page } = await launchWithInfo({
    liveModels,
    finalModels,
    selectedLiveModelId: NEMOTRON_STREAMING.id,
    selectedFinalModelId: PARAKEET_V3.id,
  });
  try {
    // English is the default language and lists every model, so nothing is filtered out.
    await seedDictation(page, { enabled: true, mode: 'custom' });
    await openDictationTab(page);

    const slots = [
      { testId: 'dictation-live-model-select', models: liveModels, example: NEMOTRON_STREAMING },
      { testId: 'dictation-final-model-select', models: finalModels, example: PARAKEET_V3 },
    ];
    for (const { testId, models, example } of slots) {
      const rankById = new Map(models.map((model) => [model.id, model.accuracyRank]));
      // The Select also holds None (and Cloud endpoint), which are not models.
      const modelOptions = (await selectOptions(page, testId)).filter((option) => rankById.has(option.value));

      // Every model of the slot is listed, so the order check below has the whole list to judge.
      expect(modelOptions.map((option) => option.value).sort(), testId)
        .toEqual(models.map((model) => model.id).sort());
      // The fixture really holds more than one rank, or any order would pass.
      expect(new Set(rankById.values()).size, testId).toBeGreaterThan(1);

      // Non-increasing rather than an exact sequence: models of one rank may sit in either order.
      const ranks = modelOptions.map((option) => rankById.get(option.value) ?? Number.NaN);
      for (let index = 1; index < ranks.length; index++) {
        expect(ranks[index], `${testId}: ${modelOptions[index].text} after ${modelOptions[index - 1].text}`)
          .toBeLessThanOrEqual(ranks[index - 1]);
      }

      // The separators are written out here on purpose; the pieces come from the model.
      const shown = modelOptions.find((option) => option.value === example.id);
      expect(shown?.text, testId)
        .toBe(`${example.displayName} - ${example.accuracyLabel} (${example.sizeMb} MB)`);
    }
  } finally {
    await browser.close();
  }
});
