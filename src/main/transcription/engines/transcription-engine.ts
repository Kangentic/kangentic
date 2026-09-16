import type { DictationEngineInfo } from '../../../shared/types';

/**
 * A model resolved on disk and ready to load. `paths` holds the absolute
 * locations of the model's files keyed by role (e.g. `encoder`/`decoder`/
 * `joiner` for a transducer, `encoder`/`decoder`/`tokens` for whisper). `kind`
 * lets a composite engine (hybrid) route each model to the right sub-engine.
 * Engines that need no model (stub/remote) receive an empty array.
 */
export interface ResolvedModel {
  id: string;
  engineId: string;
  kind: 'online-transducer' | 'offline-whisper' | 'offline-nemo-transducer' | 'offline-moonshine';
  /** Absolute paths to the model's files, keyed by role. */
  paths: Record<string, string>;
}

/**
 * Per-dictation-session creation options. `onPartial` is called repeatedly
 * by streaming engines with the latest (possibly revising) hypothesis; it is
 * safe to revise because the live transcript renders in the popup, not the
 * terminal. Only `finalize()`'s return value is committed to the PTY.
 */
export interface CreateSessionOptions {
  /** Capture rate is fixed at 16 kHz mono; engines may assert on this. */
  sampleRate: 16000;
  language: string;
  /** When true, the committed text should carry punctuation and casing. */
  punctuation: boolean;
  onPartial: (text: string) => void;
}

/**
 * A live transcription session. PCM frames (16 kHz mono Int16) are pushed in
 * via the service funnel; `finalize()` flushes the engine and returns the
 * committed text; `cancel()` aborts without committing; `dispose()` releases
 * any native resources held by the session.
 */
export interface TranscriptionEngineSession {
  push(pcm: Int16Array): void;
  finalize(): Promise<string>;
  cancel(): void;
  dispose(): void;
}

/**
 * The pluggable transcription engine boundary. Implementations live under
 * `src/main/transcription/engines/` and follow the agent/board adapter
 * convention: nothing outside that folder branches on a specific engine id;
 * callers read `info`. The selection-to-engine mapping is split across a
 * process boundary (see DESKTOP-X /
 * .claude/rules/dictation-out-of-process.md): `engine-selection.ts` (main)
 * maps a config to an `EngineSelection` - pure data, no `sherpa-onnx-node`
 * import - and `engine-build.ts` (the `kangentic-dictation` utilityProcess
 * worker only) is the one place that constructs a concrete engine from it.
 * `TranscriptionService` (main) owns session bookkeeping and routes all
 * audio (local renderer PCM today, a future mobile client later) to the
 * worker via `DictationClient`; the engines themselves - and every
 * `TranscriptionEngine` / `TranscriptionEngineSession` instance - live only
 * in the worker.
 */
export interface TranscriptionEngine {
  readonly info: DictationEngineInfo;
  /** Load weights. Single-model engines take a one-element array; the hybrid
   *  takes both its transducer and whisper models; stub/remote take `[]`. */
  load(models: ResolvedModel[]): Promise<void>;
  createSession(options: CreateSessionOptions): TranscriptionEngineSession;
  dispose(): Promise<void>;
}
