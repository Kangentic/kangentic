import * as sherpa from 'sherpa-onnx-node';
import type { DictationEngineInfo } from '../../../shared/types';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';
import { concatInt16ToFloat32 } from '../audio/pcm';
import { buildOfflineConfig } from './sherpa-whisper-engine';

export const CHUNKED_OFFLINE_INFO: DictationEngineInfo = {
  id: 'chunked-offline',
  displayName: 'Accurate live (chunked)',
  streaming: true,
  punctuation: true,
  license: 'CC-BY-4.0 / MIT',
  requiresModelDownload: true,
};

/** Re-decode the growing buffer this often to emit a live partial. */
const CHUNK_INTERVAL_MS = 350;

/**
 * Drives a LIVE preview from an OFFLINE model (Parakeet / small Whisper) by
 * re-transcribing the accumulating audio buffer on a timer ("pseudo-streaming"):
 * each tick decodes the whole buffer-so-far and emits it as a partial, and
 * finalize runs one last full decode. More accurate than the streaming transducer
 * (the live text barely changes on release) but heavier - it re-runs the model
 * every ~350 ms - so it is offered only via the live-model dropdown, gated to
 * the smaller offline models. The recognizer loads once and is reused across
 * sessions (kept warm by the service); only the OfflineStream is per-utterance.
 */
export class ChunkedOfflineEngine implements TranscriptionEngine {
  readonly info = CHUNKED_OFFLINE_INFO;
  private recognizer: sherpa.OfflineRecognizer | null = null;

  /** `language` is the resolved spoken language, baked into the recognizer at
   *  load (so a multilingual live model previews in that language). English-only
   *  models always get `'en'`. */
  constructor(private readonly language: string = 'en') {}

  async load(models: ResolvedModel[]): Promise<void> {
    const model =
      models.find(
        (entry) =>
          entry.kind === 'offline-whisper' ||
          entry.kind === 'offline-nemo-transducer' ||
          entry.kind === 'offline-moonshine',
      ) ?? models[0];
    if (!model) throw new Error('Chunked-offline live engine requires an offline model');
    this.recognizer = await sherpa.OfflineRecognizer.createAsync(buildOfflineConfig(model, this.language));
  }

  createSession(options: CreateSessionOptions): TranscriptionEngineSession {
    const recognizer = this.recognizer;
    if (!recognizer) throw new Error('Chunked-offline live engine not loaded');
    let frames: Int16Array[] = [];
    let decoding = false;
    let stopped = false;

    const decode = async (): Promise<string> => {
      const samples = concatInt16ToFloat32(frames);
      if (samples.length === 0) return '';
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });
      const result = await recognizer.decodeAsync(stream);
      return result.text.trim();
    };

    const timer = setInterval(() => {
      // Skip the tick if a decode is still running so passes never overlap.
      if (decoding || stopped) return;
      decoding = true;
      void decode()
        .then((text) => {
          if (!stopped && text) options.onPartial(text);
        })
        .catch(() => undefined)
        .finally(() => {
          decoding = false;
        });
    }, CHUNK_INTERVAL_MS);

    const stop = (): void => {
      stopped = true;
      clearInterval(timer);
    };

    return {
      push(pcm: Int16Array): void {
        // Copy: the source buffer is transferred/reused across IPC frames.
        frames.push(pcm.slice());
      },
      async finalize(): Promise<string> {
        stop();
        const text = await decode();
        frames = [];
        return text;
      },
      cancel(): void {
        stop();
        frames = [];
      },
      dispose(): void {
        stop();
        frames = [];
      },
    };
  }

  async dispose(): Promise<void> {
    this.recognizer = null;
  }
}
