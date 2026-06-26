import type {
  DictationConfig,
  DictationEngineId,
  DictationEngineInfo,
  DictationHardwareProfile,
  DictationEngineTier,
} from '../../../shared/types';
import type { TranscriptionEngine } from './transcription-engine';
import type { ModelDef } from '../models/model-registry';
import { defaultModelForTier, getModel, modelLanguages } from '../models/model-registry';
import { SherpaOnlineEngine, SHERPA_ONLINE_INFO } from './sherpa-online-engine';
import { SherpaWhisperEngine, SHERPA_WHISPER_INFO } from './sherpa-whisper-engine';
import { ChunkedOfflineEngine } from './chunked-offline-engine';
import { HybridEngine, SHERPA_HYBRID_INFO, type HybridSlotSpec } from './hybrid-engine';
import { RemoteOpenAiEngine, REMOTE_OPENAI_INFO } from './remote-openai-engine';
import { selectTier } from '../hardware/detect-hardware';

/** Config sentinel for an empty model slot (no live preview / no final pass). */
const NONE = 'none';

function streamingModel(): ModelDef {
  return defaultModelForTier('streaming-tiny');
}

function accurateDefault(): ModelDef {
  return defaultModelForTier('accurate-base');
}

/** The LIVE (preview) model for the config: `'none'` => no live preview; absent =>
 *  the streaming Zipformer default; an id => that model (chunked when offline). */
function liveModelFor(config: DictationConfig): ModelDef | null {
  const selection = config.liveModelId;
  if (selection === NONE) return null;
  if (!selection) return streamingModel();
  return getModel(selection) ?? streamingModel();
}

/** The FINAL (accurate) model for the config: `'none'` => no post pass; absent =>
 *  the accurate default on a capable machine (none on a weak one); an id => that. */
function finalModelFor(config: DictationConfig, tier: DictationEngineTier): ModelDef | null {
  const selection = config.modelId;
  if (selection === NONE) return null;
  if (!selection) return tier === 'accurate-base' ? accurateDefault() : null;
  return getModel(selection) ?? accurateDefault();
}

/** A live model runs natively streaming (the transducer) or chunked (offline).
 *  The chunked offline path bakes the language into its recognizer. */
function liveEngineFactory(model: ModelDef, language: string): () => TranscriptionEngine {
  return model.engineKind === 'online-transducer'
    ? () => new SherpaOnlineEngine()
    : () => new ChunkedOfflineEngine(language);
}

/** Clamp the requested language to what the running local models all support (the
 *  intersection of their language sets), falling back to English. A null slot (no
 *  live / no final) does not constrain. Guards a stale config language that the
 *  current model selection no longer supports. */
function resolveLanguage(requested: string, slots: (ModelDef | null)[]): string {
  const active = slots.filter((model): model is ModelDef => model !== null);
  if (active.length === 0) return 'en';
  const supported = active
    .map(modelLanguages)
    .reduce((intersection, languages) => intersection.filter((code) => languages.includes(code)));
  return supported.includes(requested) ? requested : 'en';
}

function dedupeModels(models: ModelDef[]): ModelDef[] {
  const seen = new Set<string>();
  const out: ModelDef[] = [];
  for (const model of models) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      out.push(model);
    }
  }
  return out;
}

export interface SelectedEngine {
  id: DictationEngineId;
  info: DictationEngineInfo;
  build: (config: DictationConfig) => TranscriptionEngine;
  models: ModelDef[];
  liveModelId: string | null;
  finalModelId: string | null;
  /** The language the engines are built for, clamped to what the models support. */
  language: string;
}

/** User-facing engine infos for the settings panel (excludes the internal stub). */
export function listEngineInfos(): DictationEngineInfo[] {
  return [SHERPA_HYBRID_INFO, SHERPA_WHISPER_INFO, SHERPA_ONLINE_INFO, REMOTE_OPENAI_INFO];
}

/**
 * Resolve the engine + its models for a dictation session. The on-device path is a
 * two-slot hybrid: a LIVE model (streaming Zipformer or a chunked offline model)
 * and a FINAL model (an offline model, or none), both from the user's dropdowns.
 * Cloud keeps the local live preview and routes the final to the remote endpoint.
 * This is the ONLY place that maps a selection to concrete engines (adapter-boundary);
 * everything else reads `engine.info`.
 */
export function selectEngine(
  profile: DictationHardwareProfile,
  config: DictationConfig,
): SelectedEngine {
  const tier = selectTier(profile);
  const isRemote = (config.engineMode ?? 'auto') === 'remote';

  const live = liveModelFor(config);
  let final: ModelDef | null = isRemote ? null : finalModelFor(config, tier);
  // On-device must always carry at least one slot.
  if (!isRemote && !live && !final) final = accurateDefault();

  // Clamp the language to what the running local models support. Remote final does
  // not constrain it (the endpoint handles its own languages), so only the live +
  // local-final slots are considered.
  const language = resolveLanguage(config.language ?? 'en', [live, isRemote ? null : final]);

  const liveSlot: HybridSlotSpec | null = live
    ? { factory: liveEngineFactory(live, language), modelId: live.id }
    : null;

  const models = dedupeModels(
    isRemote ? (live ? [live] : []) : [live, final].filter((model): model is ModelDef => model !== null),
  );

  const build = (buildConfig: DictationConfig): TranscriptionEngine => {
    const finalSlot: HybridSlotSpec | null = isRemote
      ? { factory: () => new RemoteOpenAiEngine(buildConfig.remote), modelId: null }
      : final
        ? { factory: () => new SherpaWhisperEngine(language), modelId: final.id }
        : null;
    return new HybridEngine({ live: liveSlot, final: finalSlot });
  };

  return {
    id: isRemote ? 'remote-openai' : 'hybrid',
    info: isRemote ? REMOTE_OPENAI_INFO : SHERPA_HYBRID_INFO,
    build,
    models,
    liveModelId: live?.id ?? null,
    finalModelId: isRemote ? null : (final?.id ?? null),
    language,
  };
}
