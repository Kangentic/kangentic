import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquare, Sparkles, Check, RotateCcw, Network } from 'lucide-react';
import { Select, DownloadProgressBar, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardChoiceRow, CardTile, CardToggleRow } from '../settings-card';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../../SettingText';
import { settingProps } from '../settings-registry';
import { useProjectStore } from '../../../stores/project-store';
import { useConfigStore } from '../../../stores/config-store';
import { useAgentCapabilityResolution } from '../../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows, useModelDisplayNames } from '../../../hooks/useKnownModels';
import { ModelCombobox } from '../../dialogs/ModelCombobox';
import { Combobox } from '../../dialogs/Combobox';
import { resolveAnswerAgent } from '../../../../shared/answer-agent';
import { EMBEDDING_MODELS } from '../../../../shared/embedding-models';
import type { AppConfig, MemoryStatus, MemoryAcceleration } from '../../../../shared/types';

/**
 * Settings > Search (tab id `memory`). GLOBAL/shared scope (below the settings
 * separator, next to Dictation - both are on-device, keyless, model-backed AI
 * features). Controls the local index over agent conversation transcripts that
 * powers Quick Find (humans), the Knowledge Graph, and the kangentic_search MCP
 * tool (agents). Indexing is on by default; semantic search is an opt-in layer
 * on top, and answers ride on semantic search.
 */

/** A platform-level note for the semantic layer (only when it cannot run
 *  here). The model card carries the ready/downloading state. */
function semanticPlatformNote(status: MemoryStatus | null): string | null {
  if (!status) return null;
  if (status.semantic === 'lexical') {
    return status.vecError
      ? `Vector search is unavailable - showing keyword matches. (${status.vecError})`
      : 'Vector search is unavailable on this platform - showing keyword matches.';
  }
  if (status.semantic === 'error') {
    return status.workerError
      ? `Semantic search failed to start - showing keyword matches. (${status.workerError})`
      : 'Semantic search failed to start - showing keyword matches.';
  }
  return null;
}

export function MemoryTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  // Default on when unset (matches DEFAULT_CONFIG.memory.indexingEnabled).
  const indexingEnabled = globalConfig.memory?.indexingEnabled ?? true;
  // Default off when unset (matches DEFAULT_CONFIG.memory.semanticEnabled).
  const semanticEnabled = globalConfig.memory?.semanticEnabled ?? false;
  // Default model when unset (matches DEFAULT_CONFIG.memory.embeddingModel).
  const embeddingModelId = globalConfig.memory?.embeddingModel ?? 'bge-base';
  // Default acceleration when unset (matches DEFAULT_CONFIG.memory.acceleration).
  const acceleration = globalConfig.memory?.acceleration ?? 'auto';
  // Installed agents that declare `answerFromContext`. Read from the capability
  // rather than a hardcoded list, per `agent-adapters-boundary.md`.
  const agentList = useConfigStore((state) => state.agentList);
  const answerCapableAgents = agentList
    .filter((agent) => agent.found && agent.supportsAnswerFromContext);
  const configuredAnswerAgent = globalConfig.memory?.answerAgent ?? null;
  /**
   * The chosen answering agent, resolved through the SAME rule main uses: the
   * configured one, or nothing. There is no project fallback, so an unset row
   * reads as unset, and asking before it is set brings the user here.
   */
  const chosenAnswerAgent = useMemo(
    () => resolveAnswerAgent({ agents: agentList, configured: configuredAnswerAgent, requireFound: true }),
    [agentList, configuredAnswerAgent],
  );
  const chosenAgentName = chosenAnswerAgent?.name ?? null;
  const { models: answerModels, effortLevels: answerEffortLevels } = useAgentCapabilityResolution(chosenAgentName);
  const answerModelContextWindows = useModelContextWindows(chosenAgentName);
  const answerModelDisplayNames = useModelDisplayNames(chosenAgentName);
  // Whether this agent's ANSWER run takes a model, as its adapter declares it.
  // When it does, the model is required: a question never runs on a default
  // nobody chose.
  const answerTakesModel = chosenAnswerAgent?.answerCapabilities?.model === true;
  // Effort shows wherever the answer run passes it on AND the CLI reports
  // levels. Unset runs at the adapter's recommended level, shown as the
  // placeholder, so leaving it alone is a choice the user can see.
  const answerTakesEffort = chosenAnswerAgent?.answerCapabilities?.effort === true && answerEffortLevels.length > 0;
  const recommendedEffort = chosenAnswerAgent?.answerCapabilities?.defaultEffort;
  const answerEffortDefault = recommendedEffort && answerEffortLevels.includes(recommendedEffort) ? recommendedEffort : null;

  // Poll the semantic-layer status while the feature is on so the model-download
  // progress and readiness update live. Cleared on unmount / when turned off.
  // Derived to "no status" while the feature is off, and reset on the enable
  // edge during render (React's "adjusting state when a prop changes"
  // pattern), so a stale status from an earlier enable never shows before the
  // first poll lands. No effect sets state to clear anything.
  const [polledStatus, setStatus] = useState<MemoryStatus | null>(null);
  const [seenSemanticEnabled, setSeenSemanticEnabled] = useState(semanticEnabled);
  if (semanticEnabled !== seenSemanticEnabled) {
    setSeenSemanticEnabled(semanticEnabled);
    if (semanticEnabled) setStatus(null);
  }
  const status = semanticEnabled ? polledStatus : null;
  useEffect(() => {
    if (!semanticEnabled) return;
    let active = true;
    const poll = () => {
      window.electronAPI.memory
        .getStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => undefined);
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [semanticEnabled]);

  const platformNote = semanticPlatformNote(status);
  const model = status?.model ?? null;

  // "Rebuild index" recovery: purge + re-sweep the current project. Per-project,
  // so it only appears when a project is open and indexing is on.
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const [rebuilding, setRebuilding] = useState(false);
  const handleRebuild = useCallback(() => {
    if (!currentProjectId) return;
    setRebuilding(true);
    window.electronAPI.memory
      .rebuildIndex(currentProjectId)
      .catch(() => undefined)
      // The purge resolves quickly; the sweep continues in the background, so
      // this is just brief button feedback.
      .finally(() => window.setTimeout(() => setRebuilding(false), 1200));
  }, [currentProjectId]);

  const semanticReady = indexingEnabled && semanticEnabled;

  return (
    <div className="space-y-4">
      {/* Three cards, one per feature, each holding the settings that depend
          on it: indexing, then semantic search (which needs indexing), then
          answers (which need semantic search, since the graph does). */}
      <SettingsCard
        icon={<MessageSquare size={16} />}
        {...settingProps('memory.indexingEnabled')}
        checked={indexingEnabled}
        onChange={(value) => updateGlobal({ memory: { indexingEnabled: value } })}
      >
        {/* Per-project, so it only appears with a project open. It is a
            non-destructive re-parse; a Search quality change re-embeds on its
            own, so this is for a conversation search should find and does not. */}
        {indexingEnabled && currentProjectId ? (
          <CardTile className="flex items-center justify-between gap-3" testId="memory-rebuild-row">
            <div className="min-w-0">
              <div className={SETTING_LABEL_CLASS}>Rebuild this project&apos;s index</div>
              <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>
                Only needed if search misses a conversation.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRebuild}
              disabled={rebuilding}
              data-testid="memory-rebuild-index"
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge-input bg-surface-control px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg disabled:opacity-50"
            >
              <RotateCcw size={13} className={rebuilding ? 'animate-spin' : undefined} />
              {rebuilding ? 'Rebuilding...' : 'Rebuild'}
            </button>
          </CardTile>
        ) : null}
      </SettingsCard>

      <SettingsCard
        icon={<Sparkles size={16} />}
        {...settingProps('memory.semanticEnabled')}
        searchIds={['memory.embeddingModel', 'memory.acceleration']}
        checked={semanticEnabled}
        onChange={(value) => updateGlobal({ memory: { semanticEnabled: value } })}
        requirement={indexingEnabled ? undefined : 'Needs indexing'}
      >
        {/* Gated on indexingEnabled too, so turning indexing off (which
            disables the semantic switch) hides these rather than leaving them
            interactive with no way to switch semantic back off. */}
        {semanticReady ? (
          <>
            <CardRow {...settingProps('memory.embeddingModel')}>
              <Select
                value={embeddingModelId}
                onChange={(event) => updateGlobal({ memory: { embeddingModel: event.target.value } })}
                data-testid="embedding-model-select"
              >
                {EMBEDDING_MODELS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.tierLabel}
                  </option>
                ))}
              </Select>
              {/* One status line under the dropdown that picks the model. */}
              {model ? <EmbeddingModelStatus model={model} activeBackend={status?.activeBackend ?? null} /> : null}
            </CardRow>

            <CardChoiceRow
              {...settingProps('memory.acceleration')}
              options={[
                { value: 'auto', label: 'Auto', testId: 'memory-acceleration-auto' },
                { value: 'gpu', label: 'GPU', testId: 'memory-acceleration-gpu' },
                { value: 'cpu', label: 'CPU', testId: 'memory-acceleration-cpu' },
              ]}
              value={acceleration}
              onChange={(value: MemoryAcceleration) => updateGlobal({ memory: { acceleration: value } })}
              testId="memory-acceleration-choice"
            />

            {platformNote ? (
              <CardTile className="text-xs text-fg-muted" testId="semantic-status">
                {platformNote}
              </CardTile>
            ) : null}
          </>
        ) : null}
      </SettingsCard>

      {/* Only the agents that can actually answer. An agent with no
          `answerFromContext` is not a choice, it is a way to turn Ask off by
          accident - the same rule the dead facet rows and the colour modes
          follow. The card ALWAYS shows, so the feature is visible before it is
          usable: until its prerequisites are met it is dimmed, with a tag
          naming the one it depends on directly (semantic search, then an
          agent that can answer), exactly as the Semantic search card dims with
          "Needs indexing". Its description never changes, and its rows appear
          once nothing is missing. Named for the feature people know from the title bar and
          Quick Find, so its rows can be plain Agent, Model and Effort. */}
      <SettingsCard
        icon={<Network size={16} />}
        label="Knowledge Graph"
        description="The agent that answers the questions you ask in the graph."
        searchIds={['memory.answerAgent', 'memory.answerModel', 'memory.answerEffort', 'memory.taskDigests']}
        requirement={!semanticReady
          ? 'Needs semantic search'
          : answerCapableAgents.length === 0
            ? 'Needs an answering agent'
            : undefined}
        testId="knowledge-graph-card"
      >
        {semanticReady && answerCapableAgents.length > 0 ? (
          <>
              {/* Starts EMPTY. The user's rule: the agent and model are one
                  explicit global choice, never assumed from a project. So there
                  is no default here to inherit and no "follow the project"
                  option; until something is picked, the Knowledge Graph sends a
                  question to this row instead of running it. */}
              {/* The same three controls as Settings > Agent's Project Defaults
                  and the column manager: Combobox, ModelCombobox, Combobox. No
                  Permissions: an answer run is read-only by construction, so a
                  permission choice would be one the run must ignore. */}
              <CardRow {...settingProps('memory.answerAgent')}>
                <Combobox
                  value={chosenAnswerAgent?.name ?? ''}
                  onChange={(next) => updateGlobal({
                    memory: {
                      answerAgent: next === '' ? null : next,
                      // A model id and an effort level belong to ONE CLI -
                      // Claude's `haiku` means nothing to Codex - so changing
                      // the agent clears both rather than carrying a flag the
                      // new agent will reject.
                      answerModel: null,
                      answerEffort: null,
                    },
                  })}
                  options={answerCapableAgents.map((agent) => ({ value: agent.name, label: agent.displayName }))}
                  placeholder="Choose an agent"
                  placeholderVariant="muted"
                  allowClear={false}
                  testId="memory-answer-agent"
                />
              </CardRow>

              {/* Rendered once the chosen agent's answer run takes a model, and
                  REQUIRED then: there is no "agent default" to fall back on, for
                  the same reason there is no default agent. */}
              {answerTakesModel ? (
                <CardRow {...settingProps('memory.answerModel')}>
                  <ModelCombobox
                    value={globalConfig.memory?.answerModel ?? ''}
                    onChange={(next) => updateGlobal({
                      memory: { answerModel: next === '' ? null : next },
                    })}
                    availableModels={answerModels}
                    placeholder="Choose a model"
                    placeholderVariant="muted"
                    testId="memory-answer-model"
                    onOpen={() => useConfigStore.getState().rescanModels()}
                    contextWindows={answerModelContextWindows}
                    modelDisplayNames={answerModelDisplayNames}
                  />
                </CardRow>
              ) : null}

              {/* Optional, unlike the model: unset runs at the recommended level,
                  shown as the placeholder, and clearing a pick returns to it.
                  Plain "low", not "low (default)": the resolved placeholder
                  styling already says it is what runs when nothing is picked. */}
              {answerTakesEffort ? (
                <CardRow {...settingProps('memory.answerEffort')}>
                  <Combobox
                    value={globalConfig.memory?.answerEffort ?? ''}
                    onChange={(next) => updateGlobal({
                      memory: { answerEffort: next === '' ? null : next },
                    })}
                    options={answerEffortLevels.map((level) => ({ value: level, label: level }))}
                    placeholder={answerEffortDefault ?? 'Agent default'}
                    placeholderVariant={answerEffortDefault ? 'resolved' : 'muted'}
                    testId="memory-answer-effort"
                  />
                </CardRow>
              ) : null}

              {/* Written by the agent chosen above, so offered once there is one.
                  On unless turned off: it spends calls, which is why it is a row
                  at all rather than always on. */}
              {chosenAnswerAgent ? (
                <CardToggleRow
                  {...settingProps('memory.taskDigests')}
                  checked={globalConfig.memory?.taskDigests ?? true}
                  onChange={(value) => updateGlobal({ memory: { taskDigests: value } })}
                />
              ) : null}
          </>
        ) : null}
      </SettingsCard>
    </div>
  );
}

/**
 * The chosen search model's state, as one line under Search quality: ready
 * (with its size and where it runs), downloading (with progress), failed, or
 * waiting to download.
 */
function EmbeddingModelStatus({ model, activeBackend }: { model: NonNullable<MemoryStatus['model']>; activeBackend: string | null }) {
  if (model.state === 'ready') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-fg-muted" data-testid="embedding-model-card">
        <Check size={13} className="flex-shrink-0 text-emerald-500" aria-hidden="true" />
        <span data-testid="embedding-model-ready">
          Ready: {model.displayName}, {model.approxSizeMb} MB{activeBackend ? `, running on ${activeBackend}` : ''}
        </span>
      </div>
    );
  }
  if (model.state === 'downloading') {
    const percent = Math.min(100, Math.round((model.progress ?? 0) * 100));
    return (
      <div className="text-xs text-fg-muted" data-testid="embedding-model-card">
        Downloading {model.displayName}, {percent}%
        <DownloadProgressBar percent={(model.progress ?? 0) * 100} />
      </div>
    );
  }
  if (model.state === 'error') {
    return (
      <div className="text-xs text-red-400" data-testid="embedding-model-card">
        {model.displayName} failed to download.
      </div>
    );
  }
  return (
    <div className="text-xs text-fg-muted" data-testid="embedding-model-card">
      {model.displayName}, {model.approxSizeMb} MB, downloads on its own.
    </div>
  );
}
