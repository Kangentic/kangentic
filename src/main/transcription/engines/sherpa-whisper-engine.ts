import * as sherpa from 'sherpa-onnx-node';
import type { DictationEngineInfo } from '../../../shared/types';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';
import { concatInt16ToFloat32 } from '../audio/pcm';

export const SHERPA_WHISPER_INFO: DictationEngineInfo = {
  id: 'whisper-cpp',
  displayName: 'Accurate (offline)',
  streaming: false,
  punctuation: true,
  license: 'CC-BY-4.0 / MIT',
  requiresModelDownload: true,
};

/**
 * The accurate offline path, model-driven via sherpa-onnx `OfflineRecognizer`.
 * It runs whichever offline model the registry selected: an NVIDIA Parakeet
 * NeMo transducer (the default - leaderboard-topping English, very fast) or a
 * Whisper model. Both produce punctuation and casing. There are no live
 * partials (the popup shows the recording state, then the final text on
 * release). The model loads and decodes on a worker thread (createAsync /
 * decodeAsync), so the main process event loop is not blocked.
 *
 * The engine id stays `whisper-cpp` (the engine-mode value) to avoid a config
 * migration; it now denotes "the accurate offline engine", not the library.
 */
export class SherpaWhisperEngine implements TranscriptionEngine {
  readonly info = SHERPA_WHISPER_INFO;
  private recognizer: sherpa.OfflineRecognizer | null = null;

  /** `language` is the resolved spoken language (Whisper code). It is baked into
   *  the recognizer at load, so a multilingual model transcribes that language;
   *  English-only models always get `'en'`. */
  constructor(private readonly language: string = 'en') {}

  async load(models: ResolvedModel[]): Promise<void> {
    const model =
      models.find(
        (entry) =>
          entry.kind === 'offline-whisper' ||
          entry.kind === 'offline-nemo-transducer' ||
          entry.kind === 'offline-moonshine',
      ) ?? models[0];
    if (!model) throw new Error('Offline engine requires a model');
    this.recognizer = await sherpa.OfflineRecognizer.createAsync(buildOfflineConfig(model, this.language));
  }

  createSession(_options: CreateSessionOptions): TranscriptionEngineSession {
    const recognizer = this.recognizer;
    if (!recognizer) throw new Error('Offline engine not loaded');
    let frames: Int16Array[] = [];

    return {
      push(pcm: Int16Array): void {
        // Copy: the source buffer is transferred/reused across IPC frames.
        frames.push(pcm.slice());
      },
      async finalize(): Promise<string> {
        const samples = concatInt16ToFloat32(frames);
        frames = [];
        if (samples.length === 0) return '';
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: 16000, samples });
        const result = await recognizer.decodeAsync(stream);
        return result.text.trim();
      },
      cancel(): void {
        frames = [];
      },
      dispose(): void {
        frames = [];
      },
    };
  }

  async dispose(): Promise<void> {
    this.recognizer = null;
  }
}

/**
 * Build the `OfflineRecognizer` config for the resolved model's kind. A NeMo
 * transducer (Parakeet) uses `modelConfig.transducer` + `modelType:
 * 'nemo_transducer'`; Moonshine uses `modelConfig.moonshine` (preprocessor +
 * encoder + uncached/cached decoders); Whisper uses `modelConfig.whisper`.
 */
export function buildOfflineConfig(model: ResolvedModel, language: string = 'en'): unknown {
  const featConfig = { sampleRate: 16000, featureDim: 80 };
  if (model.kind === 'offline-nemo-transducer') {
    const { encoder, decoder, joiner, tokens } = model.paths;
    return {
      featConfig,
      modelConfig: {
        transducer: { encoder, decoder, joiner },
        tokens,
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
        modelType: 'nemo_transducer',
      },
      decodingMethod: 'greedy_search',
    };
  }
  if (model.kind === 'offline-moonshine') {
    const { preprocessor, encoder, uncachedDecoder, cachedDecoder, tokens } = model.paths;
    return {
      featConfig,
      modelConfig: {
        moonshine: { preprocessor, encoder, uncachedDecoder, cachedDecoder },
        tokens,
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      },
    };
  }
  const { encoder, decoder, tokens } = model.paths;
  return {
    featConfig,
    modelConfig: {
      // `language` is the resolved spoken language. A `.en` build only accepts
      // 'en' (the only value the language intersection ever yields for it); a
      // multilingual build transcribes the given language.
      whisper: { encoder, decoder, language, task: 'transcribe' },
      tokens,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  };
}
