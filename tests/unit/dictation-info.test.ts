import { describe, it, expect } from 'vitest';
import type { DictationConfig, DictationHardwareProfile } from '../../src/shared/types';
import { buildDictationInfo, primaryModel } from '../../src/main/transcription/dictation-info';
import type { ModelDef } from '../../src/main/transcription/models/model-registry';

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
    // engine-selection.ts's finalModelFor: an absent modelId only auto-picks an accurate model
    // on the accurate-base tier; streaming-tiny gets no final model at all.
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
    expect(info.selectedLiveModelId).toBe('streaming-zipformer-en');
    expect(info.selectedFinalModelId).toBe('parakeet-tdt-0.6b-en');
  });

  it('primaryModel prefers the offline (final) model over the live one', () => {
    expect(info.selectedModelId).toBe('parakeet-tdt-0.6b-en');
  });

  it('selectedModelSizeMb sums BOTH selected models (70 + 660), not just one', () => {
    expect(info.selectedModelSizeMb).toBe(730);
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

describe('primaryModel', () => {
  const live: ModelDef = {
    id: 'live-model',
    engineKind: 'online-transducer',
    displayName: 'Live',
    license: 'Apache-2.0',
    tier: 'streaming-tiny',
    approxSizeMb: 10,
    files: [],
    roles: {},
  };
  const offline: ModelDef = {
    id: 'offline-model',
    engineKind: 'offline-whisper',
    displayName: 'Offline',
    license: 'MIT',
    tier: 'accurate-base',
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
