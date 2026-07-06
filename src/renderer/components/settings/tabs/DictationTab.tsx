import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { useDictationStore } from '../../../stores/dictation-store';
import type {
  AppConfig,
  DictationConfig,
  DictationInfo,
} from '../../../../shared/types';
import { SectionHeader, SettingRow, SettingToggleRow, Select, DownloadProgressBar, INPUT_CLASS, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';
import { effectiveCombo } from '../../../../shared/keybindings';
import { formatCombo } from '../../../utils/keybindings';
import { orderLanguages } from '../../../../shared/dictation-languages';

const PUSH_TO_TALK_ACTION = 'dictation.pushToTalk';

// Relative accuracy per model. Speed is mostly determined by the machine, so the
// only figure worth comparing across models is accuracy (best -> basic).
const MODEL_ACCURACY: Record<string, { rank: number; label: string }> = {
  'parakeet-tdt-0.6b-en': { rank: 5, label: 'Best accuracy' },
  'whisper-distil-medium-en': { rank: 4, label: 'High accuracy' },
  'whisper-medium-en': { rank: 4, label: 'High accuracy' },
  'whisper-distil-small-en': { rank: 3, label: 'Good accuracy' },
  'whisper-small-en': { rank: 3, label: 'Good accuracy' },
  'moonshine-base-en': { rank: 3, label: 'Good accuracy' },
  'whisper-base-en': { rank: 2, label: 'Fair accuracy' },
  'whisper-tiny-en': { rank: 1, label: 'Basic accuracy' },
  'moonshine-tiny-en': { rank: 1, label: 'Basic accuracy' },
  'whisper-small-multi': { rank: 3, label: 'Good accuracy' },
  'whisper-base-multi': { rank: 2, label: 'Fair accuracy' },
};

function accuracyLabel(modelId: string): string {
  return MODEL_ACCURACY[modelId]?.label ?? '';
}

function accuracyRank(modelId: string): number {
  return MODEL_ACCURACY[modelId]?.rank ?? 0;
}

/**
 * Voice-to-text dictation settings. GLOBAL/shared scope (below the settings
 * separator). Two groups: Transcription (where it runs + which model, the
 * accuracy) and Input (how you trigger and insert it). Dictation always streams
 * a live preview as you talk, on-device or cloud.
 */
export function DictationTab({
  globalConfig,
  onOpenHotkeys,
}: {
  globalConfig: AppConfig;
  onOpenHotkeys?: () => void;
}) {
  const updateGlobal = useScopedUpdate('global');
  const dictation = globalConfig.dictation ?? {};
  const enabled = dictation.enabled ?? false;
  const engineMode = dictation.engineMode ?? 'auto';
  // Cloud is no longer a master mode: it is just the "Cloud endpoint" choice in the
  // Refinement dropdown, which flips engineMode to 'remote'. The master control is a
  // plain on/off toggle (`enabled`); the two model dropdowns drive local vs cloud.
  const isCloud = engineMode === 'remote';

  const pushToTalkOverride = globalConfig.hotkeyOverrides?.[PUSH_TO_TALK_ACTION];
  const pushToTalkCombo = effectiveCombo(
    PUSH_TO_TALK_ACTION,
    pushToTalkOverride ? { [PUSH_TO_TALK_ACTION]: pushToTalkOverride } : undefined,
  );
  const pushToTalkLabel = pushToTalkCombo ? formatCombo(pushToTalkCombo) : 'an unbound key';

  const infoConfig: DictationConfig = useMemo(
    () => ({
      enabled: dictation.enabled ?? false,
      engineMode,
      modelId: dictation.modelId ?? null,
      liveModelId: dictation.liveModelId ?? null,
      punctuation: dictation.punctuation ?? true,
      language: dictation.language ?? 'en',
    }),
    [dictation.enabled, engineMode, dictation.modelId, dictation.liveModelId, dictation.punctuation, dictation.language],
  );

  const [info, setInfo] = useState<DictationInfo | null>(null);
  const modelProgress = useDictationStore((state) => state.modelProgress);

  const refreshInfo = useCallback(() => {
    return window.electronAPI.dictation
      .getInfo(infoConfig)
      .then((result) => setInfo(result))
      .catch(() => setInfo(null));
  }, [infoConfig]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.dictation
      .getInfo(infoConfig)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [infoConfig]);

  const modelInstalled =
    !!info?.selectedModelId && info.installedModels.includes(info.selectedModelId);
  const isDownloading = modelProgress?.status === 'downloading';

  // Most accurate first, for each slot's dropdown.
  const sortedLiveModels = useMemo(
    () => (info ? [...info.liveModels].sort((first, second) => accuracyRank(second.id) - accuracyRank(first.id)) : []),
    [info],
  );
  const sortedFinalModels = useMemo(
    () => (info ? [...info.finalModels].sort((first, second) => accuracyRank(second.id) - accuracyRank(first.id)) : []),
    [info],
  );
  // The dropdowns show the resolved slot when the config leaves it at the default
  // (null), the explicit id when set, or 'none' for an empty slot.
  const liveValue = dictation.liveModelId ?? info?.selectedLiveModelId ?? '';
  // The Refinement dropdown shows 'cloud' when the final pass is the remote endpoint,
  // else the explicit/resolved offline model id, else 'none'.
  const finalValue = isCloud ? 'cloud' : (dictation.modelId ?? info?.selectedFinalModelId ?? 'none');

  // Language-first: the dropdown offers every language any model supports (the
  // union = English plus the multilingual set), independent of the current
  // selection. Picking a language re-points the models below to that language.
  const allLanguageCodes = [
    ...new Set(
      [...(info?.liveModels ?? []), ...(info?.finalModels ?? [])].flatMap((model) => model.languages),
    ),
  ];
  const languageOptions = orderLanguages(allLanguageCodes.length > 0 ? allLanguageCodes : ['en']);
  const languageValue = dictation.language ?? 'en';

  // The model dropdowns only offer models that can transcribe the chosen language
  // (English shows everything; a non-English language narrows to the multilingual
  // builds). The selected models always support the language because changing it
  // re-points them (see applyLanguage).
  const liveModelsForLanguage = sortedLiveModels.filter((model) => model.languages.includes(languageValue));
  const finalModelsForLanguage = sortedFinalModels.filter((model) => model.languages.includes(languageValue));

  // The Live + Refinement combo derived as a named preset (back-compat with
  // configs saved before the explicit `mode`; only the English presets match).
  const derivedMode =
    liveValue === 'streaming-zipformer-en' && finalValue === 'none'
      ? 'fast'
      : liveValue === 'parakeet-tdt-0.6b-en' && finalValue === 'none'
        ? 'balanced'
        : liveValue === 'streaming-zipformer-en' && finalValue === 'parakeet-tdt-0.6b-en'
          ? 'accurate'
          : 'custom';
  // The Mode is the explicit choice when set, else derived. A preset
  // (fast/balanced/accurate) LOCKS the two model dropdowns; Custom unlocks them.
  const mode = dictation.mode ?? derivedMode;
  const modelsLocked = mode !== 'custom';

  // Language-aware preset model combos: English uses the English-optimized models;
  // any other language uses the multilingual Whisper builds.
  const presetModels = (
    preset: 'fast' | 'balanced' | 'accurate',
    language: string,
  ): { liveModelId: string; modelId: string } => {
    const isEnglish = language === 'en';
    if (preset === 'fast') return { liveModelId: isEnglish ? 'streaming-zipformer-en' : 'whisper-base-multi', modelId: 'none' };
    if (preset === 'balanced') return { liveModelId: isEnglish ? 'parakeet-tdt-0.6b-en' : 'whisper-base-multi', modelId: 'none' };
    return {
      liveModelId: isEnglish ? 'streaming-zipformer-en' : 'whisper-base-multi',
      modelId: isEnglish ? 'parakeet-tdt-0.6b-en' : 'whisper-small-multi',
    };
  };
  const applyMode = (next: string): void => {
    // Presets are on-device, so selecting one also clears a Cloud refinement.
    if (next === 'fast' || next === 'balanced' || next === 'accurate') {
      updateGlobal({ dictation: { mode: next, engineMode: 'auto', ...presetModels(next, languageValue) } });
    } else {
      updateGlobal({ dictation: { mode: 'custom' } });
    }
  };
  // Changing the language re-points the models so they can transcribe it: re-apply
  // the active preset for the new language, or (in Custom) keep the models when
  // they already support it and otherwise fall back to that language's default.
  const applyLanguage = (nextLanguage: string): void => {
    if (mode === 'fast' || mode === 'balanced' || mode === 'accurate') {
      updateGlobal({ dictation: { language: nextLanguage, engineMode: 'auto', ...presetModels(mode, nextLanguage) } });
      return;
    }
    const liveOk =
      liveValue === 'none' ||
      (sortedLiveModels.find((model) => model.id === liveValue)?.languages.includes(nextLanguage) ?? false);
    const finalOk =
      finalValue === 'none' ||
      finalValue === 'cloud' ||
      (sortedFinalModels.find((model) => model.id === finalValue)?.languages.includes(nextLanguage) ?? false);
    if (liveOk && finalOk) {
      updateGlobal({ dictation: { language: nextLanguage } });
    } else {
      const fallback =
        nextLanguage === 'en'
          ? { liveModelId: 'streaming-zipformer-en', modelId: 'none' }
          : { liveModelId: 'whisper-base-multi', modelId: 'none' };
      updateGlobal({ dictation: { language: nextLanguage, engineMode: 'auto', ...fallback } });
    }
  };

  const selectedModelName = info?.selectedModelId
    ? [...info.finalModels, ...info.liveModels].find((model) => model.id === info.selectedModelId)?.displayName
      ?? (info.selectedModelId.includes('zipformer') ? 'Streaming Zipformer' : info.selectedModelId)
    : null;
  const isAutoModel = (dictation.modelId ?? null) === null;

  // The model auto-downloads in the background (prewarm on enable), which does
  // not re-fetch getInfo, so its installed-state snapshot would stay stale and
  // the row would keep reading "not ready". Re-fetch when a download finishes
  // (transitions from in-flight to done/cleared) so the status flips to "Ready".
  const wasDownloadingRef = useRef(false);
  useEffect(() => {
    const downloadingNow = modelProgress?.status === 'downloading';
    if (wasDownloadingRef.current && !downloadingNow) {
      void refreshInfo();
    }
    wasDownloadingRef.current = downloadingNow;
  }, [modelProgress, refreshInfo]);

  // Read-only status. The model downloads automatically (prewarm on enable) and
  // its live progress shows in the dictation popup, so there is no manual button
  // here - just the resolved model, its size, and whether it is ready.
  const modelDownloadRow = info?.selectedModelId ? (
    <div
      className="flex items-center justify-between gap-2 rounded border border-edge bg-surface-hover px-3 py-2 text-xs"
      data-testid="dictation-model-download"
    >
      <div className="min-w-0">
        <div className="text-fg-secondary">
          {isCloud ? 'Live preview model' : 'Model'}: <span className="text-fg">{selectedModelName}</span>
          {!isCloud && isAutoModel ? <span className="text-fg-faint"> (Auto)</span> : null}
          {info.selectedModelSizeMb ? (
            <span className="text-fg-faint"> (~{info.selectedModelSizeMb} MB)</span>
          ) : null}
        </div>
        {modelProgress?.status === 'error' ? (
          <div className="text-red-400">{modelProgress.error ?? 'Download failed'}</div>
        ) : modelInstalled ? (
          <div className="text-fg-faint">Cached for offline use.</div>
        ) : isDownloading ? (
          <>
            <div className="text-fg-faint">
              Downloading... {modelProgress && modelProgress.totalBytes > 0
                ? Math.min(100, Math.round((modelProgress.downloadedBytes / modelProgress.totalBytes) * 100))
                : 0}%
            </div>
            <DownloadProgressBar
              percent={modelProgress && modelProgress.totalBytes > 0
                ? (modelProgress.downloadedBytes / modelProgress.totalBytes) * 100
                : 0}
            />
          </>
        ) : (
          <div className="text-fg-faint">Downloads automatically when enabled.</div>
        )}
      </div>
      {modelInstalled ? (
        <span
          className="inline-flex items-center gap-1 whitespace-nowrap text-fg-muted"
          data-testid="dictation-model-ready"
        >
          <Check size={13} /> Ready
        </span>
      ) : null}
    </div>
  ) : null;

  return (
    <>
      {/* Master on/off. Cloud vs local is no longer a master choice: it is the
          "Cloud endpoint" option in the Refinement dropdown below. */}
      <SettingToggleRow
        {...settingProps('dictation.enabled')}
        checked={enabled}
        onChange={(value) => updateGlobal({ dictation: { enabled: value } })}
      />

      {/* Disabled (greyed, non-interactive) until dictation is turned on above, so
          the models and endpoint can only be edited once the feature is enabled. */}
      <div
        className={enabled ? 'space-y-4' : 'space-y-4 pointer-events-none opacity-50'}
        aria-disabled={!enabled}
      >
      {info && (
        <>
          {/* Language first (never locked by the preset): the models below adapt to
              it. English offers the full lineup; another language narrows them to
              the multilingual builds. */}
          <SettingRow {...settingProps('dictation.language')}>
            <Select
              value={languageValue}
              onChange={(event) => applyLanguage(event.target.value)}
              data-testid="dictation-language-select"
            >
              {languageOptions.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow
            label="Mode"
            description="Choose a preset to set the models below for you, or Custom to pick them yourself."
          >
            <Select
              value={mode}
              onChange={(event) => applyMode(event.target.value)}
              data-testid="dictation-preset-select"
            >
              <option value="accurate">Best accuracy</option>
              <option value="balanced">Balanced</option>
              <option value="fast">Fastest</option>
              <option value="custom">Custom</option>
            </Select>
          </SettingRow>
          <SettingRow
            label="Live model"
            description="Preview while you speak: streaming is instant, chunked is accurate."
          >
            <Select
              value={liveValue}
              onChange={(event) => updateGlobal({ dictation: { liveModelId: event.target.value } })}
              data-testid="dictation-live-model-select"
              disabled={modelsLocked}
            >
              {liveModelsForLanguage.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                  {accuracyLabel(model.id) ? ` - ${accuracyLabel(model.id)}` : ''}
                  {` (${model.sizeMb} MB)`}
                </option>
              ))}
              <option value="none">None</option>
            </Select>
          </SettingRow>
          <SettingRow
            label="Refinement model"
            description="Refines the live draft into the accurate result on release. None keeps the live text as-is."
          >
            <Select
              value={finalValue}
              onChange={(event) => {
                const value = event.target.value;
                // The Refinement dropdown is what drives local vs cloud: 'cloud' routes
                // the final pass to the remote endpoint; any model id keeps it on-device.
                if (value === 'cloud') updateGlobal({ dictation: { engineMode: 'remote', mode: 'custom' } });
                else updateGlobal({ dictation: { engineMode: 'auto', modelId: value } });
              }}
              data-testid="dictation-final-model-select"
              disabled={modelsLocked}
            >
              {finalModelsForLanguage.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                  {accuracyLabel(model.id) ? ` - ${accuracyLabel(model.id)}` : ''}
                  {` (${model.sizeMb} MB)`}
                </option>
              ))}
              <option value="none">None</option>
              <option value="cloud">Cloud endpoint</option>
            </Select>
          </SettingRow>
          {/* The Cloud refinement needs its endpoint. Only the final clip is sent here;
              the live preview always runs on-device. */}
          {isCloud && (
            <div className="ml-1 space-y-2 border-l border-edge pl-3" data-testid="dictation-cloud-fields">
              <p className="text-xs text-fg-faint">
                Sends the final clip to your OpenAI-compatible /v1/audio/transcriptions endpoint. The live preview stays on-device.
              </p>
              <input
                type="text"
                placeholder="https://api.example.com/v1/audio/transcriptions"
                value={dictation.remote?.url ?? ''}
                onChange={(event) => updateGlobal({ dictation: { remote: { url: event.target.value } } })}
                className={INPUT_CLASS}
              />
              <input
                type="password"
                placeholder="API key (optional)"
                value={dictation.remote?.apiKey ?? ''}
                onChange={(event) => updateGlobal({ dictation: { remote: { apiKey: event.target.value } } })}
                className={INPUT_CLASS}
              />
              <input
                type="text"
                placeholder="Model (optional, e.g. whisper-1)"
                value={dictation.remote?.model ?? ''}
                onChange={(event) => updateGlobal({ dictation: { remote: { model: event.target.value } } })}
                className={INPUT_CLASS}
              />
            </div>
          )}
          {modelDownloadRow && <div className="pb-1">{modelDownloadRow}</div>}
        </>
      )}

      <SettingToggleRow
        {...settingProps('dictation.punctuation')}
        checked={dictation.punctuation ?? true}
        onChange={(value) => updateGlobal({ dictation: { punctuation: value } })}
      />

      {/* Input: how you trigger and insert dictation. */}
      <SectionHeader label="Input" searchIds={['dictation.releaseBufferMs', 'dictation.autoSubmit']} />
      <SettingRow
        label="Push-to-talk"
        description={`Hold ${pushToTalkLabel} to record; release to insert the transcription.`}
      >
        <button
          type="button"
          onClick={onOpenHotkeys}
          title="Rebind in the Hotkeys settings"
          data-testid="dictation-rebind-cta"
          className="inline-flex items-center gap-2 whitespace-nowrap rounded border border-edge-input bg-surface px-2 py-1 text-xs text-fg-secondary transition-colors hover:border-accent hover:text-fg"
        >
          <span className="font-medium">{pushToTalkLabel}</span>
          <span className="inline-flex items-center gap-1 text-fg-faint">
            <Pencil size={12} /> Rebind
          </span>
        </button>
      </SettingRow>
      <SettingRow {...settingProps('dictation.releaseBufferMs')}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={500}
            step={50}
            value={dictation.releaseBufferMs ?? 250}
            onChange={(event) => updateGlobal({ dictation: { releaseBufferMs: Number(event.target.value) } })}
            aria-label="Release buffer"
            data-testid="dictation-release-buffer"
            className="h-1.5 w-40 cursor-pointer accent-[var(--kng-accent)]"
          />
          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg-secondary">
            {(dictation.releaseBufferMs ?? 250) === 0 ? 'Off' : `${dictation.releaseBufferMs ?? 250} ms`}
          </span>
        </div>
      </SettingRow>
      <SettingToggleRow
        {...settingProps('dictation.autoSubmit')}
        checked={dictation.autoSubmit ?? true}
        onChange={(value) => updateGlobal({ dictation: { autoSubmit: value } })}
      />
      </div>
    </>
  );
}
