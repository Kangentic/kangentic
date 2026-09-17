import * as sherpa from 'sherpa-onnx-node';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';
import { concatInt16ToFloat32 } from '../audio/pcm';
import { buildOfflineConfig } from './sherpa-whisper-engine';
import { CHUNKED_OFFLINE_INFO } from './engine-infos';

/** Floor on the gap between live decodes. A pass waits this long, or as long as
 *  the pass before it took, whichever is greater. */
const MIN_DECODE_GAP_MS = 350;

/**
 * Drives a LIVE preview from an OFFLINE model (Parakeet / small Whisper) by
 * re-transcribing the accumulating audio buffer ("pseudo-streaming"): each pass
 * decodes the whole buffer-so-far and emits it as a partial, and finalize runs
 * one last full decode. More accurate than the streaming transducer (the live
 * text barely changes on release) but heavier, so it is offered only via the
 * live-model dropdown, gated to the smaller offline models. The recognizer loads
 * once and is reused across sessions (kept warm by the service); only the
 * OfflineStream is per-utterance.
 *
 * Three things about the loop are load-bearing.
 *
 * It is a self-rescheduling timeout, not a fixed interval, and the gap after each
 * pass is the greater of MIN_DECODE_GAP_MS and how long that pass took. A fixed
 * interval saturates: decode cost grows with the buffer, so once a decode outlasts
 * the interval the next tick fires the moment the last one lands, and the model
 * runs back-to-back for the rest of the hold. Scaling the gap caps the duty cycle
 * at about half instead, and spaces the decode starts geometrically once the gap
 * clears the floor. Measured on int8 Parakeet at numThreads 4 (RTF about 0.019, so
 * a decode outgrows the 350ms floor around 21s of held audio), a 30s hold goes
 * from 69 passes and 55% duty to 50 passes and 37%. Below roughly 21s the floor
 * still governs and the cadence is unchanged, so this buys nothing on short
 * utterances and is not meant to. Every pass decodes the FULL buffer either way,
 * so live accuracy is untouched; only the cadence stretches.
 *
 * Decodes never overlap WITHIN a session, which is what `decodeInFlight` and
 * finalize's wait on it are for. Sherpa's OfflineRecognizer decodes one stream at a
 * time (its batch DecodeStreams form is how it expects to be asked for more), so
 * two concurrent decodeAsync calls would share the recognizer's decoder and model
 * across two threadpool threads. They would also double the outstanding napi async
 * work, which is the shape DESKTOP-X came from
 * (.claude/rules/dictation-out-of-process.md). Mind that scope: `decodeInFlight` is
 * per-session closure state while the recognizer belongs to the ENGINE, so two
 * sessions drawn from the same warm engine can still decode on one recognizer at
 * once. That gap predates this loop (the flag it replaced was scoped identically),
 * is not closed here, and would need a queue owned by the engine rather than by
 * the session.
 * Serializing costs release-to-insert latency whenever a pass is in flight at the
 * moment the key comes up: about one decode, so roughly 0.6s after a 30s hold. How
 * often that is paid is exactly the duty cycle, which is the second reason the
 * adaptive gap is worth having here (55% of releases to 37%, measured as above).
 *
 * A pass always allocates a fresh OfflineStream because an offline stream is
 * one-shot: sherpa's AcceptWaveform calls InputFinished() on the feature extractor,
 * so there is no way to feed one stream incrementally. Deciding less often is the
 * only lever on how many get allocated. Nothing frees them explicitly either - the
 * addon attaches a napi finalizer that calls SherpaOnnxDestroyOfflineStream on GC,
 * but never calls napi_adjust_external_memory, so V8 sees a tiny object and is in
 * no hurry to collect it.
 */
export class ChunkedOfflineEngine implements TranscriptionEngine {
  readonly info = CHUNKED_OFFLINE_INFO;
  private recognizer: sherpa.OfflineRecognizer | null = null;
  /** The stop callback of every session handed out and not yet ended. This is the
   *  one engine whose sessions do ongoing work, so it is the one that needs the
   *  bookkeeping; the others end a session holding nothing to release. */
  private readonly runningSessions = new Set<() => void>();

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
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The decode currently on the threadpool, or null between passes. This is
     *  what finalize waits out so two decodeAsync calls never run at once. */
    let decodeInFlight: Promise<string> | null = null;

    const decode = async (): Promise<string> => {
      const samples = concatInt16ToFloat32(frames);
      if (samples.length === 0) return '';
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });
      const result = await recognizer.decodeAsync(stream);
      return result.text.trim();
    };

    /** Decode once, emit the partial, then schedule the next pass a gap
     *  proportional to how long this one took. It reschedules itself rather than
     *  calling a separate helper: two mutually recursive const arrows would put
     *  one lexically before its definition and trip no-use-before-define, which
     *  `--max-warnings 0` turns into a failed lint. */
    const runTick = async (): Promise<void> => {
      const startedAt = Date.now();
      decodeInFlight = decode();
      try {
        const text = await decodeInFlight;
        if (!stopped && text) options.onPartial(text);
      } catch {
        // The live preview is best-effort.
      } finally {
        decodeInFlight = null;
      }
      if (stopped) return;
      timer = setTimeout(() => void runTick(), Math.max(MIN_DECODE_GAP_MS, Date.now() - startedAt));
    };

    timer = setTimeout(() => void runTick(), MIN_DECODE_GAP_MS);

    const stop = (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      this.runningSessions.delete(stop);
    };
    // So engine.dispose() can actually stop this loop. Without it a session whose
    // finalize/cancel never arrives keeps decoding for the life of the worker,
    // and dictation-worker's maybeDisposeEngine has no way to reach it.
    this.runningSessions.add(stop);

    return {
      push(pcm: Int16Array): void {
        // Copy: the source buffer is transferred/reused across IPC frames.
        frames.push(pcm.slice());
      },
      async finalize(): Promise<string> {
        stop();
        // Wait out a pass that is already decoding before starting the final one.
        await decodeInFlight?.catch(() => undefined);
        // decode() reads `frames` synchronously before its first await, so the
        // Int16 copies can be dropped now rather than held alongside the Float32
        // buffer through the most expensive decode of the utterance. Matches
        // SherpaWhisperEngine.
        const pending = decode();
        // Tracked like a live pass. The final decode is the longest of the
        // utterance, so it is the one most likely to still be running when a
        // cancel arrives (TranscriptionService sends one on every finalize
        // timeout), and drain() has to wait it out too.
        decodeInFlight = pending;
        frames = [];
        try {
          return await pending;
        } finally {
          decodeInFlight = null;
        }
      },
      cancel(): void {
        stop();
        frames = [];
      },
      dispose(): void {
        stop();
        frames = [];
      },
      async drain(): Promise<void> {
        // cancel()/dispose() are void by contract, so a pass already on the
        // threadpool outlives them. The worker waits on this before disposing
        // the engine, so the recognizer is never torn down mid-decode.
        await decodeInFlight?.catch(() => undefined);
      },
    };
  }

  async dispose(): Promise<void> {
    // Copied first: each stop() removes itself from the set as it runs.
    for (const stopSession of [...this.runningSessions]) stopSession();
    this.runningSessions.clear();
    this.recognizer = null;
  }
}
