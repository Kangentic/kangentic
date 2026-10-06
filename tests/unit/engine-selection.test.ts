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

import { computeEngineKey, finalNeedsSentenceCase, listEngineInfos, selectEngine } from '../../src/main/transcription/engines/engine-selection';

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

  it('remote mode: live model slot is kept (the live model of the default preset)', () => {
    // Cloud path keeps a local live preview: on a capable machine the Best
    // preset's Nemotron. The live slot must not be null on the default remote config.
    const result = selectEngine(
      makeProfile(),
      makeConfig({ engineMode: 'remote' }),
    );
    expect(result.liveModelId).toBe('nemotron-streaming-0.6b-en');
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

  it('capable machine default: live slot is Nemotron streaming, kind online-transducer', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig(),
    );
    expect(result.liveModelId).toBe('nemotron-streaming-0.6b-en');
    // engine-build.ts routes purely off this field - no ModelDef ever
    // crosses the process boundary - so a drift here silently mis-routes
    // the worker's live-slot construction.
    expect(result.liveModelKind).toBe('online-transducer');
  });

  it('capable machine default (accurate-base tier): final model is Parakeet v3', () => {
    // A capable machine gets the Best preset (TIER_DEFAULT_PRESET), whose
    // refinement pass is Parakeet v3.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig(),
    );
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-v3');
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

  it('a legacy config with only a refinement model keeps the Zipformer live slot on a capable machine, not the default preset\'s Nemotron', () => {
    // No mode, no live model, a refinement model: a config saved before Custom
    // saved both ids. That config ran the Zipformer for the empty live slot, so a
    // capable machine must not hand it the Best preset's 600 MB Nemotron instead.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ modelId: 'parakeet-tdt-0.6b-en' }),
    );
    expect(result.liveModelId).toBe('streaming-zipformer-en');
    expect(result.liveModelKind).toBe('online-transducer');
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-en');
  });
});

describe('selectEngine - a Custom slot naming a model the registry no longer knows', () => {
  // A saved Custom config keeps the ids the user picked. When a release removes one
  // from the registry, the slot must not go empty (which would drop the live preview
  // or the refinement pass without a word): it takes the machine default preset's
  // model for that slot. A capable machine's default preset is Best, and the
  // English language picks Best's English models.
  const capableProfile = makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' });

  it('a removed live model id falls back to the default preset\'s live model (Nemotron), keeping the empty refinement slot empty', () => {
    const result = selectEngine(
      capableProfile,
      makeConfig({ mode: 'custom', language: 'en', liveModelId: 'model-that-was-removed', modelId: 'none' }),
    );
    expect(result.liveModelId).toBe('nemotron-streaming-0.6b-en');
    expect(result.liveModelKind).toBe('online-transducer');
    expect(result.finalModelId).toBeNull();
    expect(result.models.map((model) => model.id)).toEqual(['nemotron-streaming-0.6b-en']);
  });

  // The live slot holds a real model here. With a live slot of 'none' the
  // at-least-one-slot guard would fill the refinement slot with Parakeet v3 whether
  // or not the fallback worked, so the case would prove nothing.
  it('a removed refinement model id falls back to the default preset\'s refinement model (Parakeet v3)', () => {
    const result = selectEngine(
      capableProfile,
      makeConfig({ mode: 'custom', language: 'en', liveModelId: 'streaming-zipformer-en', modelId: 'model-that-was-removed' }),
    );
    expect(result.liveModelId).toBe('streaming-zipformer-en');
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-v3');
    expect(result.models.map((model) => model.id)).toEqual(['streaming-zipformer-en', 'parakeet-tdt-0.6b-v3']);
  });

  // The fallback follows the machine and the language, not "English on a capable
  // machine". Every English capable-machine case above would still pass with either
  // one hardcoded, so these name the other two axes.
  const weakProfile = makeProfile({ cpuCores: 2, totalRamGb: 8, gpu: 'none' });

  it('a removed live model id on a weak machine falls back to the Light preset\'s Zipformer, not Best\'s 600 MB Nemotron', () => {
    const result = selectEngine(
      weakProfile,
      makeConfig({ mode: 'custom', language: 'en', liveModelId: 'model-that-was-removed', modelId: 'none' }),
    );
    expect(result.liveModelId).toBe('streaming-zipformer-en');
    expect(result.finalModelId).toBeNull();
  });

  it('a removed refinement model id on a weak machine stays empty: the Light preset has no refinement model', () => {
    const result = selectEngine(
      weakProfile,
      makeConfig({ mode: 'custom', language: 'en', liveModelId: 'streaming-zipformer-en', modelId: 'model-that-was-removed' }),
    );
    expect(result.liveModelId).toBe('streaming-zipformer-en');
    expect(result.finalModelId).toBeNull();
    expect(result.models.map((model) => model.id)).toEqual(['streaming-zipformer-en']);
  });

  // French has no English-only model to fall back to: the preset's live model for
  // French is Nemotron 3.5, and the English Nemotron would also clamp the language
  // to en.
  it('a removed live model id for French falls back to the default preset\'s French live model (Nemotron 3.5)', () => {
    const result = selectEngine(
      capableProfile,
      makeConfig({ mode: 'custom', language: 'fr', liveModelId: 'model-that-was-removed', modelId: 'none' }),
    );
    expect(result.liveModelId).toBe('nemotron-3.5-streaming-0.6b');
    expect(result.finalModelId).toBeNull();
    expect(result.language).toBe('fr');
  });

  // Parakeet v3 has no Japanese, so the Best preset's refinement model for Japanese is
  // Whisper small. The English pick (Parakeet v3) would also clamp the language to en.
  it('a removed refinement model id for Japanese falls back to the default preset\'s refinement model for Japanese (Whisper small)', () => {
    const result = selectEngine(
      capableProfile,
      makeConfig({ mode: 'custom', language: 'ja', liveModelId: 'whisper-base-multi', modelId: 'model-that-was-removed' }),
    );
    expect(result.liveModelId).toBe('whisper-base-multi');
    expect(result.finalModelId).toBe('whisper-small-multi');
    expect(result.language).toBe('ja');
  });
});

describe('selectEngine - on-device slot guard (at least one slot always active)', () => {
  it('liveModelId none on streaming-tiny tier: guard populates final from accurateDefault', () => {
    // On a weak machine (2 cores -> streaming-tiny tier) the default preset is
    // Light, which has no refinement model. With live also disabled, BOTH slots
    // would be null. The guard kicks in and sets final to the Best preset's
    // refinement model (Parakeet v3) so on-device always has a slot.
    const result = selectEngine(
      makeProfile({ cpuCores: 2, totalRamGb: 8, gpu: 'none' }),
      makeConfig({ liveModelId: 'none' }),
    );
    expect(result.id).toBe('hybrid');
    expect(result.liveModelId).toBeNull();
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-v3');
  });

  it('both slots explicitly none: guard sets finalModelId to accurateDefault', () => {
    // This case tests the guard directly: both modelId and liveModelId are
    // 'none'. The guard must fire regardless of machine tier.
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ liveModelId: 'none', modelId: 'none' }),
    );
    expect(result.liveModelId).toBeNull();
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-v3');
  });

  // Parakeet v3 has no Japanese, so the Best preset refines Japanese with Whisper
  // small. The guard takes the Best preset's refinement model FOR THE LANGUAGE: the
  // English pick would clamp the session's language to en.
  it('both slots none for Japanese: the guard picks the Best refinement model for Japanese (Whisper small)', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ mode: 'custom', language: 'ja', liveModelId: 'none', modelId: 'none' }),
    );
    expect(result.liveModelId).toBeNull();
    expect(result.finalModelId).toBe('whisper-small-multi');
    expect(result.language).toBe('ja');
  });
});

describe('selectEngine - language clamp (resolveLanguage)', () => {
  it('fr with English-only Custom live and final models clamps to en', () => {
    // Both the streaming Zipformer and Parakeet v2 are English-only. A stale
    // config language of "fr" is not in the intersection, so it must be
    // clamped to "en".
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ mode: 'custom', language: 'fr', liveModelId: 'streaming-zipformer-en', modelId: 'parakeet-tdt-0.6b-en' }),
    );
    expect(result.language).toBe('en');
  });

  it('a preset resolves the models of the language, so fr passes through', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ language: 'fr' }),
    );
    expect(result.liveModelId).toBe('nemotron-3.5-streaming-0.6b');
    expect(result.finalModelId).toBe('parakeet-tdt-0.6b-v3');
    expect(result.language).toBe('fr');
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
      makeConfig({ language: 'fr', liveModelId: 'streaming-zipformer-en', modelId: 'whisper-small-multi' }),
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

  // Cohere Transcribe covers twelve of the curated languages, not Russian, Ukrainian
  // or Turkish. As the only active slot (no live model) it alone sets the clamp, so a
  // language it lacks falls back to English and one it has passes through. The pair
  // pins both directions: a Cohere with no declared languages would clamp ja to en, and
  // one stamped with the whole multilingual set would pass ru.
  const COHERE_ONLY = { mode: 'custom', liveModelId: 'none', modelId: 'cohere-transcribe-2b' } as const;

  it('ru with Cohere Transcribe as the only active slot clamps to en (Cohere has no Russian)', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ ...COHERE_ONLY, language: 'ru' }),
    );
    expect(result.liveModelId).toBeNull();
    expect(result.finalModelId).toBe('cohere-transcribe-2b');
    expect(result.language).toBe('en');
  });

  it('ja with Cohere Transcribe as the only active slot passes through (Cohere covers Japanese)', () => {
    const result = selectEngine(
      makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' }),
      makeConfig({ ...COHERE_ONLY, language: 'ja' }),
    );
    expect(result.liveModelId).toBeNull();
    expect(result.finalModelId).toBe('cohere-transcribe-2b');
    expect(result.language).toBe('ja');
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

describe('finalNeedsSentenceCase - which committed finals the renderer recases', () => {
  // The renderer used to recase every committed final that had no lowercase
  // letter, so a bare "GPU" from Nemotron alone was typed "Gpu". Only a session
  // whose live model writes all caps (the Zipformer) can commit that model's
  // text, and it can with a refinement or cloud final too, because the hybrid
  // engine falls back to the live text when the final is late or fails. The
  // renderer's shape guard then leaves a refined final as written. Each case
  // asserts the slots it resolved first, so a preset change cannot turn a case
  // green for a different reason than the one it names.
  const capableProfile = makeProfile({ cpuCores: 8, totalRamGb: 16, gpu: 'none' });

  it('is true for Light English: the Zipformer alone writes the final', () => {
    const selected = selectEngine(capableProfile, makeConfig({ mode: 'fast', language: 'en' }));

    expect(selected.liveModelId).toBe('streaming-zipformer-en');
    expect(selected.finalModelId).toBeNull();
    expect(selected.isRemote).toBe(false);
    expect(finalNeedsSentenceCase(selected)).toBe(true);
  });

  it('is false for Best English: Parakeet v3 refines the live text and writes its own case', () => {
    const selected = selectEngine(capableProfile, makeConfig({ mode: 'accurate', language: 'en' }));

    expect(selected.liveModelId).toBe('nemotron-streaming-0.6b-en');
    expect(selected.finalModelId).toBe('parakeet-tdt-0.6b-v3');
    expect(selected.isRemote).toBe(false);
    expect(finalNeedsSentenceCase(selected)).toBe(false);
  });

  it('is false for Nemotron alone: it cases its own text, so "GPU" is typed as written', () => {
    const selected = selectEngine(
      capableProfile,
      makeConfig({ mode: 'custom', language: 'en', liveModelId: 'nemotron-streaming-0.6b-en', modelId: 'none' }),
    );

    expect(selected.liveModelId).toBe('nemotron-streaming-0.6b-en');
    expect(selected.finalModelId).toBeNull();
    expect(selected.isRemote).toBe(false);
    expect(finalNeedsSentenceCase(selected)).toBe(false);
  });

  it('is true when the Zipformer is live and the cloud writes the final, since a failed cloud final falls back to the live text', () => {
    const selected = selectEngine(
      capableProfile,
      makeConfig({
        mode: 'custom',
        language: 'en',
        liveModelId: 'streaming-zipformer-en',
        modelId: 'none',
        engineMode: 'remote',
      }),
    );

    expect(selected.liveModelId).toBe('streaming-zipformer-en');
    expect(selected.finalModelId).toBeNull();
    expect(selected.isRemote).toBe(true);
    expect(finalNeedsSentenceCase(selected)).toBe(true);
  });

  it('is true when the Zipformer is live with a refinement model, since a late refinement falls back to the live text', () => {
    const selected = selectEngine(
      capableProfile,
      makeConfig({
        mode: 'custom',
        language: 'en',
        liveModelId: 'streaming-zipformer-en',
        modelId: 'parakeet-tdt-0.6b-v3',
      }),
    );

    expect(selected.liveModelId).toBe('streaming-zipformer-en');
    expect(selected.finalModelId).toBe('parakeet-tdt-0.6b-v3');
    expect(selected.isRemote).toBe(false);
    expect(finalNeedsSentenceCase(selected)).toBe(true);
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
