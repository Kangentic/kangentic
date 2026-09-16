import type {
  DictationConfig,
  DictationEngineId,
  DictationEngineInfo,
  DictationHardwareProfile,
  DictationEngineTier,
} from '../../../shared/types';
import type { ModelDef, ModelEngineKind } from '../models/model-registry';
import { defaultModelForTier, getModel, modelLanguages } from '../models/model-registry';
import { selectTier } from '../hardware/detect-hardware';
import { SHERPA_HYBRID_INFO, SHERPA_ONLINE_INFO, SHERPA_WHISPER_INFO, REMOTE_OPENAI_INFO } from './engine-infos';

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

/**
 * A dictation engine selection resolved from hardware + user config: which
 * models to load, and enough data for the worker's `engine-build.ts` to
 * construct the right concrete engine, without this (main-resident) module
 * ever importing `sherpa-onnx-node`. `liveModelKind` carries the one piece
 * of model data the build step needs that isn't already implied by
 * `liveModelId`/`finalModelId` - whether the live model is the native
 * streaming transducer or an offline model driven in chunks - so the worker
 * never has to re-derive it from a `ModelDef` main never sends.
 *
 * This is the ONLY place that maps a selection to concrete engine IDENTITY
 * (adapter-boundary); `engine-build.ts` (worker-only) is the only place that
 * maps it to concrete engine CONSTRUCTION. See
 * .claude/rules/dictation-out-of-process.md.
 */
export interface EngineSelection {
  id: DictationEngineId;
  info: DictationEngineInfo;
  models: ModelDef[];
  liveModelId: string | null;
  liveModelKind: ModelEngineKind | null;
  finalModelId: string | null;
  isRemote: boolean;
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
 */
export function selectEngine(
  profile: DictationHardwareProfile,
  config: DictationConfig,
): EngineSelection {
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

  const models = dedupeModels(
    isRemote ? (live ? [live] : []) : [live, final].filter((model): model is ModelDef => model !== null),
  );

  return {
    id: isRemote ? 'remote-openai' : 'hybrid',
    info: isRemote ? REMOTE_OPENAI_INFO : SHERPA_HYBRID_INFO,
    models,
    liveModelId: live?.id ?? null,
    liveModelKind: live?.engineKind ?? null,
    finalModelId: isRemote ? null : (final?.id ?? null),
    isRemote,
    language,
  };
}

/**
 * A stable cache key for the resolved engine + model + remote selection,
 * shared by main (to name a warm request to the worker) and the worker
 * (to key its own warm-engine LRU) so the two sides can never compute it
 * differently. No engine-name branching (the remote fields are simply empty
 * for on-device), so the boundary that keeps engine-id mapping in this file
 * stays intact.
 */
export function computeEngineKey(selected: EngineSelection, config: DictationConfig): string {
  return [
    selected.id,
    // Both slots, not the deduped model set: live=Parakeet/final=none and
    // live=none/final=Parakeet share one model id but are different engines.
    selected.liveModelId ?? 'none',
    selected.finalModelId ?? 'none',
    // The Whisper recognizer bakes the language in at creation, so each language
    // is a distinct warm engine (the model files are shared/cached on disk).
    selected.language,
    config.remote?.url ?? '',
    config.remote?.apiKey ?? '',
    config.remote?.model ?? '',
  ].join('|');
}
