import * as sherpa from 'sherpa-onnx-node';
import type { DictationEngineInfo } from '../../../shared/types';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';
import { int16ToFloat32 } from '../audio/pcm';

export const SHERPA_ONLINE_INFO: DictationEngineInfo = {
  id: 'sherpa-onnx',
  displayName: 'sherpa-onnx (streaming)',
  streaming: true,
  punctuation: false,
  license: 'Apache-2.0',
  requiresModelDownload: true,
};

/** 0.5 s of trailing silence flushes the transducer's last words on finalize. */
const TAIL_PADDING = new Float32Array(8000);

/**
 * Streaming Zipformer transducer (sherpa-onnx OnlineRecognizer). Emits revising
 * partials as audio arrives; the final hypothesis is returned on finalize. Raw
 * lowercase text with no punctuation (the transducer's native output).
 */
export class SherpaOnlineEngine implements TranscriptionEngine {
  readonly info = SHERPA_ONLINE_INFO;
  private recognizer: sherpa.OnlineRecognizer | null = null;

  async load(models: ResolvedModel[]): Promise<void> {
    const model = models.find((entry) => entry.kind === 'online-transducer') ?? models[0];
    if (!model) throw new Error('sherpa-onnx streaming engine requires a model');
    const { encoder, decoder, joiner, tokens } = model.paths;
    this.recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder, decoder, joiner },
        tokens,
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: false,
    });
  }

  createSession(options: CreateSessionOptions): TranscriptionEngineSession {
    const recognizer = this.recognizer;
    if (!recognizer) throw new Error('sherpa-onnx streaming engine not loaded');
    const stream = recognizer.createStream();
    let lastText = '';

    const drain = (): void => {
      while (recognizer.isReady(stream)) recognizer.decode(stream);
    };

    return {
      push(pcm: Int16Array): void {
        stream.acceptWaveform({ sampleRate: 16000, samples: int16ToFloat32(pcm) });
        drain();
        const text = recognizer.getResult(stream).text;
        if (text && text !== lastText) {
          lastText = text;
          options.onPartial(text);
        }
      },
      async finalize(): Promise<string> {
        stream.acceptWaveform({ sampleRate: 16000, samples: TAIL_PADDING });
        stream.inputFinished();
        drain();
        return recognizer.getResult(stream).text.trim();
      },
      cancel(): void {
        // Nothing to release; the recognizer is disposed with the engine.
      },
      dispose(): void {
        // Stream handles are reclaimed natively when the recognizer is freed.
      },
    };
  }

  async dispose(): Promise<void> {
    this.recognizer = null;
  }
}
