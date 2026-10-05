import type { DictationConfig, DictationEngineTier } from './types';
import { PARAKEET_V3_LANGUAGE_CODES } from './dictation-languages';

/**
 * The dictation presets, as one table both processes read: main resolves a
 * session's models from it (`engine-selection.ts`), and the Dictation tab
 * shows and switches presets with it.
 *
 * A preset is a NAME, not a saved pair of model ids. Main resolves it against
 * this table each time, so a user on a preset follows the lineup when it
 * changes, and the next launch downloads the new models like a first install.
 * Custom is the only mode that keeps the ids the user picked.
 *
 * The stored values (`fast`, `balanced`, `accurate`) predate the labels and stay
 * as they are, so saved configs keep reading; only `DICTATION_PRESET_LABELS`
 * changes what the tab shows.
 */
export type DictationPreset = 'accurate' | 'balanced' | 'fast';
export type DictationMode = DictationPreset | 'custom';

/** Best first, as the Mode control lists them. */
export const DICTATION_PRESETS: readonly DictationPreset[] = ['accurate', 'balanced', 'fast'];

export const DICTATION_PRESET_LABELS: Readonly<Record<DictationPreset, string>> = {
  accurate: 'Best',
  balanced: 'Balanced',
  fast: 'Light',
};

/** Config sentinel for an empty model slot (no live preview, or no refinement). */
export const NO_MODEL = 'none';

/** The model ids the presets name. Each must exist in main's model registry and
 *  cover the languages its preset uses it for (`tests/unit/dictation-presets.test.ts`). */
export const PRESET_MODEL_IDS = {
  zipformer: 'streaming-zipformer-en',
  nemotronEnglish: 'nemotron-streaming-0.6b-en',
  nemotronMultilingual: 'nemotron-3.5-streaming-0.6b',
  parakeetV3: 'parakeet-tdt-0.6b-v3',
  whisperBaseMulti: 'whisper-base-multi',
  whisperSmallMulti: 'whisper-small-multi',
} as const;

/** A resolved live + refinement pair. `NO_MODEL` marks an empty slot. */
export interface DictationSlotIds {
  liveModelId: string;
  modelId: string;
}

/**
 * The models a preset runs for a language. Each step up is more accurate, and
 * every step stays fast (the lineup's measurements: model-registry.ts):
 *
 *   Light     the smallest model, text the moment the key is released.
 *   Balanced  Parakeet v3 alone, re-decoding as you speak: its live text is
 *             the punctuated final text, from one model.
 *   Best      Nemotron's streaming preview, the most accurate words as you
 *             speak, then a Parakeet v3 pass on release for the punctuation
 *             Nemotron leaves off.
 *
 * Parakeet v3 covers English and nine European languages. For zh, ja, ko, ar
 * and tr, Balanced is Nemotron 3.5 alone and Best refines with Whisper small.
 */
export function presetModels(preset: DictationPreset, language: string): DictationSlotIds {
  const english = language === 'en';
  const parakeetCovers = PARAKEET_V3_LANGUAGE_CODES.includes(language);
  if (preset === 'fast') {
    return { liveModelId: english ? PRESET_MODEL_IDS.zipformer : PRESET_MODEL_IDS.whisperBaseMulti, modelId: NO_MODEL };
  }
  if (preset === 'balanced') {
    return { liveModelId: parakeetCovers ? PRESET_MODEL_IDS.parakeetV3 : PRESET_MODEL_IDS.nemotronMultilingual, modelId: NO_MODEL };
  }
  return {
    liveModelId: english ? PRESET_MODEL_IDS.nemotronEnglish : PRESET_MODEL_IDS.nemotronMultilingual,
    modelId: parakeetCovers ? PRESET_MODEL_IDS.parakeetV3 : PRESET_MODEL_IDS.whisperSmallMulti,
  };
}

/** The preset a machine gets before anyone picks one: Best on a capable
 *  machine, Light on a low-end one (`select-tier.ts`). */
export const TIER_DEFAULT_PRESET: Readonly<Record<DictationEngineTier, DictationPreset>> = {
  'accurate-base': 'accurate',
  'streaming-tiny': 'fast',
  remote: 'accurate',
};

/**
 * Pairs the English presets wrote before `mode` was saved, from the lineup
 * before Nemotron and Parakeet v3. A config holding one with no `mode` reads as
 * that preset, so it follows the current lineup. The non-English presets of
 * that time all wrote the same pair, so a config holding it names no one preset
 * and stays custom.
 */
const LEGACY_PRESET_PAIRS: ReadonlyArray<DictationSlotIds & { preset: DictationPreset }> = [
  { preset: 'fast', liveModelId: 'streaming-zipformer-en', modelId: NO_MODEL },
  { preset: 'balanced', liveModelId: 'parakeet-tdt-0.6b-en', modelId: NO_MODEL },
  { preset: 'accurate', liveModelId: 'streaming-zipformer-en', modelId: 'parakeet-tdt-0.6b-en' },
];

/**
 * The mode a config is in: its saved `mode`, else the machine's default preset
 * when it picks no models, else the preset whose pair it holds (current lineup
 * or legacy), else custom.
 */
export function effectiveMode(config: DictationConfig, tier: DictationEngineTier): DictationMode {
  if (config.mode) return config.mode;
  const liveModelId = config.liveModelId ?? null;
  const modelId = config.modelId ?? null;
  if (liveModelId === null && modelId === null) return TIER_DEFAULT_PRESET[tier];
  const language = config.language ?? 'en';
  for (const preset of DICTATION_PRESETS) {
    const pair = presetModels(preset, language);
    if (pair.liveModelId === liveModelId && pair.modelId === modelId) return preset;
  }
  const legacy = LEGACY_PRESET_PAIRS.find((pair) => pair.liveModelId === liveModelId && pair.modelId === modelId);
  return legacy?.preset ?? 'custom';
}

/**
 * The live and refinement model ids a config runs. A preset resolves through
 * `presetModels`; Custom keeps the saved ids. Ids are not checked against the
 * registry here (this module is shared); main falls back for an unknown one.
 *
 * Only an older config leaves a Custom slot unset, since the tab saves both ids
 * on the switch to Custom. Such a config ran the Zipformer for an empty live
 * slot, so it gets the Light preset's live model, never a larger download it
 * did not ask for. An empty refinement slot takes the machine's default
 * preset's, as it took the tier default before.
 */
export function resolveDictationSlots(config: DictationConfig, tier: DictationEngineTier): DictationSlotIds {
  const language = config.language ?? 'en';
  const mode = effectiveMode(config, tier);
  if (mode !== 'custom') return presetModels(mode, language);
  return {
    liveModelId: config.liveModelId ?? presetModels('fast', language).liveModelId,
    modelId: config.modelId ?? presetModels(TIER_DEFAULT_PRESET[tier], language).modelId,
  };
}
