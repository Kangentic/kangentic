import type { DictationRemoteEndpoint } from '../../../shared/types';
import type { TranscriptionEngine } from './transcription-engine';
import { SherpaOnlineEngine } from './sherpa-online-engine';
import { SherpaWhisperEngine } from './sherpa-whisper-engine';
import { ChunkedOfflineEngine } from './chunked-offline-engine';
import { HybridEngine, type HybridSlotSpec } from './hybrid-engine';
import { RemoteOpenAiEngine } from './remote-openai-engine';
import type { EngineSelection } from './engine-selection';
import type { ModelEngineKind } from '../models/model-registry';

/**
 * The worker-only half of the engine-selection/engine-build split
 * (engine-selection.ts is the main-resident half). This is the ONLY place
 * that CONSTRUCTS a native (sherpa-onnx) transcription engine - it runs
 * exclusively inside the `kangentic-dictation` utilityProcess worker
 * (dictation-worker.ts), so a native fault during construction, load, or
 * decode can never reach the main process. See DESKTOP-X and
 * .claude/rules/dictation-out-of-process.md.
 */

/** A live model runs natively streaming (the transducer) or chunked (offline).
 *  The chunked offline path bakes the language into its recognizer. */
function liveEngineFactory(kind: ModelEngineKind, language: string): () => TranscriptionEngine {
  return kind === 'online-transducer'
    ? () => new SherpaOnlineEngine()
    : () => new ChunkedOfflineEngine(language);
}

/**
 * Construct the concrete engine for a resolved selection. Mirrors what the
 * pre-split `engine-registry.ts`'s `build` closure did, translated from a
 * `DictationConfig` closure into the serializable `EngineSelection` +
 * `DictationRemoteEndpoint` this worker receives over IPC from main.
 */
export function buildEngine(selection: EngineSelection, remote: DictationRemoteEndpoint | undefined): TranscriptionEngine {
  const liveSlot: HybridSlotSpec | null =
    selection.liveModelId && selection.liveModelKind
      ? { factory: liveEngineFactory(selection.liveModelKind, selection.language), modelId: selection.liveModelId }
      : null;

  const finalSlot: HybridSlotSpec | null = selection.isRemote
    ? { factory: () => new RemoteOpenAiEngine(remote), modelId: null }
    : selection.finalModelId
      ? { factory: () => new SherpaWhisperEngine(selection.language), modelId: selection.finalModelId }
      : null;

  return new HybridEngine({ live: liveSlot, final: finalSlot });
}
