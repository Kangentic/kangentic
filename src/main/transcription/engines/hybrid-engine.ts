import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';
import { SHERPA_HYBRID_INFO } from './engine-infos';

/** One slot of the hybrid: how to build the engine and which resolved model id
 *  it loads (`null` = loads nothing, e.g. the remote final). */
export interface HybridSlotSpec {
  factory: () => TranscriptionEngine;
  modelId: string | null;
}

interface HybridSlot {
  engine: TranscriptionEngine;
  modelId: string | null;
}

/**
 * How long `finalize()` waits for a final slot that is still loading before it
 * commits the live text instead. The accurate model starts loading on the
 * press (`createSession`), so by release it has already had the whole
 * utterance; this bound only bites on a short utterance against a cold disk.
 * It has to leave room for the decode itself inside DictationClient's 30 s
 * FINALIZE_TIMEOUT_MS: a ten-minute hold (the worker's MAX_SESSION_MS) decodes
 * in about 11 s at Parakeet's measured RTF, and 15 + 11 fits.
 */
const FINAL_LOAD_WAIT_MS = 15_000;

/** True when `promise` fulfilled within `ms`; false when it rejected or the
 *  bound elapsed first. A rejection is consumed here on purpose: the caller
 *  falls back either way, and the memoized load has its own handler. */
function fulfilledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function forSlot(models: ResolvedModel[], modelId: string | null): ResolvedModel[] {
  return modelId ? models.filter((model) => model.id === modelId) : [];
}

/**
 * Composite engine with two independent, injectable slots:
 *   - LIVE: emits partials as the user speaks (the streaming Zipformer natively,
 *     or an offline model re-decoded in chunks). Optional - omit for no preview.
 *   - FINAL: produces the committed accurate text on release (an on-device offline
 *     model, or the remote cloud engine). Optional - omit to keep the live text.
 * At least one slot must be present. Models are routed to each slot by resolved
 * model id (a model can be both live-chunked and final), so it composes the
 * sub-engines without inferring slots from model kind.
 *
 * The two slots load at different times, and that split is what keeps the
 * dictation worker small while it waits. `load()` loads the LIVE slot only (the
 * ~70 MB streaming model). The FINAL slot (the 631 MB accurate model) loads
 * lazily, started by the first `createSession()` and overlapped with the
 * utterance it serves: the session streams partials from the live slot at
 * once, buffers every frame for the final slot, and `finalize()` hands the
 * buffer to a final sub-session created only then. A press that releases
 * before the accurate model is ready (a short utterance on a cold disk) waits a
 * bounded FINAL_LOAD_WAIT_MS and then commits a full live decode instead. So a
 * pre-warmed worker holds only the live model, and the accurate model is
 * resident only in a worker that has actually served a session - which is
 * exactly the worker DictationClient recycles after its idle window.
 */
export class HybridEngine implements TranscriptionEngine {
  readonly info = SHERPA_HYBRID_INFO;
  private readonly live: HybridSlot | null;
  private readonly final: HybridSlot | null;
  /** The model set `load()` was given, kept so the final slot can load from it later. */
  private models: ResolvedModel[] | null = null;
  /** The in-flight or settled final-slot load, memoized so every session shares
   *  one load. Cleared on rejection so the next session retries. */
  private finalLoad: Promise<void> | null = null;
  /** Why the last final-slot load failed, for a release that finds no load
   *  to wait on. Cleared when a new load starts. */
  private finalLoadError: unknown = null;

  constructor(slots: { live: HybridSlotSpec | null; final: HybridSlotSpec | null }) {
    this.live = slots.live ? { engine: slots.live.factory(), modelId: slots.live.modelId } : null;
    this.final = slots.final ? { engine: slots.final.factory(), modelId: slots.final.modelId } : null;
    if (!this.live && !this.final) {
      throw new Error('Hybrid engine requires at least a live or a final engine');
    }
  }

  /** Load the live slot now; the final slot waits for the first session. */
  async load(models: ResolvedModel[]): Promise<void> {
    this.models = models;
    if (this.live) await this.live.engine.load(forSlot(models, this.live.modelId));
  }

  /** Start (or join) the final slot's load. Resolves once it is usable. */
  private ensureFinalLoaded(): Promise<void> {
    const final = this.final;
    if (!final) return Promise.resolve();
    if (this.finalLoad) return this.finalLoad;
    const models = this.models;
    if (!models) {
      return Promise.reject(new Error('Hybrid engine: load() must run before the final slot can load'));
    }
    this.finalLoadError = null;
    this.finalLoad = final.engine.load(forSlot(models, final.modelId)).catch((error: unknown) => {
      // Not sticky: a transient failure (a disk hiccup mid-read) gets another
      // try from the next session's press instead of pinning the fallback for
      // the life of the worker. Only this load can be the memoized one when
      // its own rejection lands, since a new one starts only from a cleared
      // memo.
      this.finalLoad = null;
      this.finalLoadError = error;
      throw error;
    });
    return this.finalLoad;
  }

  /** The load a release waits on: the one its press started. A release never
   *  starts a load of its own - if the press's load already failed, the
   *  fallback is immediate and the NEXT press retries. */
  private finalReady(): Promise<void> {
    return this.finalLoad ?? Promise.reject(this.finalLoadError ?? new Error('The accurate model has not started loading'));
  }

  createSession(options: CreateSessionOptions): TranscriptionEngineSession {
    // The live sub-session forwards partials; the final slot only ever sees
    // the buffered frames, at finalize.
    // The last hypothesis the live slot emitted, kept as the fallback for when a
    // final pass fails. It is the text the user has been watching, so falling
    // back to it is also the least surprising thing that can happen on screen.
    let lastLivePartial = '';
    const liveSession = this.live
      ? this.live.engine.createSession({
          ...options,
          onPartial: (text: string) => {
            lastLivePartial = text;
            options.onPartial(text);
          },
        })
      : null;
    const final = this.final;
    if (final) {
      // The press is the precursor gesture: start the accurate model now so it
      // loads while the user is still speaking. finalize() observes the same
      // memoized promise; this handler only keeps a rejection from going
      // unhandled in between.
      void this.ensureFinalLoaded().catch(() => undefined);
    }
    /** Every frame of the utterance, for the final sub-session. Copies, since
     *  the offline sessions copy on push for the same ownership reason. About
     *  19 MB at the worker's ten-minute session cap. */
    let buffer: Int16Array[] = [];
    let finalSession: TranscriptionEngineSession | null = null;

    const liveFallback = async (): Promise<string> => {
      // The final slot is not usable (still loading past the bound, failed to
      // load, or failed to start), so the live text is the committed text and
      // has to be a complete decode of the buffer rather than a partial.
      if (!liveSession) return '';
      try {
        return await liveSession.finalize();
      } catch {
        // The live preview is best-effort, and with nothing behind it the
        // last partial the user watched is the closest thing to a result.
        return lastLivePartial;
      }
    };

    return {
      push(pcm: Int16Array): void {
        liveSession?.push(pcm);
        if (final) buffer.push(pcm.slice());
      },
      finalize: async (): Promise<string> => {
        if (!final) return liveFallback();

        if (liveSession) {
          if (!(await fulfilledWithin(this.finalReady(), FINAL_LOAD_WAIT_MS))) return liveFallback();
        } else {
          // Nothing to fall back to, so a load failure IS the failure, and
          // the wait is bounded only by the client's request timeout.
          await this.finalReady();
        }

        // Create and feed the final sub-session BEFORE cancelling the live
        // one: a chunked live engine's cancel() drops its frames, so a final
        // createSession that throws after the cancel would leave the live
        // fallback decoding nothing.
        try {
          const created = final.engine.createSession({ ...options, onPartial: () => undefined });
          for (const frame of buffer) created.push(frame);
          buffer = [];
          finalSession = created;
        } catch (error) {
          if (!liveSession) throw error;
          return liveFallback();
        }
        // A final slot will produce the committed text, so finalizing the live
        // slot too would run a second full-buffer decode whose result is read
        // only on the error path below. On a 30s hold with the chunked live
        // engine that is about another 0.6s of release-to-insert latency spent
        // on a string that is normally thrown away. Stop it instead.
        liveSession?.cancel();
        try {
          return await finalSession.finalize();
        } catch (error) {
          // The accurate final failed (e.g. the cloud endpoint is not configured
          // yet, or a network error). Fall back to the live text rather than
          // nothing. It lags the tail of the utterance by up to one live pass,
          // which is the price of not paying for that decode every single time.
          if (lastLivePartial.trim().length > 0) return lastLivePartial;
          throw error;
        }
      },
      cancel(): void {
        liveSession?.cancel();
        finalSession?.cancel();
        buffer = [];
      },
      dispose(): void {
        liveSession?.dispose();
        finalSession?.dispose();
        buffer = [];
      },
      async drain(): Promise<void> {
        await Promise.all([liveSession?.drain?.(), finalSession?.drain?.()]);
      },
    };
  }

  async dispose(): Promise<void> {
    // A final load still in flight assigns its recognizer when it settles, so
    // disposing the final engine before that would drop nothing and leave the
    // recognizer behind on a disposed engine. Wait it out; a rejection is not
    // ours to report here (dictation-worker.ts calls this un-awaited, and an
    // unhandled rejection takes the worker down).
    await this.finalLoad?.catch(() => undefined);
    await Promise.all([
      this.live ? this.live.engine.dispose() : Promise.resolve(),
      this.final ? this.final.engine.dispose() : Promise.resolve(),
    ]);
  }
}
