import { describe, it, expect, vi } from 'vitest';
import type { DictationHardwareProfile, DictationConfig } from '../../src/shared/types';

// detect-hardware.ts imports `app` from electron for GPU detection. Mock so
// the module loads cleanly; `selectTier` itself is pure and reads only the
// profile object, so the mock has no effect on the function under test.
vi.mock('electron', () => ({
  app: { getGPUInfo: vi.fn(async () => ({ gpuDevice: [] })) },
}));

// engine-selection.ts is the main-resident half of the engine-registry
// split (see DESKTOP-X / .claude/rules/dictation-out-of-process.md): it maps
// a config to a serializable EngineSelection and never imports
// sherpa-onnx-node, so unlike its predecessor this test needs no native-addon
// stub at all.

import { computeEngineKey, listEngineInfos, selectEngine } from '../../src/main/transcription/engines/engine-selection';

function makeProfile(overrides: Partial<DictationHardwareProfile> = {}): DictationHardwareProfile {
  return {
    cpuModel: 'Test CPU 8-Core',
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

describe('selectEngine - remote mode', () => {
  it('engineMode remote -> id is remote-openai', () => {
    const result = selectEngine(
      makeProfile(),
      makeConfig({ engineMode: 'remote' }),
    );
    expect(result.id).toBe('remote-openai');
  });

  it('remote mode: finalModelId is null (cloud handles the accurate pass)', () => {
    const result = selectEngine(
      makeProfile(),
      makeConfig({ engineMode: 'remote' }),
    );
    expect(result.finalModelId).toBeNull();
  });

  it('remote mode: live model slot is kept (streaming Zipformer is the default live model)', () => {
    // Cloud path keeps a local live preview via the streaming Zipformer.
    // The live slot must not be null on the default remote config.
    const result = selectEngine(
      makeProfile(),
      makeConfig({ engineMode: 'remote' }),
    );
    expect(result.liveModelId).toBe('streaming-zipformer-en');
  });

  it('remote mode: isRemote is true, which engine-build.ts routes to RemoteOpenAiEngine', () => {
    const result = selectEngine(
      makeProfile(),
      makeConfig({ engineMode: 'remote' }),
    );
    expect(result.isRemote).toBe(true);
  });
});

describe('selectEngine - on-device (auto) mode', () => {
  it('auto mode on a capable machine -> id is hybrid', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig(),
    );
    expect(result.id).toBe('hybrid');
  });

  it('auto mode: isRemote is false', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig(),
    );
    expect(result.isRemote).toBe(false);
  });

  it('capable machine default: live slot is streaming-zipformer-en, kind online-transducer', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig(),
    );
    expect(result.liveModelId).toBe('streaming-zipformer-en');
    // engine-build.ts routes purely off this field - no ModelDef ever
    // crosses the process boundary - so a drift here silently mis-routes
    // the worker's live-slot construction.
    expect(result.liveModelKind).toBe('online-transducer');
  });

  it('capable machine default (accurate-base tier): final model is parakeet-tdt-0.6b-en', () => {
    // The accurate-base tier default is the first MODELS entry of that tier,
    // which is Parakeet TDT 0.6B - the leaderboard-topping English model.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig(),
    );
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-en');
  });

  it('a chunked (offline) live model reports its own engineKind, not the transducer one', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ liveModelId: 'moonshine-tiny-en' }),
    );
    expect(result.liveModelId).toBe('moonshine-tiny-en');
    expect(result.liveModelKind).toBe('offline-moonshine');
  });

  it('no live slot: liveModelKind is null alongside liveModelId', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ liveModelId: 'none' }),
    );
    expect(result.liveModelId).toBeNull();
    expect(result.liveModelKind).toBeNull();
  });
});

describe('selectEngine - on-device slot guard (at least one slot always active)', () => {
  it('liveModelId none on streaming-tiny tier: guard populates final from accurateDefault', () => {
    // On a weak machine (2 cores -> streaming-tiny tier), finalModelFor returns
    // null because the streaming-tiny tier does not auto-pick an accurate model.
    // With live also disabled, BOTH slots would be null. The guard kicks in and
    // sets final = accurateDefault() = Parakeet so on-device always has a slot.
    const result = selectEngine(
      makeProfile({ cpuCores: 2, totalRamGb: 8, gpu: 'none' }),
      makeConfig({ liveModelId: 'none' }),
    );
    expect(result.id).toBe('hybrid');
    expect(result.liveModelId).toBeNull();
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-en');
  });

  it('both slots explicitly none: guard sets finalModelId to accurateDefault', () => {
    // This case tests the guard directly: both modelId and liveModelId are
    // 'none'. The guard must fire regardless of machine tier.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ liveModelId: 'none', modelId: 'none' }),
    );
    expect(result.liveModelId).toBeNull();
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-en');
  });
});

describe('selectEngine - language clamp (resolveLanguage)', () => {
  it('fr with English-only live and final models clamps to en', () => {
    // Both the streaming Zipformer (live default) and Parakeet (final default)
    // are English-only. A stale config language of "fr" is not in the
    // intersection, so it must be clamped to "en".
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ language: 'fr' }),
    );
    expect(result.language).toBe('en');
  });

  it('fr with a multilingual live model and no final: passes the language through', () => {
    // whisper-base-multi declares MULTILINGUAL_LANGUAGE_CODES which includes
    // "fr". With final disabled (modelId: "none"), the intersection of the
    // active slots is whisper-base-multi's language set, which contains "fr".
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ language: 'fr', liveModelId: 'whisper-base-multi', modelId: 'none' }),
    );
    expect(result.language).toBe('fr');
  });

  it('pt with a multilingual live model passes through (another supported language)', () => {
    // Portuguese is also in MULTILINGUAL_LANGUAGE_CODES.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ language: 'pt', liveModelId: 'whisper-base-multi', modelId: 'none' }),
    );
    expect(result.language).toBe('pt');
  });

  it('absent language config defaults to en', () => {
    const result = selectEngine(makeProfile(), makeConfig());
    expect(result.language).toBe('en');
  });

  it('unsupported language code clamps to en even with a multilingual live model', () => {
    // A code that is not in any model's language set (e.g. a stale/unknown
    // BCP-47 tag) must always clamp to 'en'. whisper-base-multi supports the
    // curated set but 'xyz' is not in it.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ language: 'xyz', liveModelId: 'whisper-base-multi', modelId: 'none' }),
    );
    expect(result.language).toBe('en');
  });

  it('multilingual final + English-only live clamps to en (live constrains the intersection)', () => {
    // The live model is the streaming Zipformer (English-only). Even though the
    // final model (whisper-small-multi) supports 'fr', the intersection of both
    // active slots is ['en'] only, so 'fr' is clamped. This guards a regression
    // where resolveLanguage might ignore the live model's constraint.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ language: 'fr', modelId: 'whisper-small-multi' }),
    );
    expect(result.language).toBe('en');
  });

  it('multilingual final + no live slot: language passes through', () => {
    // With no live model (liveModelId: 'none') and a multilingual final
    // (whisper-small-multi), the only active slot supports 'fr', so it passes.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ language: 'fr', liveModelId: 'none', modelId: 'whisper-small-multi' }),
    );
    expect(result.language).toBe('fr');
  });

  it('remote mode: final modelId is excluded from language resolution - multilingual live passes fr', () => {
    // In remote mode, resolveLanguage only considers the live slot (the code
    // passes `isRemote ? null : final`). Even if modelId points to an
    // English-only model (parakeet), the remote path ignores it for language
    // resolution, so 'fr' passes through via the multilingual live model.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({
        engineMode: 'remote',
        language: 'fr',
        liveModelId: 'whisper-base-multi',
        modelId: 'parakeet-tdt-0.6b-en',
      }),
    );
    expect(result.language).toBe('fr');
  });
});

describe('listEngineInfos - user-facing engine catalogue for the settings panel', () => {
  // The six DictationEngineInfo constants moved out of their engine files
  // (each used to declare its own alongside its sherpa-onnx-node import) and
  // into engine-infos.ts, a pure-data file with no engine construction. That
  // hoist has no assertion anywhere: transcription-service tests mock
  // listEngineInfos() away entirely, and engine-selection.test.ts never
  // called it before. This pins what the settings panel actually gets back.

  it('returns exactly the four user-selectable engines, excluding the internal stub', () => {
    const ids = listEngineInfos().map((info) => info.id);
    expect(ids).toEqual(['hybrid', 'whisper-cpp', 'sherpa-onnx', 'remote-openai']);
  });

  it('excludes the stub engine (test-only, never user-selectable)', () => {
    const ids = listEngineInfos().map((info) => info.id);
    expect(ids).not.toContain('stub');
  });

  it('excludes chunked-offline (an internal live-model choice, not a standalone selectable engine)', () => {
    const ids = listEngineInfos().map((info) => info.id);
    expect(ids).not.toContain('chunked-offline');
  });
});

describe('computeEngineKey - the warm-engine LRU cache key', () => {
  it('discriminates which slot carries the model: live=<model>/final=none differs from live=none/final=<that model>', () => {
    // The function's own comment calls this out: both selections dedupe to the
    // SAME single-model set, so a key built off the deduped model set alone
    // would collide them into one cache entry even though they are different
    // engines (a live-only streaming pass vs a final-only accurate pass).
    const profile = makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' });
    const liveOnlyConfig = makeConfig({ liveModelId: 'moonshine-tiny-en', modelId: 'none' });
    const finalOnlyConfig = makeConfig({ liveModelId: 'none', modelId: 'moonshine-tiny-en' });
    const liveOnly = selectEngine(profile, liveOnlyConfig);
    const finalOnly = selectEngine(profile, finalOnlyConfig);

    // Confirm the premise: both selections carry the same one model, in
    // different slots.
    expect(liveOnly.liveModelId).toBe('moonshine-tiny-en');
    expect(liveOnly.finalModelId).toBeNull();
    expect(finalOnly.liveModelId).toBeNull();
    expect(finalOnly.finalModelId).toBe('moonshine-tiny-en');

    const liveOnlyKey = computeEngineKey(liveOnly, liveOnlyConfig);
    const finalOnlyKey = computeEngineKey(finalOnly, finalOnlyConfig);

    expect(liveOnlyKey).not.toBe(finalOnlyKey);
  });

  it('is stable: two calls with an identical selection + config produce the same key', () => {
    const profile = makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' });
    const config = makeConfig({ liveModelId: 'moonshine-tiny-en', modelId: 'none' });
    const selectionOne = selectEngine(profile, config);
    const selectionTwo = selectEngine(profile, config);

    expect(computeEngineKey(selectionOne, config)).toBe(computeEngineKey(selectionTwo, config));
  });

  it('a different remote endpoint changes the key even when the resolved selection is otherwise identical', () => {
    // The Whisper-baked-in-language comment on the source also calls out
    // config.remote (url/apiKey/model) as a direct input to the key, read
    // straight off config rather than derived through EngineSelection.
    const profile = makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' });
    const configA = makeConfig({
      engineMode: 'remote',
      remote: { url: 'https://api.example.com/a', apiKey: 'key', model: 'gpt' },
    });
    const configB = makeConfig({
      engineMode: 'remote',
      remote: { url: 'https://api.example.com/b', apiKey: 'key', model: 'gpt' },
    });
    const selectionA = selectEngine(profile, configA);
    const selectionB = selectEngine(profile, configB);

    expect(computeEngineKey(selectionA, configA)).not.toBe(computeEngineKey(selectionB, configB));
  });
});
