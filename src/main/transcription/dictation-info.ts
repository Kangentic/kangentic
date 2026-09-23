import type {
  DictationConfig,
  DictationHardwareProfile,
  DictationInfo,
  DictationModelOption,
} from '../../shared/types';
import { selectTier } from './hardware/select-tier';
import { listEngineInfos, selectEngine } from './engines/engine-selection';
import { finalCapableModels, isOfflineModel, liveCapableModels, modelLanguages, type ModelDef } from './models/model-registry';

/**
 * The settings panel's dictation snapshot, minus the worker's crash state, for
 * a given machine, config, and set of cached models.
 *
 * PURE, and importing only pure modules, on purpose. `TranscriptionService.getInfo`
 * feeds it the detected hardware and the model cache on disk; the web demo's
 * sample install (tests/captures/helpers/demo-dataset.ts) feeds it a seeded
 * machine, so the models its Dictation tab lists are the ones main would list
 * rather than a copy that can drift.
 */
export function buildDictationInfo(
  profile: DictationHardwareProfile,
  config: DictationConfig,
  installedModels: string[],
): Omit<DictationInfo, 'workerUnavailable' | 'workerError'> {
  const selected = selectEngine(profile, config);
  // For the on-device hybrid the set is [streaming Zipformer, accurate model];
  // the accurate model is the one the user picks, so surface it (not models[0],
  // which is the always-present live model). Streaming-only / cloud have no
  // offline model and fall back to the first (the Zipformer live model).
  const primary = primaryModel(selected.models);
  const finals = finalCapableModels().map(toModelOption);
  return {
    hardware: profile,
    tier: selectTier(profile),
    selectedEngineId: selected.id,
    engines: listEngineInfos(),
    installedModels,
    selectedModelId: primary?.id ?? null,
    selectedModelSizeMb: selected.models.length > 0
      ? selected.models.reduce((sum, model) => sum + model.approxSizeMb, 0)
      : null,
    availableModels: finals,
    liveModels: liveCapableModels().map(toModelOption),
    finalModels: finals,
    selectedLiveModelId: selected.liveModelId,
    selectedFinalModelId: selected.finalModelId,
  };
}

/** The accurate (offline) model when present, else the first model in the set
 *  (the streaming Zipformer for streaming-only / cloud). The user-meaningful one. */
export function primaryModel(models: ModelDef[]): ModelDef | undefined {
  return models.find(isOfflineModel) ?? models[0];
}

function toModelOption(model: ModelDef): DictationModelOption {
  return {
    id: model.id,
    displayName: model.displayName,
    sizeMb: model.approxSizeMb,
    engineKind: model.engineKind,
    languages: modelLanguages(model),
  };
}
