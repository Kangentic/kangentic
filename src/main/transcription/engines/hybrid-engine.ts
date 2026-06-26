import type { DictationEngineInfo } from '../../../shared/types';
import type {
  CreateSessionOptions,
  ResolvedModel,
  TranscriptionEngine,
  TranscriptionEngineSession,
} from './transcription-engine';

export const SHERPA_HYBRID_INFO: DictationEngineInfo = {
  id: 'hybrid',
  displayName: 'Hybrid (live + accurate)',
  streaming: true,
  punctuation: true,
  license: 'Apache-2.0 + MIT',
  requiresModelDownload: true,
};

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
    const liveSession = this.live ? this.live.engine.createSession(options) : null;
    const finalSession = this.final
      ? this.final.engine.createSession({ ...options, onPartial: () => undefined })
      : null;

    return {
      push(pcm: Int16Array): void {
        liveSession?.push(pcm);
        finalSession?.push(pcm);
      },
      async finalize(): Promise<string> {
        // Flush the live session (stops the live partials); keep its text as a
        // fallback / as the result when there is no final pass.
        let liveText = '';
        if (liveSession) {
          try {
            liveText = await liveSession.finalize();
          } catch {
            // The live preview is best-effort.
          }
        }
        if (finalSession) {
          try {
            return await finalSession.finalize();
          } catch (error) {
            // The accurate final failed (e.g. the cloud endpoint is not configured
            // yet, or a network error). Fall back to the live text rather than nothing.
            if (liveText.trim().length > 0) return liveText;
            throw error;
          }
        }
        return liveText;
      },
      cancel(): void {
        liveSession?.cancel();
        finalSession?.cancel();
      },
      dispose(): void {
        liveSession?.dispose();
        finalSession?.dispose();
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
