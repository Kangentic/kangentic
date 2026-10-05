import { describe, it, expect } from 'vitest';
import type { DictationConfig, DictationHardwareProfile } from '../../src/shared/types';
import { buildDictationInfo, primaryModel } from '../../src/main/transcription/dictation-info';
import { getModel, type ModelDef } from '../../src/main/transcription/models/model-registry';

/**
 * `dictation-info.ts` is the pure half of `TranscriptionService.getInfo`, moved out so the web
 * demo's sample install can build a real `dictation.getInfo` answer from main's own code
 * (tests/captures/helpers/demo-dataset.ts, pinned by tests/unit/demo-dictation-info.test.ts). That
 * test exercises exactly one machine (the accurate-base sample install, default config, both
 * models installed), so it never reaches: a streaming-tiny machine (no refinement model at all -
 * the doc comment on `primaryModel` calls this out by name), the `selectedModelSizeMb` sum over
 * two models vs the null-when-empty case, or `primaryModel`'s own fallback order. This file pins
 * those branches directly, against the function's own contract (its doc comments and
 * engine-selection.ts's EngineSelection shape), not against a captured run of the code.
 *
 * No electron mock needed: unlike detect-hardware.ts, this module's whole import chain
 * (select-tier.ts, engine-selection.ts, model-registry.ts, engine-infos.ts) is pure data and
 * arithmetic.
 */

function makeProfile(overrides: Partial<DictationHardwareProfile> = {}): DictationHardwareProfile {
  return {
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalRamGb: 16,
    hasAvx2: false,
    gpu: 'none',
    platform: 'linux',
    arch: 'x64',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DictationConfig> = {}): DictationConfig {
  return { ...overrides };
}

describe('buildDictationInfo - streaming-tiny tier (weak machine)', () => {
  const profile = makeProfile({ cpuCores: 1, totalRamGb: 2, gpu: 'none' });
  const info = buildDictationInfo(profile, makeConfig(), []);

  it('resolves to the streaming-tiny tier', () => {
    expect(info.tier).toBe('streaming-tiny');
  });

  it('selects no refinement (final) model - the tier default is not accurate-base', () => {
    // A weak machine's default preset is Light (TIER_DEFAULT_PRESET), which has no
    // refinement model at all.
    expect(info.selectedFinalModelId).toBeNull();
  });

  it('primaryModel falls back to the only model (the live streaming Zipformer), not the offline one', () => {
    // No offline model was selected on this tier, so selectedModelId must be the live model,
    // not null - a machine on this tier still has something to report as "the model".
    expect(info.selectedModelId).toBe('streaming-zipformer-en');
    expect(info.selectedLiveModelId).toBe('streaming-zipformer-en');
  });

  it('selectedModelSizeMb is the single live model size (70 MB), not a sum of two', () => {
    expect(info.selectedModelSizeMb).toBe(70);
  });
});

describe('buildDictationInfo - accurate-base tier (capable machine)', () => {
  const profile = makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' });
  const info = buildDictationInfo(profile, makeConfig(), []);

  it('resolves to the accurate-base tier and selects both a live and a final model', () => {
    expect(info.tier).toBe('accurate-base');
    expect(info.selectedLiveModelId).toBe('nemotron-streaming-0.6b-en');
    expect(info.selectedFinalModelId).toBe('parakeet-tdt-0.6b-v3');
  });

  it('primaryModel prefers the offline (final) model over the live one', () => {
    expect(info.selectedModelId).toBe('parakeet-tdt-0.6b-v3');
  });

  it('selectedModelSizeMb sums BOTH selected models (631 + 639), not just one', () => {
    expect(info.selectedModelSizeMb).toBe(1270);
  });
});

describe('buildDictationInfo - no models selected', () => {
  it('remote mode with an explicit no-live-preview override selects zero models: size is null, id is null', () => {
    const profile = makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' });
    const info = buildDictationInfo(profile, makeConfig({ engineMode: 'remote', liveModelId: 'none' }), []);
    expect(info.selectedModelId).toBeNull();
    expect(info.selectedModelSizeMb).toBeNull();
  });
});

describe('buildDictationInfo - pass-through fields', () => {
  it('carries the given hardware profile and installed-models list through unchanged', () => {
    const profile = makeProfile({ cpuModel: 'A Named CPU', cpuCores: 6, totalRamGb: 12 });
    const installed = ['streaming-zipformer-en', 'whisper-tiny-en'];
    const info = buildDictationInfo(profile, makeConfig(), installed);
    expect(info.hardware).toEqual(profile);
    expect(info.installedModels).toEqual(installed);
  });

  it('availableModels and finalModels both list every offline model, independent of the current selection', () => {
    // These two catalogue lists are always the full set (finalCapableModels()), not filtered to
    // what this machine/config selected - the two-stage dropdowns need the whole catalogue to
    // offer a different choice.
    const info = buildDictationInfo(makeProfile({ cpuCores: 1, totalRamGb: 2 }), makeConfig(), []);
    expect(info.availableModels).toEqual(info.finalModels);
    expect(info.availableModels.length).toBeGreaterThan(1);
    expect(info.availableModels.map((model) => model.id)).toContain('parakeet-tdt-0.6b-en');
  });
});

describe('buildDictationInfo - model options carry accuracy and license from the registry', () => {
  // The Dictation tab sorts its dropdowns on accuracyRank, prints accuracyLabel after
  // each name, and shows the license. All three come from the registry entry, so each
  // option must match the entry it was built from, in both dropdown lists.
  const info = buildDictationInfo(makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }), makeConfig(), []);

  it('every live and final option carries the accuracy rank, accuracy label and license of its registry entry', () => {
    expect(info.liveModels.length).toBeGreaterThan(1);
    expect(info.finalModels.length).toBeGreaterThan(1);

    for (const option of [...info.liveModels, ...info.finalModels]) {
      const registryEntry = getModel(option.id);
      expect(registryEntry, `${option.id} is in the registry`).toBeDefined();
      expect(option.accuracyRank, `${option.id} accuracyRank`).toBe(registryEntry?.accuracy.rank);
      expect(option.accuracyLabel, `${option.id} accuracyLabel`).toBe(registryEntry?.accuracy.label);
      expect(option.license, `${option.id} license`).toBe(registryEntry?.license);
    }
  });

  // One literal pin, so a registry entry and its option cannot drift together
  // unnoticed: Parakeet v3 is in both lists, as the model Best refines with and
  // the one Balanced runs alone.
  it('Parakeet v3 is High accuracy (rank 6) under CC-BY-4.0, in both the live and the final list', () => {
    for (const options of [info.liveModels, info.finalModels]) {
      const parakeetV3 = options.find((option) => option.id === 'parakeet-tdt-0.6b-v3');
      expect(parakeetV3).toMatchObject({ accuracyRank: 6, accuracyLabel: 'High accuracy', license: 'CC-BY-4.0' });
    }
  });
});

describe('primaryModel', () => {
  const live: ModelDef = {
    id: 'live-model',
    engineKind: 'online-transducer',
    displayName: 'Live',
    license: 'Apache-2.0',
    accuracy: { rank: 1, label: 'Basic accuracy' },
    approxSizeMb: 10,
    files: [],
    roles: {},
  };
  const offline: ModelDef = {
    id: 'offline-model',
    engineKind: 'offline-whisper',
    displayName: 'Offline',
    license: 'MIT',
    accuracy: { rank: 1, label: 'Basic accuracy' },
    approxSizeMb: 20,
    files: [],
    roles: {},
  };

  it('picks the offline model when the set has one, regardless of position', () => {
    expect(primaryModel([live, offline])?.id).toBe('offline-model');
    expect(primaryModel([offline, live])?.id).toBe('offline-model');
  });

  it('falls back to the first model when no offline model is present', () => {
    expect(primaryModel([live])?.id).toBe('live-model');
  });

  it('returns undefined for an empty set', () => {
    expect(primaryModel([])).toBeUndefined();
  });
});
