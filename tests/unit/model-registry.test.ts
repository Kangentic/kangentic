import { describe, it, expect } from 'vitest';
import {
  modelLanguages,
  defaultModelForTier,
  isOfflineModel,
  getModel,
  liveCapableModels,
  finalCapableModels,
  MODELS,
  type ModelDef,
} from '../../src/main/transcription/models/model-registry';
import { MULTILINGUAL_LANGUAGE_CODES } from '../../src/shared/dictation-languages';

describe('modelLanguages', () => {
  it('returns the declared languages array when the field is present', () => {
    const model: ModelDef = {
      id: 'test-multilingual',
      engineKind: 'offline-whisper',
      displayName: 'Test multi',
      license: 'MIT',
      tier: 'accurate-base',
      approxSizeMb: 100,
      languages: ['en', 'fr', 'de'],
      files: [],
      roles: {},
    };
    expect(modelLanguages(model)).toEqual(['en', 'fr', 'de']);
  });

  it('defaults to ["en"] when the languages field is absent', () => {
    // Every English-optimized model (Parakeet, Moonshine, `.en` Whisper builds,
    // Zipformer) omits `languages`. The default must be ['en'], not undefined.
    const model: ModelDef = {
      id: 'test-english-only',
      engineKind: 'offline-whisper',
      displayName: 'Test English',
      license: 'MIT',
      tier: 'accurate-base',
      approxSizeMb: 100,
      files: [],
      roles: {},
      // languages field intentionally omitted
    };
    expect(modelLanguages(model)).toEqual(['en']);
  });

  it('passes through the exact languages array reference (no defensive copy)', () => {
    const languages = ['en', 'ja'];
    const model: ModelDef = {
      id: 'test-ref',
      engineKind: 'offline-whisper',
      displayName: 'Test',
      license: 'MIT',
      tier: 'accurate-base',
      approxSizeMb: 10,
      languages,
      files: [],
      roles: {},
    };
    // The function returns model.languages directly (no copy needed - the
    // contract is read-only). Assert the same reference so any future change
    // to wrap in a copy is caught.
    expect(modelLanguages(model)).toBe(languages);
  });
});

describe('defaultModelForTier', () => {
  it('accurate-base tier default is parakeet-tdt-0.6b-en (first in MODELS with that tier)', () => {
    // MODELS is ordered: Parakeet first, then the Whisper ladder. The first
    // accurate-base entry is Parakeet - the leaderboard-topping English model.
    const model = defaultModelForTier('accurate-base');
    expect(model.id).toBe('parakeet-tdt-0.6b-en');
    expect(model.tier).toBe('accurate-base');
  });

  it('streaming-tiny tier default is streaming-zipformer-en (the only streaming model)', () => {
    const model = defaultModelForTier('streaming-tiny');
    expect(model.id).toBe('streaming-zipformer-en');
    expect(model.tier).toBe('streaming-tiny');
  });
});

describe('isOfflineModel', () => {
  it('returns true for offline-whisper engine kind', () => {
    const whisperTiny = getModel('whisper-tiny-en');
    expect(whisperTiny).toBeDefined();
    expect(isOfflineModel(whisperTiny!)).toBe(true);
  });

  it('returns true for offline-nemo-transducer engine kind (Parakeet)', () => {
    const parakeet = getModel('parakeet-tdt-0.6b-en');
    expect(parakeet).toBeDefined();
    expect(parakeet!.engineKind).toBe('offline-nemo-transducer');
    expect(isOfflineModel(parakeet!)).toBe(true);
  });

  it('returns true for offline-moonshine engine kind', () => {
    const moonshine = getModel('moonshine-tiny-en');
    expect(moonshine).toBeDefined();
    expect(moonshine!.engineKind).toBe('offline-moonshine');
    expect(isOfflineModel(moonshine!)).toBe(true);
  });

  it('returns false for online-transducer engine kind (streaming Zipformer)', () => {
    const streaming = getModel('streaming-zipformer-en');
    expect(streaming).toBeDefined();
    expect(streaming!.engineKind).toBe('online-transducer');
    expect(isOfflineModel(streaming!)).toBe(false);
  });
});

describe('getModel', () => {
  it('returns undefined for an unrecognized model id', () => {
    expect(getModel('unknown-model-id-that-does-not-exist')).toBeUndefined();
  });

  it('returns the correct ModelDef for a known id', () => {
    const model = getModel('whisper-tiny-en');
    expect(model).toBeDefined();
    expect(model!.id).toBe('whisper-tiny-en');
    expect(model!.displayName).toBe('Whisper tiny');
    expect(model!.engineKind).toBe('offline-whisper');
  });

  it('round-trips every id in MODELS', () => {
    for (const registeredModel of MODELS) {
      expect(getModel(registeredModel.id)).toBe(registeredModel);
    }
  });
});

describe('liveCapableModels', () => {
  it('returns a non-empty list', () => {
    expect(liveCapableModels().length).toBeGreaterThan(0);
  });

  it('every returned model has liveCapable === true', () => {
    for (const model of liveCapableModels()) {
      expect(model.liveCapable).toBe(true);
    }
  });

  it('whisper-small-en is NOT in the list (too slow to chunk for live preview)', () => {
    const whisperSmall = getModel('whisper-small-en');
    expect(whisperSmall?.liveCapable).toBeFalsy();
    const liveIds = liveCapableModels().map((model) => model.id);
    expect(liveIds).not.toContain('whisper-small-en');
  });

  it('whisper-distil-medium-en is NOT in the list (final-only, too heavy to chunk)', () => {
    const distilMedium = getModel('whisper-distil-medium-en');
    expect(distilMedium?.liveCapable).toBeFalsy();
    const liveIds = liveCapableModels().map((model) => model.id);
    expect(liveIds).not.toContain('whisper-distil-medium-en');
  });

  it('includes the streaming Zipformer (native transducer - always live)', () => {
    const liveIds = liveCapableModels().map((model) => model.id);
    expect(liveIds).toContain('streaming-zipformer-en');
  });
});

describe('finalCapableModels', () => {
  it('returns a non-empty list', () => {
    expect(finalCapableModels().length).toBeGreaterThan(0);
  });

  it('every returned model is an offline model', () => {
    for (const model of finalCapableModels()) {
      expect(isOfflineModel(model)).toBe(true);
    }
  });

  it('the streaming Zipformer (online-transducer) is NOT in the list', () => {
    const finalIds = finalCapableModels().map((model) => model.id);
    expect(finalIds).not.toContain('streaming-zipformer-en');
  });

  it('includes Parakeet, Whisper tiny, and Moonshine (the full offline catalogue)', () => {
    const finalIds = finalCapableModels().map((model) => model.id);
    expect(finalIds).toContain('parakeet-tdt-0.6b-en');
    expect(finalIds).toContain('whisper-tiny-en');
    expect(finalIds).toContain('moonshine-tiny-en');
  });

  it('includes both multilingual whisper models (they are offline-whisper)', () => {
    const finalIds = finalCapableModels().map((model) => model.id);
    expect(finalIds).toContain('whisper-base-multi');
    expect(finalIds).toContain('whisper-small-multi');
  });
});

describe('whisper-base-multi model registration', () => {
  it('exists in the MODELS catalogue', () => {
    expect(getModel('whisper-base-multi')).toBeDefined();
  });

  it('engineKind is offline-whisper (loads via the Whisper config)', () => {
    expect(getModel('whisper-base-multi')!.engineKind).toBe('offline-whisper');
  });

  it('liveCapable is true (base is light enough to chunk for the live preview)', () => {
    // whisper-base-multi is the live-capable multilingual model. The small
    // multilingual build (whisper-small-multi) is final-only, matching its
    // English counterpart (whisper-small-en).
    expect(getModel('whisper-base-multi')!.liveCapable).toBe(true);
  });

  it('languages field equals MULTILINGUAL_LANGUAGE_CODES', () => {
    const model = getModel('whisper-base-multi')!;
    expect(model.languages).toEqual([...MULTILINGUAL_LANGUAGE_CODES]);
  });

  it('has exactly 3 files (encoder, decoder, tokens)', () => {
    // The Whisper offline shape: encoder + decoder + tokens.txt.
    const files = getModel('whisper-base-multi')!.files;
    expect(files).toHaveLength(3);
    const fileNames = files.map((file) => file.file);
    expect(fileNames).toContain('encoder.int8.onnx');
    expect(fileNames).toContain('decoder.int8.onnx');
    expect(fileNames).toContain('tokens.txt');
  });

  it('is in liveCapableModels()', () => {
    const liveIds = liveCapableModels().map((model) => model.id);
    expect(liveIds).toContain('whisper-base-multi');
  });
});

describe('whisper-small-multi model registration', () => {
  it('exists in the MODELS catalogue', () => {
    expect(getModel('whisper-small-multi')).toBeDefined();
  });

  it('engineKind is offline-whisper', () => {
    expect(getModel('whisper-small-multi')!.engineKind).toBe('offline-whisper');
  });

  it('liveCapable is falsy (small is too heavy to chunk for live preview, matching whisper-small-en)', () => {
    // whisper-small-multi deliberately omits liveCapable (same as whisper-small-en).
    // Asserting falsy covers both `undefined` and `false`.
    expect(getModel('whisper-small-multi')!.liveCapable).toBeFalsy();
  });

  it('languages field equals MULTILINGUAL_LANGUAGE_CODES', () => {
    const model = getModel('whisper-small-multi')!;
    expect(model.languages).toEqual([...MULTILINGUAL_LANGUAGE_CODES]);
  });

  it('has exactly 3 files (encoder, decoder, tokens)', () => {
    const files = getModel('whisper-small-multi')!.files;
    expect(files).toHaveLength(3);
    const fileNames = files.map((file) => file.file);
    expect(fileNames).toContain('encoder.int8.onnx');
    expect(fileNames).toContain('decoder.int8.onnx');
    expect(fileNames).toContain('tokens.txt');
  });

  it('is NOT in liveCapableModels()', () => {
    const liveIds = liveCapableModels().map((model) => model.id);
    expect(liveIds).not.toContain('whisper-small-multi');
  });
});
