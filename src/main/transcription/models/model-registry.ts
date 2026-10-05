import { COHERE_TRANSCRIBE_LANGUAGE_CODES, MULTILINGUAL_LANGUAGE_CODES, PARAKEET_V3_LANGUAGE_CODES } from '../../../shared/dictation-languages';
import type { ModelLicenseId } from '../../../shared/model-licenses';
import type { DictationModelEngineKind } from '../../../shared/types';

/** A single downloadable model file. `file` is its on-disk name under the
 *  model's directory; `url` is the direct (CDN-redirecting) download URL. */
export interface ModelFileSpec {
  url: string;
  file: string;
}

/** The native engine shape a model drives (`DictationModelEngineKind`). */
export type ModelEngineKind = DictationModelEngineKind;

/** Whether an offline recognizer decodes each kind: the refinement models, and
 *  the live models driven in chunks. The engines route on it. A Record, so a
 *  kind added to `DictationModelEngineKind` does not compile until it is
 *  classified here. */
const OFFLINE_ENGINE_KIND: Readonly<Record<ModelEngineKind, boolean>> = {
  'online-transducer': false,
  'offline-whisper': true,
  'offline-nemo-transducer': true,
  'offline-moonshine': true,
  'offline-cohere-transcribe': true,
};

/** True for a kind an offline recognizer decodes. */
export function isOfflineKind(kind: ModelEngineKind): boolean {
  return OFFLINE_ENGINE_KIND[kind];
}

/** How accurate a model is next to the others. Speed depends mostly on the
 *  machine, so accuracy is the one figure the dropdowns compare. */
export interface ModelAccuracy {
  /** Higher is more accurate; the dropdowns sort on it. */
  rank: number;
  label: 'Best accuracy' | 'High accuracy' | 'Good accuracy' | 'Fair accuracy' | 'Basic accuracy';
}

export interface ModelDef {
  id: string;
  engineKind: ModelEngineKind;
  /** Short on purpose: the dropdown option is the name, the accuracy label and
   *  the size, and it has to fit the field without widening the menu. */
  displayName: string;
  license: ModelLicenseId;
  accuracy: ModelAccuracy;
  /** Total download size in MiB, the unit the downloader multiplies back into
   *  bytes for its progress bar. Summed from the Hugging Face file listing. */
  approxSizeMb: number;
  /** Can this model drive the LIVE preview - a streaming transducer (native) or
   *  an offline model small/fast enough to re-decode in chunks in real time?
   *  Whisper small/medium are too slow to chunk, so they are final-only. */
  liveCapable?: boolean;
  /** Spoken languages this model can transcribe (Whisper / BCP-47 codes). Absent
   *  means English-only (`['en']`) - the case for every English-optimized model
   *  (Parakeet unified and v2, Nemotron streaming, the `.en` Whisper builds,
   *  Moonshine, the Zipformer). */
  languages?: string[];
  /** The model writes all caps with no punctuation (the Zipformer), so a final
   *  in that shape from a session it is live in is sentence-cased before it is
   *  typed. With any other live model the final is typed as written, acronyms
   *  included. */
  writesAllCaps?: boolean;
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
// The models added in the October 2026 refresh are pinned to a commit, not
// `main`. The downloader skips a file already on disk, so a re-upload under the
// same id would never reach an installed user; new weights get a new id instead.
const PARAKEET_UNIFIED_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming/resolve/8c3a10fb13408c7a7054f6898958bf1c64a8d6c7';
const PARAKEET_V3_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78';
const NEMOTRON_EN_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25/resolve/52056fdc070914a48dcd68b31b44d6a6f5b85902';
const NEMOTRON_MULTI_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3';
const COHERE_TRANSCRIBE_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01/resolve/156a470cf08eefe706a0004f3c52d9ee567ca7a0';

/** The four files every sherpa-onnx transducer export ships, and their roles. */
function transducerFiles(base: string): Pick<ModelDef, 'files' | 'roles'> {
  return {
    files: [
      { url: `${base}/encoder.int8.onnx`, file: 'encoder.int8.onnx' },
      { url: `${base}/decoder.int8.onnx`, file: 'decoder.int8.onnx' },
      { url: `${base}/joiner.int8.onnx`, file: 'joiner.int8.onnx' },
      { url: `${base}/tokens.txt`, file: 'tokens.txt' },
    ],
    roles: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
  };
}

/*
 * How the lineup was chosen (2026-10-05, `node scripts/measure-dictation-models.mjs`).
 * Every candidate ran through these engines' configs on 20 dictated prompts
 * (two synthesized voices) and two read-speech clips. "As typed" counts case
 * and punctuation, the text a user gets; the leaderboard's word error ignores
 * both.
 *
 *   model                word error  as typed  closing mark  real-time factor
 *   Cohere Transcribe       3.1%       3.9%      20/20          0.106
 *   Parakeet v3             3.8%       4.7%      20/20          0.035
 *   Parakeet v2             2.8%       5.1%      20/20          0.035
 *   Parakeet unified        2.4%       5.5%      15/20          0.036
 *   Canary 180M flash       5.5%       8.7%      20/20          0.051
 *   Nemotron streaming      1.4%      11.0%       0/20          0.161 (live)
 *   Streaming Zipformer    19.3%    all caps      0/20          0.044 (live)
 *
 * Parakeet v3 refines the presets: second to Cohere as typed at a quarter of
 * the size and three times the speed, and best or tied on the German, Spanish,
 * French and Ukrainian clips. Qwen3-ASR 0.6B (7.1% as typed, 941 MiB) and
 * Canary 180M flash were measured and not added. The leaderboard's ranks do
 * not carry over: they score words alone, and Parakeet unified's int8 export
 * leaves off a closing mark one prompt in four.
 */

/**
 * NVIDIA Parakeet TDT 0.6B v3: the refinement model behind Best and the one
 * model of Balanced, for English and the nine European languages it covers.
 * Native punctuation and casing, a closing mark on every prompt, and automatic
 * language detection. CC-BY-4.0.
 */
const PARAKEET_TDT_06B_V3: ModelDef = {
  id: 'parakeet-tdt-0.6b-v3',
  engineKind: 'offline-nemo-transducer',
  displayName: 'Parakeet v3 (multilingual)',
  license: 'CC-BY-4.0',
  accuracy: { rank: 6, label: 'High accuracy' },
  approxSizeMb: 639,
  liveCapable: true,
  languages: [...PARAKEET_V3_LANGUAGE_CODES],
  ...transducerFiles(PARAKEET_V3_BASE),
};

/**
 * Cohere Transcribe (2B, Apache-2.0): the Open ASR leaderboard's first place
 * (5.42 average word error) and the most accurate model as typed here, offered
 * in Custom only. It is 2.7 GiB on disk, needs about 1.9 GB of memory, and
 * refines three times slower than Parakeet. Each stream is pinned to the
 * dictation language (`SherpaWhisperEngine`). The encoder keeps its weights in
 * `encoder.int8.onnx.data` beside it, under the name the graph refers to.
 */
const COHERE_TRANSCRIBE: ModelDef = {
  id: 'cohere-transcribe-2b',
  engineKind: 'offline-cohere-transcribe',
  displayName: 'Cohere Transcribe',
  license: 'Apache-2.0',
  accuracy: { rank: 7, label: 'Best accuracy' },
  approxSizeMb: 2754,
  languages: [...COHERE_TRANSCRIBE_LANGUAGE_CODES],
  files: [
    { url: `${COHERE_TRANSCRIBE_BASE}/encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${COHERE_TRANSCRIBE_BASE}/encoder.int8.onnx.data`, file: 'encoder.int8.onnx.data' },
    { url: `${COHERE_TRANSCRIBE_BASE}/decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${COHERE_TRANSCRIBE_BASE}/tokens.txt`, file: 'tokens.txt' },
  ],
  roles: {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    tokens: 'tokens.txt',
  },
};

/**
 * NVIDIA Nemotron speech streaming en 0.6B, 560 ms chunks: the English live
 * model behind Best. The most accurate words of any model measured (1.4%), and
 * cased, but it punctuates only inside a sentence and never closes one, so a
 * refinement pass follows it. It loads through the same plain transducer config
 * as the Zipformer; sherpa reads its 128-wide features and chunk size from the
 * model.
 */
const NEMOTRON_STREAMING_EN: ModelDef = {
  id: 'nemotron-streaming-0.6b-en',
  engineKind: 'online-transducer',
  displayName: 'Nemotron streaming',
  license: 'NVIDIA-Open-Model-License',
  accuracy: { rank: 5, label: 'High accuracy' },
  approxSizeMb: 631,
  liveCapable: true,
  ...transducerFiles(NEMOTRON_EN_BASE),
};

/**
 * NVIDIA Nemotron 3.5 ASR streaming 0.6B, 560 ms chunks: the live model for
 * every language but English, and Balanced for the five Parakeet v3 does not
 * cover. Each stream is pinned to the dictation language through sherpa's
 * per-stream `language` option (`SherpaOnlineEngine`). Its words beat Whisper
 * base multi's on zh, ar, ko and uk; like the English model it does not close
 * a sentence.
 */
const NEMOTRON_STREAMING_MULTI: ModelDef = {
  id: 'nemotron-3.5-streaming-0.6b',
  engineKind: 'online-transducer',
  displayName: 'Nemotron 3.5 (multilingual)',
  license: 'OpenMDW-1.1',
  accuracy: { rank: 4, label: 'High accuracy' },
  approxSizeMb: 651,
  liveCapable: true,
  languages: [...MULTILINGUAL_LANGUAGE_CODES],
  ...transducerFiles(NEMOTRON_MULTI_BASE),
};

/**
 * NVIDIA Parakeet unified en 0.6B: the best word accuracy of the refinement
 * models (5.91 leaderboard average, 2.4% here), offered in Custom. Its int8
 * export leaves off a sentence's closing mark often enough (15 of 20 prompts
 * kept it) that no preset uses it. The non-streaming export.
 */
const PARAKEET_UNIFIED_EN: ModelDef = {
  id: 'parakeet-unified-0.6b-en',
  engineKind: 'offline-nemo-transducer',
  displayName: 'Parakeet unified',
  license: 'NVIDIA-Open-Model-License',
  accuracy: { rank: 5, label: 'High accuracy' },
  approxSizeMb: 632,
  liveCapable: true,
  ...transducerFiles(PARAKEET_UNIFIED_BASE),
};

/**
 * NVIDIA Parakeet TDT 0.6B v2 (English). The refinement model of the presets
 * until Parakeet v3 replaced it; it stays selectable in Custom. CC-BY-4.0.
 */
const PARAKEET_TDT_06B_V2: ModelDef = {
  id: 'parakeet-tdt-0.6b-en',
  engineKind: 'offline-nemo-transducer',
  displayName: 'Parakeet v2',
  license: 'CC-BY-4.0',
  accuracy: { rank: 5, label: 'High accuracy' },
  approxSizeMb: 631,
  liveCapable: true,
  ...transducerFiles(PARAKEET_V2_BASE),
};

/**
 * The streaming Zipformer transducer (English): the Light preset's one model
 * and the low-end default. Apache-2.0 weights. All-caps text with no
 * punctuation (the renderer sentence-cases it), but tiny, nearly free on CPU,
 * and its text is ready the moment the key is released. int8-quantized.
 */
const STREAMING_ZIPFORMER_EN: ModelDef = {
  id: 'streaming-zipformer-en',
  engineKind: 'online-transducer',
  displayName: 'Streaming Zipformer',
  license: 'Apache-2.0',
  accuracy: { rank: 1, label: 'Basic accuracy' },
  approxSizeMb: 70,
  liveCapable: true,
  writesAllCaps: true,
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
 * Whisper tiny (English), a natively-punctuated offline model. Whisper weights
 * are MIT-licensed (OpenAI). int8-quantized.
 */
const WHISPER_TINY_EN: ModelDef = {
  id: 'whisper-tiny-en',
  engineKind: 'offline-whisper',
  displayName: 'Whisper tiny',
  license: 'MIT',
  accuracy: { rank: 1, label: 'Basic accuracy' },
  approxSizeMb: 99,
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
  accuracy: { rank: 2, label: 'Fair accuracy' },
  approxSizeMb: 153,
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

/** Whisper small (English): final-only, too slow to chunk live. */
const WHISPER_SMALL_EN: ModelDef = {
  id: 'whisper-small-en',
  engineKind: 'offline-whisper',
  displayName: 'Whisper small',
  license: 'MIT',
  accuracy: { rank: 3, label: 'Good accuracy' },
  approxSizeMb: 358,
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

/** Whisper medium (English): the largest Whisper option; final-only. */
const WHISPER_MEDIUM_EN: ModelDef = {
  id: 'whisper-medium-en',
  engineKind: 'offline-whisper',
  displayName: 'Whisper medium',
  license: 'MIT',
  accuracy: { rank: 4, label: 'High accuracy' },
  approxSizeMb: 902,
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
 * Moonshine tiny (English) - Useful Sensors' edge-optimized model: very fast and
 * light (5-15x faster than Whisper on-device, sub-1 GB memory). MIT (English).
 * A distinct sherpa-onnx kind (preprocessor + encoder + uncached/cached
 * decoders). liveCapable: light enough to chunk for live.
 */
const MOONSHINE_TINY_EN: ModelDef = {
  id: 'moonshine-tiny-en',
  engineKind: 'offline-moonshine',
  displayName: 'Moonshine tiny',
  license: 'MIT',
  accuracy: { rank: 1, label: 'Basic accuracy' },
  approxSizeMb: 118,
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

/** Moonshine base (English): larger Moonshine - still fast and light. MIT.
 *  Moonshine v2 is not offered: its builds carry the Moonshine AI Community
 *  License (a revenue cap and a display requirement), not MIT. */
const MOONSHINE_BASE_EN: ModelDef = {
  id: 'moonshine-base-en',
  engineKind: 'offline-moonshine',
  displayName: 'Moonshine base',
  license: 'MIT',
  accuracy: { rank: 3, label: 'Good accuracy' },
  approxSizeMb: 274,
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
  accuracy: { rank: 3, label: 'Good accuracy' },
  approxSizeMb: 285,
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
  accuracy: { rank: 4, label: 'High accuracy' },
  approxSizeMb: 547,
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
 * Whisper base (multilingual): the Light preset's live model for languages
 * other than English. Same shape as `whisper-base-en` but the multilingual
 * build. liveCapable (base is light enough to chunk). MIT.
 */
const WHISPER_BASE_MULTI: ModelDef = {
  id: 'whisper-base-multi',
  engineKind: 'offline-whisper',
  displayName: 'Whisper base (multilingual)',
  license: 'MIT',
  accuracy: { rank: 2, label: 'Fair accuracy' },
  approxSizeMb: 153,
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
 * Whisper small (multilingual): the Best preset's refinement model for the
 * languages Parakeet v3 does not cover. Final-only (small is too heavy to chunk
 * live, matching `whisper-small-en`). MIT.
 */
const WHISPER_SMALL_MULTI: ModelDef = {
  id: 'whisper-small-multi',
  engineKind: 'offline-whisper',
  displayName: 'Whisper small (multilingual)',
  license: 'MIT',
  accuracy: { rank: 3, label: 'Good accuracy' },
  approxSizeMb: 358,
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

// Order breaks ties in the dropdowns, which sort by accuracy rank. Which model
// a machine gets by default lives in the shared preset table
// (`src/shared/dictation-presets.ts`), not here.
export const MODELS: readonly ModelDef[] = [
  COHERE_TRANSCRIBE,
  PARAKEET_TDT_06B_V3,
  NEMOTRON_STREAMING_EN,
  PARAKEET_TDT_06B_V2,
  PARAKEET_UNIFIED_EN,
  NEMOTRON_STREAMING_MULTI,
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

/** True for an offline (whisper / nemo-transducer / moonshine / cohere) model. */
export function isOfflineModel(model: ModelDef): boolean {
  return isOfflineKind(model.engineKind);
}

/** Models that can drive the LIVE preview: the streaming transducers (native)
 *  plus offline models small enough to re-decode in chunks in real time. */
export function liveCapableModels(): ModelDef[] {
  return MODELS.filter((model) => model.liveCapable);
}

/** Models that can produce the accurate FINAL result: every offline model. */
export function finalCapableModels(): ModelDef[] {
  return MODELS.filter(isOfflineModel);
}
