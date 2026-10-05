import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Mic, Pencil } from 'lucide-react';
import { useDictationStore } from '../../../stores/dictation-store';
import type {
  AppConfig,
  DictationConfig,
  DictationInfo,
  DictationModelOption,
  DictationModelProgress,
} from '../../../../shared/types';
import { Select, SettingTextInput, useScopedUpdate } from '../shared';
import {
  SettingsCard, CardRow, CardToggleRow, CardChoiceRow, CardTile, CardSourceList, CardLinkRow, InfoTip,
  type CardSourceLineProps,
} from '../settings-card';
import { SETTING_LABEL_CLASS } from '../../SettingText';
import { settingProps } from '../settings-registry';
import { effectiveCombo } from '../../../../shared/keybindings';
import { formatCombo } from '../../../utils/keybindings';
import { orderLanguages } from '../../../../shared/dictation-languages';
import {
  DICTATION_PRESETS,
  DICTATION_PRESET_LABELS,
  NO_MODEL,
  effectiveMode,
  presetModels,
  type DictationMode,
  type DictationPreset,
} from '../../../../shared/dictation-presets';
import { licenseLinks } from '../../../../shared/model-licenses';

const PUSH_TO_TALK_ACTION = 'dictation.pushToTalk';

/** What each slot does: the Custom dropdowns and the model lines share them. */
const LIVE_MODEL_DESCRIPTION = 'Preview while you speak: streaming is instant, chunked is accurate.';
const REFINEMENT_MODEL_DESCRIPTION = 'Refines the live draft into the accurate result on release. None keeps the live text as-is.';

/** Most accurate first, for each slot's dropdown. */
function byAccuracy(models: DictationModelOption[]): DictationModelOption[] {
  return [...models].sort((first, second) => second.accuracyRank - first.accuracyRank);
}

/** A model's dropdown option: its name, how accurate it is, and its download.
 *  Short on purpose, so the native menu never widens past the field. */
function optionText(model: DictationModelOption): string {
  return `${model.displayName} - ${model.accuracyLabel} (${model.sizeMb} MB)`;
}

const percentOf = (downloaded: number | undefined, total: number | undefined): number =>
  downloaded !== undefined && total !== undefined && total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;

/** The Refinement dropdown's value for the cloud endpoint (it sets `engineMode`
 *  to `remote`, not a model id). */
const CLOUD_REFINEMENT = 'cloud';

/** A model id's option among the slots' lists, if any list offers it. */
function modelOption(info: DictationInfo, modelId: string | null): DictationModelOption | undefined {
  if (!modelId) return undefined;
  return info.liveModels.find((option) => option.id === modelId) ?? info.finalModels.find((option) => option.id === modelId);
}

/**
 * One slot's line in the model list: the model and its size once it is on
 * disk, its share over a track while it downloads, its size muted while it
 * waits its turn, and None for an empty slot. Switching dictation on starts the
 * download (prewarm on enable), so a model not on disk yet is queued, never a
 * separate waiting state.
 */
function modelLine({ label, description, modelId, info, progress, testId }: {
  label: string;
  description: string;
  modelId: string | null;
  info: DictationInfo;
  progress: DictationModelProgress | null;
  testId: string;
}): CardSourceLineProps {
  const base = { label, info: description, testId };
  if (modelId === CLOUD_REFINEMENT) return { ...base, value: 'Cloud endpoint' };
  const model = modelOption(info, modelId);
  if (!model) return { ...base, value: 'None', tone: 'muted' };
  const sized = `${model.displayName}, ${model.sizeMb} MB`;
  if (info.installedModels.includes(model.id)) return { ...base, value: sized, tone: 'ready' };
  // Why it failed (no space, no network) is what the user can act on: it rides
  // in the line's info tip, since a line holds one short value. The error names
  // the model that failed, so a model still waiting its turn stays queued.
  if (progress?.status === 'error' && progress.modelId === model.id) {
    return { ...base, info: progress.error ?? description, value: model.displayName, tone: 'caution', problem: 'Download failed' };
  }
  if (progress?.status === 'downloading' && progress.modelId === model.id) {
    const percent = percentOf(progress.modelDownloadedBytes, progress.modelTotalBytes);
    return { ...base, value: `${model.displayName}, ${percent}%`, percent, progressLabel: `${label} downloaded` };
  }
  return { ...base, value: sized, tone: 'muted' };
}

/**
 * Voice-to-text dictation settings. GLOBAL/shared scope (below the settings
 * separator). Two cards: Voice dictation (the switch, then how you trigger and
 * insert it) and Transcription (language, mode, models), both hidden while
 * dictation is off. Dictation always streams a live preview as you talk,
 * on-device or cloud.
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
      mode: dictation.mode,
      modelId: dictation.modelId ?? null,
      liveModelId: dictation.liveModelId ?? null,
      language: dictation.language ?? 'en',
    }),
    [dictation.enabled, engineMode, dictation.mode, dictation.modelId, dictation.liveModelId, dictation.language],
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

  // Most accurate first, for each slot's dropdown.
  const sortedLiveModels = useMemo(() => (info ? byAccuracy(info.liveModels) : []), [info]);
  const sortedFinalModels = useMemo(() => (info ? byAccuracy(info.finalModels) : []), [info]);
  // The dropdowns show the resolved slot when the config leaves it at the default
  // (null), the explicit id when set, or 'none' for an empty slot.
  const liveValue = dictation.liveModelId ?? info?.selectedLiveModelId ?? NO_MODEL;
  // The Refinement dropdown shows 'cloud' when the final pass is the remote endpoint,
  // else the explicit/resolved offline model id, else 'none'.
  const finalValue = isCloud ? CLOUD_REFINEMENT : (dictation.modelId ?? info?.selectedFinalModelId ?? NO_MODEL);

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

  // The explicit mode when saved, else derived: the machine's default preset when
  // no model is picked, the preset whose pair the config holds, or Custom. A
  // preset (Best/Balanced/Light) LOCKS the two model dropdowns; Custom unlocks them.
  const mode: DictationMode = info ? effectiveMode(infoConfig, info.tier) : (dictation.mode ?? 'accurate');
  const modelsLocked = mode !== 'custom';

  const applyMode = (next: DictationMode): void => {
    // Presets are on-device, so selecting one also clears a Cloud refinement. A
    // preset is a name main resolves each session, so it saves no model ids.
    if (next !== 'custom') {
      updateGlobal({ dictation: { mode: next, engineMode: 'auto' } });
      return;
    }
    // Custom opens on what was just running, not on ids an older preset saved.
    const running = mode === 'custom' ? null : presetModels(mode, languageValue);
    updateGlobal({ dictation: { mode: 'custom', ...(running ?? {}) } });
  };
  // Changing the language re-points the models so they can transcribe it: a
  // preset resolves its own models for the new language; Custom keeps the models
  // when they already support it and otherwise falls back to the Light preset's.
  const applyLanguage = (nextLanguage: string): void => {
    if (mode !== 'custom') {
      updateGlobal({ dictation: { language: nextLanguage, engineMode: 'auto' } });
      return;
    }
    const liveOk =
      liveValue === NO_MODEL ||
      (sortedLiveModels.find((model) => model.id === liveValue)?.languages.includes(nextLanguage) ?? false);
    const finalOk =
      finalValue === NO_MODEL ||
      finalValue === CLOUD_REFINEMENT ||
      (sortedFinalModels.find((model) => model.id === finalValue)?.languages.includes(nextLanguage) ?? false);
    if (liveOk && finalOk) {
      updateGlobal({ dictation: { language: nextLanguage } });
    } else {
      updateGlobal({ dictation: { language: nextLanguage, engineMode: 'auto', ...presetModels('fast', nextLanguage) } });
    }
  };

  // The model auto-downloads in the background (prewarm on enable), which does
  // not re-fetch getInfo, so its installed-state snapshot would stay stale and
  // the lines would keep reading "not ready". Re-fetch when a download finishes
  // (transitions from in-flight to done/cleared) so each line flips to ready.
  // Best downloads two models one after the other, so a move on to the next
  // model re-fetches too: the finished one reads ready, not queued, while the
  // second is still coming.
  const downloadingModelRef = useRef<string | null>(null);
  useEffect(() => {
    const downloadingModel = modelProgress?.status === 'downloading' ? modelProgress.modelId : null;
    if (downloadingModelRef.current !== null && downloadingModelRef.current !== downloadingModel) {
      void refreshInfo();
    }
    downloadingModelRef.current = downloadingModel;
  }, [modelProgress, refreshInfo]);

  // The two slots main resolved for this config: what runs, whatever the mode.
  const modelLines: CardSourceLineProps[] = info
    ? [
        modelLine({
          label: 'Live model',
          description: LIVE_MODEL_DESCRIPTION,
          modelId: info.selectedLiveModelId,
          info,
          progress: modelProgress,
          testId: 'dictation-live-model-line',
        }),
        modelLine({
          label: 'Refinement model',
          description: REFINEMENT_MODEL_DESCRIPTION,
          modelId: isCloud ? CLOUD_REFINEMENT : info.selectedFinalModelId,
          info,
          progress: modelProgress,
          testId: 'dictation-refinement-model-line',
        }),
      ]
    : [];
  // The licenses of the on-device models that run. A cloud refinement has none.
  const runningModels = info
    ? [info.selectedLiveModelId, isCloud ? null : info.selectedFinalModelId]
      .map((modelId) => modelOption(info, modelId))
      .filter((model): model is DictationModelOption => model !== undefined)
    : [];
  const licenses = licenseLinks(runningModels.map((model) => model.license));

  const pushToTalkDescription = 'Hold to record; release to insert the transcription. Rebind it in Hotkeys.';
  const modeDescription = 'A preset picks the live and refinement models for you. Custom lets you pick them.';

  return (
    <div className="space-y-4">
      {/* Master on/off. Cloud vs local is no longer a master choice: it is the
          "Cloud endpoint" option in the Refinement dropdown. Off means hidden,
          not greyed out: nothing below applies until dictation is on. */}
      <SettingsCard
        icon={<Mic size={16} />}
        {...settingProps('dictation.enabled')}
        // Its own rows, and while dictation is off the Transcription card's
        // settings too: that card is not rendered then, so a search for one of
        // them finds this switch. While it is on, that card answers for its own
        // settings, and listing them here would pull this card's rows into
        // their results.
        searchIds={[
          'dictation.releaseBufferMs',
          'dictation.autoSubmit',
          ...(enabled ? [] : ['dictation.language', 'dictation.remote']),
        ]}
        checked={enabled}
        onChange={(value) => updateGlobal({ dictation: { enabled: value } })}
      >
        {enabled ? (
          <>
            {/* Push-to-talk is a hotkey, rebound in Hotkeys. The row shows the
                current combo and takes you there. */}
            <CardTile className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className={SETTING_LABEL_CLASS}>Push-to-talk</span>
                <InfoTip label="Push-to-talk" text={pushToTalkDescription} />
              </div>
              <button
                type="button"
                onClick={onOpenHotkeys}
                title="Rebind in the Hotkeys settings"
                data-testid="dictation-rebind-cta"
                className="inline-flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded border border-edge-input bg-surface-control px-2 py-1 text-xs text-fg-secondary transition-colors hover:border-accent hover:text-fg"
              >
                <span className="font-medium">{pushToTalkLabel}</span>
                <span className="inline-flex items-center gap-1 text-fg-faint">
                  <Pencil size={12} /> Rebind
                </span>
              </button>
            </CardTile>
            <CardRow {...settingProps('dictation.releaseBufferMs')}>
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
            </CardRow>
            <CardToggleRow
              {...settingProps('dictation.autoSubmit')}
              checked={dictation.autoSubmit ?? true}
              onChange={(value) => updateGlobal({ dictation: { autoSubmit: value } })}
            />
          </>
        ) : null}
      </SettingsCard>

      {enabled ? (
        <SettingsCard
          icon={<AudioLines size={16} />}
          label="Transcription"
          description="Runs on this machine unless you choose a cloud refinement."
          searchIds={['dictation.language', 'dictation.remote']}
        >
          {info?.workerUnavailable ? (
            <CardTile className="text-xs text-red-400" testId="dictation-worker-unavailable">
              Dictation stopped after repeated crashes{info.workerError ? ` (${info.workerError})` : ''}. Restart Kangentic to try again.
            </CardTile>
          ) : null}
          {info ? (
            <>
              {/* Language first (never locked by the preset): the models adapt to
                  it. English offers the full lineup; another language narrows them
                  to the multilingual builds. */}
              <CardRow {...settingProps('dictation.language')}>
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
              </CardRow>
              <CardChoiceRow<DictationMode>
                label="Mode"
                description={modeDescription}
                options={[
                  ...DICTATION_PRESETS.map((preset: DictationPreset) => ({
                    value: preset,
                    label: DICTATION_PRESET_LABELS[preset],
                    testId: `dictation-preset-${preset}`,
                  })),
                  { value: 'custom', label: 'Custom', testId: 'dictation-preset-custom' },
                ]}
                value={mode}
                onChange={(next) => applyMode(next)}
                testId="dictation-preset-choice"
              />
              {modelsLocked ? null : (
                <>
                  <CardRow label="Live model" description={LIVE_MODEL_DESCRIPTION}>
                    <Select
                      value={liveValue}
                      onChange={(event) => updateGlobal({ dictation: { liveModelId: event.target.value } })}
                      data-testid="dictation-live-model-select"
                    >
                      {liveModelsForLanguage.map((model) => (
                        <option key={model.id} value={model.id}>
                          {optionText(model)}
                        </option>
                      ))}
                      <option value={NO_MODEL}>None</option>
                    </Select>
                  </CardRow>
                  <CardRow label="Refinement model" description={REFINEMENT_MODEL_DESCRIPTION}>
                    <Select
                      value={finalValue}
                      onChange={(event) => {
                        const value = event.target.value;
                        // The Refinement dropdown is what drives local vs cloud: 'cloud' routes
                        // the final pass to the remote endpoint; any model id keeps it on-device.
                        if (value === CLOUD_REFINEMENT) updateGlobal({ dictation: { engineMode: 'remote', mode: 'custom' } });
                        else updateGlobal({ dictation: { engineMode: 'auto', modelId: value } });
                      }}
                      data-testid="dictation-final-model-select"
                    >
                      {finalModelsForLanguage.map((model) => (
                        <option key={model.id} value={model.id}>
                          {optionText(model)}
                        </option>
                      ))}
                      <option value={NO_MODEL}>None</option>
                      <option value={CLOUD_REFINEMENT}>Cloud endpoint</option>
                    </Select>
                    {/* The cloud refinement needs its endpoint. Only the final clip
                        is sent; the live preview always runs on this machine. */}
                    {isCloud ? (
                      <div className="mt-1 space-y-2 border-l-2 border-edge pl-3" data-testid="dictation-cloud-fields">
                        <p className="text-xs text-fg-muted">
                          Only the final clip is sent. The live preview stays on this machine.
                        </p>
                        <SettingTextInput
                          placeholder="https://api.example.com/v1/audio/transcriptions"
                          value={dictation.remote?.url ?? ''}
                          onCommit={(nextUrl) => updateGlobal({ dictation: { remote: { url: nextUrl } } })}
                          ariaLabel="Cloud transcription endpoint"
                        />
                        <SettingTextInput
                          type="password"
                          placeholder="API key (optional)"
                          value={dictation.remote?.apiKey ?? ''}
                          onCommit={(nextApiKey) => updateGlobal({ dictation: { remote: { apiKey: nextApiKey } } })}
                          ariaLabel="Cloud transcription API key"
                        />
                        <SettingTextInput
                          placeholder="Model (optional, e.g. whisper-1)"
                          value={dictation.remote?.model ?? ''}
                          onCommit={(nextModel) => updateGlobal({ dictation: { remote: { model: nextModel } } })}
                          ariaLabel="Cloud transcription model"
                        />
                      </div>
                    ) : null}
                  </CardRow>
                </>
              )}
              {/* The models this setup runs and whether they are on disk, one line
                  per slot, under the rows that pick them. A stopped worker
                  downloads nothing, which the tile above already says. */}
              {!info.workerUnavailable ? <CardSourceList lines={modelLines} readOnly testId="dictation-model-lines" /> : null}
              {licenses.length > 0 ? (
                <CardLinkRow
                  label="License"
                  links={licenses}
                  onOpen={(href) => void window.electronAPI.shell.openExternal(href)}
                  testId="dictation-license"
                />
              ) : null}
            </>
          ) : null}
        </SettingsCard>
      ) : null}
    </div>
  );
}
