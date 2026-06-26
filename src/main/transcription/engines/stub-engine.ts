import type { DictationEngineInfo } from '../../../shared/types';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';

/**
 * A no-ML engine used to prove the end-to-end dictation pipeline (push-to-talk
 * -> live partials in the popup -> finalized text injected into the focused
 * terminal) before any native addon or model is wired up. It ignores audio
 * and instead emits a canned sequence of revising partials on a timer, then
 * returns a punctuated, capitalized final string to mimic the whisper.cpp
 * committed-text shape.
 */
const STUB_PARTIALS = [
  'this',
  'this is',
  'this is a',
  'this is a test of',
  'this is a test of dictation',
];
const STUB_FINAL = 'This is a test of dictation.';
const STUB_PARTIAL_INTERVAL_MS = 300;

export class StubTranscriptionEngine implements TranscriptionEngine {
  readonly info: DictationEngineInfo = {
    id: 'stub',
    displayName: 'Stub (test)',
    streaming: true,
    punctuation: true,
    license: 'none',
    requiresModelDownload: false,
  };

  async load(_models: ResolvedModel[]): Promise<void> {
    // No weights to load.
  }

  createSession(options: CreateSessionOptions): TranscriptionEngineSession {
    let partialIndex = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = (): void => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    timer = setInterval(() => {
      if (partialIndex >= STUB_PARTIALS.length) {
        stop();
        return;
      }
      options.onPartial(STUB_PARTIALS[partialIndex]);
      partialIndex += 1;
    }, STUB_PARTIAL_INTERVAL_MS);

    return {
      push(_pcm: Int16Array): void {
        // Audio is ignored by the stub.
      },
      async finalize(): Promise<string> {
        stop();
        return options.punctuation ? STUB_FINAL : STUB_FINAL.toLowerCase().replace(/[.,]/g, '');
      },
      cancel(): void {
        stop();
      },
      dispose(): void {
        stop();
      },
    };
  }

  async dispose(): Promise<void> {
    // Nothing to release.
  }
}
