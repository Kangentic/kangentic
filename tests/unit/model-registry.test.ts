import { describe, it, expect } from 'vitest';
import {
  modelLanguages,
  isOfflineKind,
  isOfflineModel,
  getModel,
  liveCapableModels,
  finalCapableModels,
  MODELS,
  type ModelDef,
  type ModelEngineKind,
} from '../../src/main/transcription/models/model-registry';
import { DICTATION_LANGUAGES, MULTILINGUAL_LANGUAGE_CODES, PARAKEET_V3_LANGUAGE_CODES } from '../../src/shared/dictation-languages';
import { MODEL_LICENSES } from '../../src/shared/model-licenses';

describe('modelLanguages', () => {
  it('returns the declared languages array when the field is present', () => {
    const model: ModelDef = {
      id: 'test-multilingual',
      engineKind: 'offline-whisper',
      displayName: 'Test multi',
      license: 'MIT',
      accuracy: { rank: 1, label: 'Basic accuracy' },
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
      accuracy: { rank: 1, label: 'Basic accuracy' },
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
      accuracy: { rank: 1, label: 'Basic accuracy' },
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

describe('the October 2026 lineup', () => {
  it('registers each new model under its own id and engine kind', () => {
    expect(getModel('parakeet-unified-0.6b-en')?.engineKind).toBe('offline-nemo-transducer');
    expect(getModel('parakeet-tdt-0.6b-v3')?.engineKind).toBe('offline-nemo-transducer');
    expect(getModel('nemotron-streaming-0.6b-en')?.engineKind).toBe('online-transducer');
    expect(getModel('nemotron-3.5-streaming-0.6b')?.engineKind).toBe('online-transducer');
  });

  // The downloader skips a file already on disk, so a model's weights can only
  // change under a new id. The ids the old lineup saved must keep resolving.
  it('keeps every id an older config may hold', () => {
    for (const id of ['parakeet-tdt-0.6b-en', 'streaming-zipformer-en', 'whisper-base-multi', 'whisper-small-multi']) {
      expect(getModel(id)).toBeDefined();
    }
  });

  it('pins the new models to a commit, not main', () => {
    for (const id of ['parakeet-unified-0.6b-en', 'parakeet-tdt-0.6b-v3', 'nemotron-streaming-0.6b-en', 'nemotron-3.5-streaming-0.6b']) {
      for (const fileSpec of getModel(id)!.files) {
        expect(fileSpec.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      }
    }
  });

  it('gives Parakeet v3 its ten languages and Nemotron 3.5 the whole curated set', () => {
    expect(modelLanguages(getModel('parakeet-tdt-0.6b-v3')!)).toEqual([...PARAKEET_V3_LANGUAGE_CODES]);
    expect(modelLanguages(getModel('nemotron-3.5-streaming-0.6b')!)).toEqual([...MULTILINGUAL_LANGUAGE_CODES]);
  });
});

describe('every registered model', () => {
  it('carries an accuracy label and a license the settings tabs can name', () => {
    for (const model of MODELS) {
      expect(model.accuracy.rank).toBeGreaterThan(0);
      expect(model.accuracy.label).toMatch(/accuracy$/);
      expect(MODEL_LICENSES[model.license]).toBeDefined();
    }
  });

  it('declares only languages the Language dropdown offers', () => {
    const offered = DICTATION_LANGUAGES.map((language) => language.code);
    for (const model of MODELS) {
      for (const code of modelLanguages(model)) expect(offered).toContain(code);
    }
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

describe('isOfflineKind', () => {
  // Every engine routes on this set. A kind that drops out of it falls out of
  // finalCapableModels(), so its model silently vanishes from the Refinement
  // dropdown with nothing else failing.
  const offlineKinds: ModelEngineKind[] = [
    'offline-whisper',
    'offline-nemo-transducer',
    'offline-moonshine',
    'offline-cohere-transcribe',
  ];

  for (const kind of offlineKinds) {
    it(`returns true for ${kind}`, () => {
      expect(isOfflineKind(kind)).toBe(true);
    });
  }

  it('returns false for online-transducer (the streaming engines decode natively)', () => {
    expect(isOfflineKind('online-transducer')).toBe(false);
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

describe('cohere-transcribe-2b model registration', () => {
  it('exists in the MODELS catalogue', () => {
    expect(getModel('cohere-transcribe-2b')).toBeDefined();
  });

  it('engineKind is offline-cohere-transcribe', () => {
    expect(getModel('cohere-transcribe-2b')!.engineKind).toBe('offline-cohere-transcribe');
  });

  it('is an offline model (a refinement model, decoded after release)', () => {
    expect(isOfflineModel(getModel('cohere-transcribe-2b')!)).toBe(true);
  });

  it('is in finalCapableModels() (it must stay in the Refinement dropdown)', () => {
    const finalIds = finalCapableModels().map((model) => model.id);
    expect(finalIds).toContain('cohere-transcribe-2b');
  });

  it('liveCapable is falsy (2.7 GiB and three times slower than Parakeet, far too heavy to chunk for live)', () => {
    expect(getModel('cohere-transcribe-2b')!.liveCapable).toBeFalsy();
  });

  it('is NOT in liveCapableModels()', () => {
    const liveIds = liveCapableModels().map((model) => model.id);
    expect(liveIds).not.toContain('cohere-transcribe-2b');
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
