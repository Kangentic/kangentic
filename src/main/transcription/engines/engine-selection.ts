import type {
  DictationConfig,
  DictationEngineId,
  DictationEngineInfo,
  DictationHardwareProfile,
} from '../../../shared/types';
import type { ModelDef, ModelEngineKind } from '../models/model-registry';
import { getModel, modelLanguages } from '../models/model-registry';
import { selectTier } from '../hardware/select-tier';
import { NO_MODEL, TIER_DEFAULT_PRESET, presetModels, resolveDictationSlots } from '../../../shared/dictation-presets';
import { SHERPA_HYBRID_INFO, SHERPA_ONLINE_INFO, SHERPA_WHISPER_INFO, REMOTE_OPENAI_INFO } from './engine-infos';

/** A slot's model id resolved to its definition. `NO_MODEL` is an empty slot.
 *  An id the registry no longer knows (a stale config) falls back to the
 *  machine's default preset for that slot. */
function slotModel(modelId: string, fallbackId: string): ModelDef | null {
  if (modelId === NO_MODEL) return null;
  const found = getModel(modelId);
  if (found) return found;
  if (fallbackId === NO_MODEL) return null;
  return getModel(fallbackId) ?? null;
}

/** The Best preset's refinement model for a language: what an on-device
 *  selection falls back to when it would otherwise run no model at all. */
function accurateDefault(language: string): ModelDef | null {
  return getModel(presetModels('accurate', language).modelId) ?? null;
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
 * two-slot hybrid: a LIVE model (a streaming transducer or a chunked offline
 * model) and a FINAL model (an offline model, or none). A preset names both
 * through the shared table (`dictation-presets.ts`); Custom takes them from the
 * user's dropdowns. Cloud keeps the local live preview and routes the final to
 * the remote endpoint.
 */
export function selectEngine(
  profile: DictationHardwareProfile,
  config: DictationConfig,
): EngineSelection {
  const tier = selectTier(profile);
  const isRemote = (config.engineMode ?? 'auto') === 'remote';
  const requestedLanguage = config.language ?? 'en';

  const slots = resolveDictationSlots(config, tier);
  const fallback = presetModels(TIER_DEFAULT_PRESET[tier], requestedLanguage);
  const live = slotModel(slots.liveModelId, fallback.liveModelId);
  let final: ModelDef | null = isRemote ? null : slotModel(slots.modelId, fallback.modelId);
  // On-device must always carry at least one slot.
  if (!isRemote && !live && !final) final = accurateDefault(requestedLanguage);

  // Clamp the language to what the running local models support. Remote final does
  // not constrain it (the endpoint handles its own languages), so only the live +
  // local-final slots are considered.
  const language = resolveLanguage(requestedLanguage, [live, isRemote ? null : final]);

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
 * True when the live model writes all caps (the Zipformer), so the text a
 * session commits can be that model's own: with no refinement, and also with
 * one, since `HybridEngine` commits the live text when the refinement model is
 * not ready in time or its final (the cloud's included) fails. The renderer
 * recases such a final only in the all-caps shape (`toPreviewCase`'s guard),
 * so a refined, punctuated final still passes as written. With any other live
 * model no final is recased, and a cased "GPU" or "OK" is typed as written.
 */
export function finalNeedsSentenceCase(selected: EngineSelection): boolean {
  const live = selected.models.find((model) => model.id === selected.liveModelId);
  return live?.writesAllCaps === true;
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
    selected.liveModelId ?? NO_MODEL,
    selected.finalModelId ?? NO_MODEL,
    // Every engine fixes its language when it is built (Whisper in its config,
    // Nemotron 3.5 and Cohere on each stream), so each language is a distinct
    // warm engine (the model files are shared/cached on disk).
    selected.language,
    config.remote?.url ?? '',
    config.remote?.apiKey ?? '',
    config.remote?.model ?? '',
  ].join('|');
}
