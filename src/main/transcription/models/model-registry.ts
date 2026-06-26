import type { DictationEngineTier } from '../../../shared/types';
import { MULTILINGUAL_LANGUAGE_CODES } from '../../../shared/dictation-languages';

/** A single downloadable model file. `file` is its on-disk name under the
 *  model's directory; `url` is the direct (CDN-redirecting) download URL. */
export interface ModelFileSpec {
  url: string;
  file: string;
}

/** The native engine shape a model drives. */
export type ModelEngineKind =
  | 'online-transducer'
  | 'offline-whisper'
  | 'offline-nemo-transducer'
  | 'offline-moonshine';

export interface ModelDef {
  id: string;
  engineKind: ModelEngineKind;
  displayName: string;
  /** Commercial-redistribution license of the model weights. */
  license: string;
  /** Which auto-tier this model is the default for. */
  tier: DictationEngineTier;
  /** Approximate total download size, for the UI. */
  approxSizeMb: number;
  /** Can this model drive the LIVE preview - a streaming transducer (native) or
   *  an offline model small/fast enough to re-decode in chunks in real time?
   *  Whisper small/medium are too slow to chunk, so they are final-only. */
  liveCapable?: boolean;
  /** Spoken languages this model can transcribe (Whisper / BCP-47 codes). Absent
   *  means English-only (`['en']`) - the case for every English-optimized model
   *  (Parakeet, the `.en` Whisper builds, Moonshine, the Zipformer). Only the
   *  multilingual Whisper builds declare the broader set. */
  languages?: string[];
  files: ModelFileSpec[];
  /** Map of sherpa-onnx config role -> on-disk filename (a subset of `files`). */
  roles: Record<string, string>;
}

/** A model's supported languages, defaulting an absent field to English-only. */
export function modelLanguages(model: ModelDef): string[] {
  return model.languages ?? ['en'];
}

const STREAMING_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main';
const WHISPER_TINY_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main';
const WHISPER_BASE_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base.en/resolve/main';
const WHISPER_SMALL_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small.en/resolve/main';
const WHISPER_MEDIUM_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-medium.en/resolve/main';
const PARAKEET_V2_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main';
const MOONSHINE_TINY_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8/resolve/main';
const MOONSHINE_BASE_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/main';
const DISTIL_SMALL_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-distil-small.en/resolve/main';
const DISTIL_MEDIUM_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-distil-medium.en/resolve/main';
// Multilingual Whisper builds (no `.en` suffix). Same architecture as the English
// models but cover ~99 languages; we expose the curated MULTILINGUAL_LANGUAGE_CODES.
const WHISPER_BASE_MULTI_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/main';
const WHISPER_SMALL_MULTI_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/main';

/**
 * The streaming Zipformer transducer (English). Apache-2.0 weights, commercially
 * redistributable. Drives the low-latency live-partial path. int8-quantized for
 * a smaller download and lower CPU.
 */
const STREAMING_ZIPFORMER_EN: ModelDef = {
  id: 'streaming-zipformer-en',
  engineKind: 'online-transducer',
  displayName: 'Streaming Zipformer',
  license: 'Apache-2.0',
  tier: 'streaming-tiny',
  approxSizeMb: 70,
  liveCapable: true,
  files: [
    { url: `${STREAMING_BASE}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${STREAMING_BASE}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx`, file: 'decoder.onnx' },
    { url: `${STREAMING_BASE}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, file: 'joiner.int8.onnx' },
    { url: `${STREAMING_BASE}/tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.onnx',
    joiner: 'joiner.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/**
 * Whisper tiny (English), the accurate + natively-punctuated offline path.
 * Whisper weights are MIT-licensed (OpenAI). int8-quantized. tiny downloads fast
 * and is the safe default; `whisper-base-en` is a higher-accuracy option.
 */
const WHISPER_TINY_EN: ModelDef = {
  id: 'whisper-tiny-en',
  engineKind: 'offline-whisper',
  displayName: 'Whisper tiny',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 45,
  liveCapable: true,
  files: [
    { url: `${WHISPER_TINY_BASE}/tiny.en-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${WHISPER_TINY_BASE}/tiny.en-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${WHISPER_TINY_BASE}/tiny.en-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/** Whisper base (English): more accurate than tiny, larger download. */
const WHISPER_BASE_EN: ModelDef = {
  id: 'whisper-base-en',
  engineKind: 'offline-whisper',
  displayName: 'Whisper base',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 150,
  liveCapable: true,
  files: [
    { url: `${WHISPER_BASE_BASE}/base.en-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${WHISPER_BASE_BASE}/base.en-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${WHISPER_BASE_BASE}/base.en-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/** Whisper small (English): the most accurate offline option; larger download. */
const WHISPER_SMALL_EN: ModelDef = {
  id: 'whisper-small-en',
  engineKind: 'offline-whisper',
  displayName: 'Whisper small',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 480,
  files: [
    { url: `${WHISPER_SMALL_BASE}/small.en-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${WHISPER_SMALL_BASE}/small.en-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${WHISPER_SMALL_BASE}/small.en-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/** Whisper medium (English): the most accurate offline option; large download. */
const WHISPER_MEDIUM_EN: ModelDef = {
  id: 'whisper-medium-en',
  engineKind: 'offline-whisper',
  displayName: 'Whisper medium',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 945,
  files: [
    { url: `${WHISPER_MEDIUM_BASE}/medium.en-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${WHISPER_MEDIUM_BASE}/medium.en-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${WHISPER_MEDIUM_BASE}/medium.en-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/**
 * NVIDIA Parakeet TDT 0.6B (English) - the accurate default. Tops the Hugging
 * Face Open ASR Leaderboard for English on accuracy AND is dramatically faster
 * than Whisper (a Fast-Conformer transducer), with native punctuation + casing.
 * Parakeet-TDT-0.6b-v2 is NVIDIA, CC-BY-4.0 (attribution required).
 */
const PARAKEET_TDT_06B_V2: ModelDef = {
  id: 'parakeet-tdt-0.6b-en',
  engineKind: 'offline-nemo-transducer',
  displayName: 'Parakeet TDT 0.6B',
  license: 'CC-BY-4.0',
  tier: 'accurate-base',
  approxSizeMb: 660,
  liveCapable: true,
  files: [
    { url: `${PARAKEET_V2_BASE}/encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${PARAKEET_V2_BASE}/decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${PARAKEET_V2_BASE}/joiner.int8.onnx`, file: 'joiner.int8.onnx' },
    { url: `${PARAKEET_V2_BASE}/tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    joiner: 'joiner.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/**
 * Moonshine tiny (English) - Useful Sensors' edge-optimized model: very fast and
 * light (5-15x faster than Whisper on-device, sub-1 GB memory), the low-end
 * option. MIT (English). A distinct sherpa-onnx kind (preprocessor + encoder +
 * uncached/cached decoders). liveCapable: light enough to chunk for live.
 */
const MOONSHINE_TINY_EN: ModelDef = {
  id: 'moonshine-tiny-en',
  engineKind: 'offline-moonshine',
  displayName: 'Moonshine tiny',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 124,
  liveCapable: true,
  files: [
    { url: `${MOONSHINE_TINY_BASE}/preprocess.onnx`, file: 'preprocess.onnx' },
    { url: `${MOONSHINE_TINY_BASE}/encode.int8.onnx`, file: 'encode.int8.onnx' },
    { url: `${MOONSHINE_TINY_BASE}/uncached_decode.int8.onnx`, file: 'uncached_decode.int8.onnx' },
    { url: `${MOONSHINE_TINY_BASE}/cached_decode.int8.onnx`, file: 'cached_decode.int8.onnx' },
    { url: `${MOONSHINE_TINY_BASE}/tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    preprocessor: 'preprocess.onnx',
    encoder: 'encode.int8.onnx',
    uncachedDecoder: 'uncached_decode.int8.onnx',
    cachedDecoder: 'cached_decode.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/** Moonshine base (English): larger Moonshine - still fast + light, a strong fast
 *  option for low/mid machines. MIT. */
const MOONSHINE_BASE_EN: ModelDef = {
  id: 'moonshine-base-en',
  engineKind: 'offline-moonshine',
  displayName: 'Moonshine base',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 287,
  liveCapable: true,
  files: [
    { url: `${MOONSHINE_BASE_BASE}/preprocess.onnx`, file: 'preprocess.onnx' },
    { url: `${MOONSHINE_BASE_BASE}/encode.int8.onnx`, file: 'encode.int8.onnx' },
    { url: `${MOONSHINE_BASE_BASE}/uncached_decode.int8.onnx`, file: 'uncached_decode.int8.onnx' },
    { url: `${MOONSHINE_BASE_BASE}/cached_decode.int8.onnx`, file: 'cached_decode.int8.onnx' },
    { url: `${MOONSHINE_BASE_BASE}/tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    preprocessor: 'preprocess.onnx',
    encoder: 'encode.int8.onnx',
    uncachedDecoder: 'uncached_decode.int8.onnx',
    cachedDecoder: 'cached_decode.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/** Distil-Whisper small (English): distilled Whisper - near-Whisper accuracy at
 *  much higher decode speed, lighter than whisper-small. MIT. Loads via the Whisper
 *  config (same encoder/decoder shape). liveCapable (the faster decode chunks well). */
const WHISPER_DISTIL_SMALL_EN: ModelDef = {
  id: 'whisper-distil-small-en',
  engineKind: 'offline-whisper',
  displayName: 'Distil-Whisper small',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 299,
  liveCapable: true,
  files: [
    { url: `${DISTIL_SMALL_BASE}/distil-small.en-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${DISTIL_SMALL_BASE}/distil-small.en-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${DISTIL_SMALL_BASE}/distil-small.en-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/** Distil-Whisper medium (English): distilled whisper-medium - high accuracy,
 *  faster + smaller than whisper-medium. Final-only (too heavy to chunk live). MIT. */
const WHISPER_DISTIL_MEDIUM_EN: ModelDef = {
  id: 'whisper-distil-medium-en',
  engineKind: 'offline-whisper',
  displayName: 'Distil-Whisper medium',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 573,
  files: [
    { url: `${DISTIL_MEDIUM_BASE}/distil-medium.en-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${DISTIL_MEDIUM_BASE}/distil-medium.en-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${DISTIL_MEDIUM_BASE}/distil-medium.en-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/**
 * Whisper base (multilingual): the live-capable multilingual model. Same shape
 * as `whisper-base-en` but the multilingual build, so it transcribes the curated
 * language set. liveCapable (base is light enough to chunk). MIT.
 */
const WHISPER_BASE_MULTI: ModelDef = {
  id: 'whisper-base-multi',
  engineKind: 'offline-whisper',
  displayName: 'Whisper base (multilingual)',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 160,
  liveCapable: true,
  languages: [...MULTILINGUAL_LANGUAGE_CODES],
  files: [
    { url: `${WHISPER_BASE_MULTI_BASE}/base-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${WHISPER_BASE_MULTI_BASE}/base-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${WHISPER_BASE_MULTI_BASE}/base-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/**
 * Whisper small (multilingual): the accurate multilingual final model. Final-only
 * (small is too heavy to chunk live, matching `whisper-small-en`). MIT.
 */
const WHISPER_SMALL_MULTI: ModelDef = {
  id: 'whisper-small-multi',
  engineKind: 'offline-whisper',
  displayName: 'Whisper small (multilingual)',
  license: 'MIT',
  tier: 'accurate-base',
  approxSizeMb: 480,
  languages: [...MULTILINGUAL_LANGUAGE_CODES],
  files: [
    { url: `${WHISPER_SMALL_MULTI_BASE}/small-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${WHISPER_SMALL_MULTI_BASE}/small-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${WHISPER_SMALL_MULTI_BASE}/small-tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

// Order matters: the first model of a tier is its default. Parakeet is the
// default accurate model (leaderboard-topping English accuracy + far faster
// than Whisper); the Whisper ladder (fastest tiny -> largest medium) follows as
// selectable alternatives, then the streaming Zipformer for the live path.
export const MODELS: readonly ModelDef[] = [
  PARAKEET_TDT_06B_V2,
  WHISPER_TINY_EN,
  WHISPER_BASE_EN,
  WHISPER_SMALL_EN,
  WHISPER_MEDIUM_EN,
  MOONSHINE_TINY_EN,
  MOONSHINE_BASE_EN,
  WHISPER_DISTIL_SMALL_EN,
  WHISPER_DISTIL_MEDIUM_EN,
  WHISPER_BASE_MULTI,
  WHISPER_SMALL_MULTI,
  STREAMING_ZIPFORMER_EN,
];

export function getModel(modelId: string): ModelDef | undefined {
  return MODELS.find((model) => model.id === modelId);
}

/** The default model id for a given tier (the first registered model of that
 *  tier). `accurate-base` -> whisper tiny (safe, fast); `streaming-tiny` ->
 *  the streaming Zipformer. */
export function defaultModelForTier(tier: DictationEngineTier): ModelDef {
  const match = MODELS.find((model) => model.tier === tier);
  return match ?? WHISPER_TINY_EN;
}

/** True for an offline (whisper / nemo-transducer / moonshine) model. */
export function isOfflineModel(model: ModelDef): boolean {
  return (
    model.engineKind === 'offline-whisper' ||
    model.engineKind === 'offline-nemo-transducer' ||
    model.engineKind === 'offline-moonshine'
  );
}

/** Models that can drive the LIVE preview: the streaming transducer (native) plus
 *  offline models small enough to re-decode in chunks in real time. */
export function liveCapableModels(): ModelDef[] {
  return MODELS.filter((model) => model.liveCapable);
}

/** Models that can produce the accurate FINAL result: every offline model. */
export function finalCapableModels(): ModelDef[] {
  return MODELS.filter(isOfflineModel);
}
