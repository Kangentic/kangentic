import { describe, it, expect } from 'vitest';
import {
  DICTATION_PRESETS,
  NO_MODEL,
  PRESET_MODEL_IDS,
  TIER_DEFAULT_PRESET,
  effectiveMode,
  presetModels,
  resolveDictationSlots,
} from '../../src/shared/dictation-presets';
import { DICTATION_LANGUAGES } from '../../src/shared/dictation-languages';
import { getModel, isOfflineModel, modelLanguages } from '../../src/main/transcription/models/model-registry';
import type { DictationConfig } from '../../src/shared/types';

/**
 * The preset table both processes read. A preset is a name main resolves each
 * session, so a model id it names that the registry lacks, or that cannot
 * transcribe the language, would surface only when a user dictates.
 */
describe('presetModels', () => {
  it('runs the measured English ladder', () => {
    expect(presetModels('fast', 'en')).toEqual({ liveModelId: 'streaming-zipformer-en', modelId: NO_MODEL });
    expect(presetModels('balanced', 'en')).toEqual({ liveModelId: 'parakeet-tdt-0.6b-v3', modelId: NO_MODEL });
    expect(presetModels('accurate', 'en')).toEqual({ liveModelId: 'nemotron-streaming-0.6b-en', modelId: 'parakeet-tdt-0.6b-v3' });
  });

  it('runs Parakeet v3 for a European language it covers', () => {
    expect(presetModels('fast', 'de')).toEqual({ liveModelId: 'whisper-base-multi', modelId: NO_MODEL });
    expect(presetModels('balanced', 'de')).toEqual({ liveModelId: 'parakeet-tdt-0.6b-v3', modelId: NO_MODEL });
    expect(presetModels('accurate', 'de')).toEqual({ liveModelId: 'nemotron-3.5-streaming-0.6b', modelId: 'parakeet-tdt-0.6b-v3' });
  });

  it('runs Nemotron 3.5 and Whisper small for a language Parakeet v3 does not cover', () => {
    expect(presetModels('balanced', 'ja')).toEqual({ liveModelId: 'nemotron-3.5-streaming-0.6b', modelId: NO_MODEL });
    expect(presetModels('accurate', 'ja')).toEqual({ liveModelId: 'nemotron-3.5-streaming-0.6b', modelId: 'whisper-small-multi' });
  });

  it('names only registered models, each covering the language and fit for its slot', () => {
    for (const preset of DICTATION_PRESETS) {
      for (const { code } of DICTATION_LANGUAGES) {
        const { liveModelId, modelId } = presetModels(preset, code);
        const live = getModel(liveModelId);
        expect(live, `${preset} ${code} live ${liveModelId}`).toBeDefined();
        expect(live!.liveCapable).toBe(true);
        expect(modelLanguages(live!)).toContain(code);
        if (modelId !== NO_MODEL) {
          const refinement = getModel(modelId);
          expect(refinement, `${preset} ${code} refinement ${modelId}`).toBeDefined();
          expect(isOfflineModel(refinement!)).toBe(true);
          expect(modelLanguages(refinement!)).toContain(code);
        }
      }
    }
  });

  it('lists only ids the registry knows', () => {
    for (const id of Object.values(PRESET_MODEL_IDS)) expect(getModel(id), id).toBeDefined();
  });
});

describe('TIER_DEFAULT_PRESET', () => {
  it('gives a capable machine Best and a low-end one Light', () => {
    expect(TIER_DEFAULT_PRESET['accurate-base']).toBe('accurate');
    expect(TIER_DEFAULT_PRESET['streaming-tiny']).toBe('fast');
  });
});

describe('effectiveMode', () => {
  const config = (overrides: Partial<DictationConfig>): DictationConfig => ({ language: 'en', ...overrides });

  it('reads a saved mode as it is', () => {
    expect(effectiveMode(config({ mode: 'balanced', liveModelId: 'whisper-tiny-en' }), 'accurate-base')).toBe('balanced');
    expect(effectiveMode(config({ mode: 'custom' }), 'accurate-base')).toBe('custom');
  });

  it('gives a config that picks no models the machine\'s default preset', () => {
    expect(effectiveMode(config({}), 'accurate-base')).toBe('accurate');
    expect(effectiveMode(config({ liveModelId: null, modelId: null }), 'streaming-tiny')).toBe('fast');
  });

  it('reads a pair the current lineup writes as its preset', () => {
    expect(effectiveMode(config(presetModels('balanced', 'en')), 'accurate-base')).toBe('balanced');
  });

  // A config saved before `mode` existed holds the pair its preset wrote then;
  // reading it as that preset is what moves it onto the current lineup.
  it('reads a pair the old English presets wrote as that preset', () => {
    expect(effectiveMode(config({ liveModelId: 'streaming-zipformer-en', modelId: 'parakeet-tdt-0.6b-en' }), 'accurate-base')).toBe('accurate');
    expect(effectiveMode(config({ liveModelId: 'parakeet-tdt-0.6b-en', modelId: NO_MODEL }), 'accurate-base')).toBe('balanced');
  });

  it('reads any other pair as custom', () => {
    expect(effectiveMode(config({ liveModelId: 'whisper-tiny-en', modelId: 'whisper-medium-en' }), 'accurate-base')).toBe('custom');
  });
});

describe('resolveDictationSlots', () => {
  it('resolves a preset through the table, ignoring the ids it saved', () => {
    const config: DictationConfig = { mode: 'accurate', language: 'en', liveModelId: 'streaming-zipformer-en', modelId: 'parakeet-tdt-0.6b-en' };
    expect(resolveDictationSlots(config, 'accurate-base')).toEqual(presetModels('accurate', 'en'));
  });

  it('keeps Custom\'s ids', () => {
    const config: DictationConfig = { mode: 'custom', language: 'en', liveModelId: 'whisper-tiny-en', modelId: 'cohere-transcribe-2b' };
    expect(resolveDictationSlots(config, 'accurate-base')).toEqual({ liveModelId: 'whisper-tiny-en', modelId: 'cohere-transcribe-2b' });
  });

  it('fills a Custom slot left unset from the machine\'s default preset', () => {
    const config: DictationConfig = { mode: 'custom', language: 'en', liveModelId: 'whisper-tiny-en' };
    expect(resolveDictationSlots(config, 'streaming-tiny')).toEqual({ liveModelId: 'whisper-tiny-en', modelId: NO_MODEL });
    expect(resolveDictationSlots(config, 'accurate-base')).toEqual({ liveModelId: 'whisper-tiny-en', modelId: 'parakeet-tdt-0.6b-v3' });
  });
});
