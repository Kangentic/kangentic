import * as sherpa from 'sherpa-onnx-node';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';
import { int16ToFloat32 } from '../audio/pcm';
import { SHERPA_ONLINE_INFO } from './engine-infos';

/** 0.5 s of trailing silence flushes the transducer's last words on finalize.
 *  Enough for Nemotron's 560 ms chunks too: a clip with its trailing silence
 *  cut off kept its last word at 250 ms of padding. */
const TAIL_PADDING = new Float32Array(8000);

/** 0.6 s of leading silence primes the encoder before the first word. Without
 *  it Nemotron 3.5 dropped a clip's first word ("Alles", "No"); 300 ms recovered
 *  half of it. The Zipformer and Nemotron en decode the same or better with it. */
const LEAD_PADDING = new Float32Array(9600);

/**
 * Streaming transducer (sherpa-onnx OnlineRecognizer): the Zipformer, or a NeMo
 * model such as Nemotron. Emits revising partials as audio arrives; the final
 * hypothesis is returned on finalize. The Zipformer's text is uppercase with no
 * punctuation; Nemotron cases its text and punctuates some of it.
 *
 * `featureDim: 80` is right for the Zipformer only. sherpa reads a NeMo model's
 * width (128) from its encoder and overrides it, so one config loads both.
 */
export class SherpaOnlineEngine implements TranscriptionEngine {
  readonly info = SHERPA_ONLINE_INFO;
  private recognizer: sherpa.OnlineRecognizer | null = null;

  /** `language` pins each stream of a multilingual model (Nemotron 3.5) to the
   *  dictation language; other models ignore the option. */
  constructor(private readonly language = 'en') {}

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
    stream.setOption('language', this.language);
    let lastText = '';

    const drain = (): void => {
      while (recognizer.isReady(stream)) recognizer.decode(stream);
    };
    // Nemotron 3.5 can leave two spaces after a sentence's period.
    const hypothesis = (): string => recognizer.getResult(stream).text.replace(/ {2,}/g, ' ');
    // Decoded now, at the press, so the first push carries no extra work.
    stream.acceptWaveform({ sampleRate: 16000, samples: LEAD_PADDING });
    drain();

    return {
      push(pcm: Int16Array): void {
        stream.acceptWaveform({ sampleRate: 16000, samples: int16ToFloat32(pcm) });
        drain();
        const text = hypothesis();
        if (text && text !== lastText) {
          lastText = text;
          options.onPartial(text);
        }
      },
      async finalize(): Promise<string> {
        stream.acceptWaveform({ sampleRate: 16000, samples: TAIL_PADDING });
        stream.inputFinished();
        drain();
        return hypothesis().trim();
      },
      cancel(): void {
        // Nothing to release: this engine decodes synchronously inside push(),
        // so a session never ends with work outstanding. That is why it needs no
        // drain() either, unlike the chunked-offline live engine.
      },
      dispose(): void {
        // The stream's native handle is freed by the addon's napi finalizer once
        // V8 collects this closure, not by anything callable from here: the JS
        // wrapper exposes no free/dispose, and freeing the recognizer does not
        // reach it. Nothing to do, but not for the reason it looks like.
      },
    };
  }

  async dispose(): Promise<void> {
    this.recognizer = null;
  }
}
