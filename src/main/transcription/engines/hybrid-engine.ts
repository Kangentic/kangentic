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
 * Composite engine with two independent, injectable slots:
 *   - LIVE: emits partials as the user speaks (the streaming Zipformer natively,
 *     or an offline model re-decoded in chunks). Optional - omit for no preview.
 *   - FINAL: produces the committed accurate text on release (an on-device offline
 *     model, or the remote cloud engine). Optional - omit to keep the live text.
 * At least one slot must be present. Both buffer the same audio; `finalize()`
 * returns the FINAL engine's text when present, else the LIVE engine's. Models are
 * routed to each slot by resolved model id (a model can be both live-chunked and
 * final), so it composes the sub-engines without inferring slots from model kind.
 */
export class HybridEngine implements TranscriptionEngine {
  readonly info = SHERPA_HYBRID_INFO;
  private readonly live: HybridSlot | null;
  private readonly final: HybridSlot | null;

  constructor(slots: { live: HybridSlotSpec | null; final: HybridSlotSpec | null }) {
    this.live = slots.live ? { engine: slots.live.factory(), modelId: slots.live.modelId } : null;
    this.final = slots.final ? { engine: slots.final.factory(), modelId: slots.final.modelId } : null;
    if (!this.live && !this.final) {
      throw new Error('Hybrid engine requires at least a live or a final engine');
    }
  }

  async load(models: ResolvedModel[]): Promise<void> {
    const forSlot = (modelId: string | null): ResolvedModel[] =>
      modelId ? models.filter((model) => model.id === modelId) : [];
    await Promise.all([
      this.live ? this.live.engine.load(forSlot(this.live.modelId)) : Promise.resolve(),
      this.final ? this.final.engine.load(forSlot(this.final.modelId)) : Promise.resolve(),
    ]);
  }

  createSession(options: CreateSessionOptions): TranscriptionEngineSession {
    // The live sub-session forwards partials; the final buffers silently.
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
    let finalSession: TranscriptionEngineSession | null = null;
    try {
      finalSession = this.final
        ? this.final.engine.createSession({ ...options, onPartial: () => undefined })
        : null;
    } catch (error) {
      // Nothing holds the live session yet, so without this nothing could ever
      // stop it: the chunked live engine's decode loop would tick for the life of
      // the worker, and the worker's maybeDisposeEngine cannot reach it (an
      // engine's dispose only drops its recognizer reference).
      liveSession?.dispose();
      throw error;
    }

    return {
      push(pcm: Int16Array): void {
        liveSession?.push(pcm);
        finalSession?.push(pcm);
      },
      async finalize(): Promise<string> {
        // With no final slot the live text IS the committed text, so it has to be
        // a complete decode of the buffer rather than a partial.
        if (!finalSession) {
          if (!liveSession) return '';
          try {
            return await liveSession.finalize();
          } catch {
            // The live preview is best-effort, and with nothing behind it the
            // last partial the user watched is the closest thing to a result.
            return lastLivePartial;
          }
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
      },
      dispose(): void {
        liveSession?.dispose();
        finalSession?.dispose();
      },
      async drain(): Promise<void> {
        await Promise.all([liveSession?.drain?.(), finalSession?.drain?.()]);
      },
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.live ? this.live.engine.dispose() : Promise.resolve(),
      this.final ? this.final.engine.dispose() : Promise.resolve(),
    ]);
  }
}
