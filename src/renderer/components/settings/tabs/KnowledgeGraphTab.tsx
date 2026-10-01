import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, RotateCcw, Brain } from 'lucide-react';
import { Select, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardChoiceRow, CardTile, CardStatusRow, CardSourceList, type CardSourceLineProps } from '../settings-card';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../../SettingText';
import { settingProps } from '../settings-registry';
import { useConfigStore } from '../../../stores/config-store';
import { useToastStore } from '../../../stores/toast-store';
import { useAgentCapabilityResolution } from '../../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows, useModelDisplayNames } from '../../../hooks/useKnownModels';
import { ModelCombobox } from '../../dialogs/ModelCombobox';
import { Combobox } from '../../dialogs/Combobox';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { agentJobChoice, answerSetupGap, resolveAnswerAgent, taskSummariesOn } from '../../../../shared/answer-agent';
import { SUMMARY_BATCH_SIZE } from '../../../../shared/task-summaries';
import { EMBEDDING_MODELS } from '../../../../shared/embedding-models';
import { alwaysOnLine, codeLine, CODE_INFO, sourceRequirements, SUMMARIES_INFO, summariesLine } from './index-sources';
import type {
  AgentDetectionInfo, AppConfig, DeepPartial, KnowledgeGraphStatus, KnowledgeGraphAcceleration,
} from '../../../../shared/types';

/**
 * Settings > Knowledge Graph (tab id `knowledgeGraph`). GLOBAL/shared scope (below the
 * settings separator, next to Dictation - both are on-device, model-backed AI
 * features). Two cards, in setup order: the Knowledge Graph (one switch; the
 * local model that finds by meaning and draws the map, then the agent that
 * answers and writes the task summaries), and the Index it reads (one line per
 * source, and one Rebuild). The index also powers Quick Find (humans) and the
 * kangentic_search MCP tool (agents) by keyword. Indexing is on by default; the
 * Knowledge Graph (`knowledgeGraph.enabled`) is opt-in, since it downloads a model.
 */

/** A platform-level note for the semantic layer (only when it cannot run
 *  here). The model card carries the ready/downloading state. */
function semanticPlatformNote(status: KnowledgeGraphStatus | null): string | null {
  if (!status) return null;
  if (status.semantic === 'lexical') {
    return status.vecError
      ? `Vector search is unavailable - showing keyword matches. (${status.vecError})`
      : 'Vector search is unavailable on this platform - showing keyword matches.';
  }
  if (status.semantic === 'error') {
    return status.workerError
      ? `The local model failed to start - showing keyword matches. (${status.workerError})`
      : 'The local model failed to start - showing keyword matches.';
  }
  return null;
}

export function KnowledgeGraphTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  // Default on when unset (matches DEFAULT_CONFIG.knowledgeGraph.indexingEnabled).
  const indexingEnabled = globalConfig.knowledgeGraph?.indexingEnabled ?? true;
  // Default off when unset (matches DEFAULT_CONFIG.knowledgeGraph.enabled).
  const semanticEnabled = globalConfig.knowledgeGraph?.enabled ?? false;
  // Default model when unset (matches DEFAULT_CONFIG.knowledgeGraph.localModel).
  const embeddingModelId = globalConfig.knowledgeGraph?.localModel ?? 'bge-base';
  // Default acceleration when unset (matches DEFAULT_CONFIG.knowledgeGraph.acceleration).
  const acceleration = globalConfig.knowledgeGraph?.acceleration ?? 'auto';
  // Installed agents that declare `answerFromContext`. Read from the capability
  // rather than a hardcoded list, per `agent-adapters-boundary.md`. One agent
  // both answers and writes the task summaries: a summary batch is an answer
  // run with no tools.
  const agentList = useConfigStore((state) => state.agentList);
  const answerCapableAgents = useMemo(
    () => agentList.filter((agent) => agent.found && agent.supportsAnswerFromContext),
    [agentList],
  );
  const summariesOn = taskSummariesOn(globalConfig.knowledgeGraph);
  // On unless switched off, like the summaries: it waits for an agent, and its
  // switch stays usable so it can be turned off before the first fill runs.
  const codeOn = globalConfig.knowledgeGraph?.sourceCode !== false;
  const agentChoice = agentJobChoice(globalConfig.knowledgeGraph, 'answer');
  // What the agent still waits for, through the rule main applies before a
  // question or a summary pass.
  const agentSetup = answerSetupGap({
    agents: agentList,
    configured: agentChoice.agent,
    configuredModel: agentChoice.model,
    requireFound: true,
  });
  const updateKnowledgeGraph = useCallback(
    (patch: KnowledgeGraphPatch) => updateGlobal({ knowledgeGraph: patch }),
    [updateGlobal],
  );

  // Poll the index status while indexing is on, so the source lines, the
  // model download and a backfill update live. Cleared on unmount / when
  // turned off. Derived to "no status" while indexing is off, and reset on the
  // enable edge during render (React's "adjusting state when a prop changes"
  // pattern), so a stale status from an earlier enable never shows before the
  // first poll lands. No effect sets state to clear anything. Semantic search
  // is a dependency too, so switching it polls at once rather than a poll late.
  const [polledStatus, setStatus] = useState<KnowledgeGraphStatus | null>(null);
  const [seenIndexingEnabled, setSeenIndexingEnabled] = useState(indexingEnabled);
  if (indexingEnabled !== seenIndexingEnabled) {
    setSeenIndexingEnabled(indexingEnabled);
    if (indexingEnabled) setStatus(null);
  }
  const status = indexingEnabled ? polledStatus : null;
  useEffect(() => {
    if (!indexingEnabled) return;
    let active = true;
    const poll = () => {
      window.electronAPI.knowledgeGraph
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
  }, [indexingEnabled, semanticEnabled]);

  const platformNote = semanticPlatformNote(status);
  const model = semanticEnabled ? status?.model ?? null : null;

  // One Rebuild for every source in every project. It asks first only when it
  // will spend agent calls (task summaries written with another agent or
  // model); reading everything again is free, so otherwise it runs at once.
  const [rebuilding, setRebuilding] = useState(false);
  // While the plan is read the button is already committed, so a second click
  // cannot start a second rebuild.
  const [planning, setPlanning] = useState(false);
  const [rebuildAsk, setRebuildAsk] = useState<number | null>(null);
  const runRebuild = () => {
    setRebuildAsk(null);
    setRebuilding(true);
    window.electronAPI.knowledgeGraph
      .rebuildIndex()
      .catch(() => undefined)
      // The marks are made at once; the reading continues in the background,
      // so this is just brief button feedback.
      .finally(() => window.setTimeout(() => setRebuilding(false), 1200));
  };
  const handleRebuild = () => {
    setPlanning(true);
    window.electronAPI.knowledgeGraph
      .rebuildPlan()
      .then((plan) => {
        if (plan.summariesToRewrite > 0) setRebuildAsk(plan.summariesToRewrite);
        else runRebuild();
      })
      // Without the plan it cannot say what it would spend, so it does not run,
      // and says so rather than leaving a click that did nothing.
      .catch((error: unknown) => {
        useToastStore.getState().addToast({
          message: `Rebuild did not start: ${error instanceof Error ? error.message : String(error)}`,
          variant: 'error',
        });
      })
      .finally(() => setPlanning(false));
  };

  const semanticReady = indexingEnabled && semanticEnabled;

  // What each switchable source still waits for, the same rule the Knowledge
  // Graph's Index panel reads. Both are on by default, and their switches stay
  // usable while they wait.
  const { summaries: summariesRequirement, code: codeRequirement } = sourceRequirements({
    semanticEnabled,
    answerCapableAgents: answerCapableAgents.length,
    agentSetup,
    agentChosen: Boolean(agentChoice.agent),
  });

  const summaries = settingProps('knowledgeGraph.taskSummaries');
  const code = settingProps('knowledgeGraph.sourceCode');
  const sourceLines: CardSourceLineProps[] = [
    { label: 'Conversations', ...alwaysOnLine(status?.sources?.conversations, 'Conversations embedded'), testId: 'index-source-conversations' },
    { label: 'Tasks', ...alwaysOnLine(status?.sources?.tasks, 'Tasks embedded'), testId: 'index-source-tasks' },
    { label: 'Commits', ...alwaysOnLine(status?.sources?.commits, 'Commits indexed'), testId: 'index-source-commits' },
    {
      label: summaries.label,
      info: SUMMARIES_INFO,
      ...summariesLine(summariesOn, status?.summaries, summariesRequirement),
      toggle: { checked: summariesOn, onChange: (value) => updateKnowledgeGraph({ taskSummaries: value }), testId: `setting-row-${summaries.searchId}` },
      testId: 'index-source-summaries',
    },
    {
      label: code.label,
      info: CODE_INFO,
      ...codeLine(status?.code, codeRequirement),
      toggle: { checked: codeOn, onChange: (value) => updateKnowledgeGraph({ sourceCode: value }), testId: `setting-row-${code.searchId}` },
      testId: 'index-source-code',
    },
  ];

  const rewriteCalls = rebuildAsk === null ? 0 : Math.ceil(rebuildAsk / SUMMARY_BATCH_SIZE);

  return (
    <div className="space-y-4">
      {/* Two cards, in the order the feature is set up: the Knowledge Graph
          (one switch; the local model that finds by meaning, then the agent
          that answers), and the Index it reads. The Index also feeds Quick
          Find by keyword, which works with the Knowledge Graph off. */}
      <SettingsCard
        icon={<Brain size={16} />}
        {...settingProps('knowledgeGraph.enabled')}
        searchIds={['knowledgeGraph.localModel', 'knowledgeGraph.acceleration', 'knowledgeGraph.agent', 'knowledgeGraph.model', 'knowledgeGraph.effort']}
        // Reads off while the index is off, since it cannot run then, and turning
        // it on turns the index on too, in one write: the index's switch is
        // further down the tab.
        checked={semanticReady}
        onChange={(value) => updateGlobal({ knowledgeGraph: value ? { enabled: true, indexingEnabled: true } : { enabled: false } })}
        requirement={indexingEnabled ? undefined : 'Needs indexing'}
        testId="knowledge-graph-card"
      >
        {/* Gated on indexingEnabled too: with the index off the Knowledge
            Graph cannot run, so its rows stay hidden until the index is back. */}
        {semanticReady ? (
          <>
            {/* The local model: it finds by meaning and draws the map. */}
            <CardRow {...settingProps('knowledgeGraph.localModel')}>
              <Select
                value={embeddingModelId}
                onChange={(event) => updateGlobal({ knowledgeGraph: { localModel: event.target.value } })}
                data-testid="embedding-model-select"
              >
                {EMBEDDING_MODELS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.tierLabel}
                  </option>
                ))}
              </Select>
            </CardRow>
            {/* The chosen model's state, as a status row right under the
                dropdown that picks it. */}
            {model ? <EmbeddingModelStatus model={model} activeBackend={status?.activeBackend ?? null} /> : null}

            <CardChoiceRow
              {...settingProps('knowledgeGraph.acceleration')}
              options={[
                { value: 'auto', label: 'Auto', testId: 'knowledge-graph-acceleration-auto' },
                { value: 'gpu', label: 'GPU', testId: 'knowledge-graph-acceleration-gpu' },
                { value: 'cpu', label: 'CPU', testId: 'knowledge-graph-acceleration-cpu' },
              ]}
              value={acceleration}
              onChange={(value: KnowledgeGraphAcceleration) => updateGlobal({ knowledgeGraph: { acceleration: value } })}
              testId="knowledge-graph-acceleration-choice"
            />

            {platformNote ? (
              <CardTile className="text-xs text-fg-muted" testId="semantic-status">
                {platformNote}
              </CardTile>
            ) : null}

            {/* The agent: it answers from what the local model finds, and
                writes the task summaries. Only the agents that can actually
                answer; an agent with no `answerFromContext` is not a choice,
                it is a way to turn Ask off by accident. */}
            {answerCapableAgents.length === 0 ? (
              <CardStatusRow label="Agent" value="Needs a supported agent" testId="knowledge-graph-no-agent" />
            ) : (
              <AgentRows config={globalConfig.knowledgeGraph} agents={agentList} capableAgents={answerCapableAgents} onChange={updateKnowledgeGraph} />
            )}
          </>
        ) : null}
      </SettingsCard>

      <SettingsCard
        icon={<Database size={16} />}
        {...settingProps('knowledgeGraph.indexingEnabled')}
        searchIds={['knowledgeGraph.taskSummaries', 'knowledgeGraph.sourceCode']}
        checked={indexingEnabled}
        onChange={(value) => updateGlobal({ knowledgeGraph: { indexingEnabled: value } })}
        testId="index-card"
      >
        {indexingEnabled ? (
          <>
            {/* Every source the index searches, one line each. Session
                changes are not listed: nothing searches them, they only feed
                the task summaries. The figures are the open project's, since
                indexing runs for the open project. */}
            <CardSourceList lines={sourceLines} testId="index-sources" />
            <CardTile className="flex items-center justify-between gap-3" testId="knowledge-graph-rebuild-row">
              <div className="min-w-0">
                <div className={SETTING_LABEL_CLASS}>Rebuild the index</div>
                <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>Reads every source again, in every project.</p>
              </div>
              <button
                type="button"
                onClick={handleRebuild}
                disabled={rebuilding || planning}
                data-testid="knowledge-graph-rebuild-index"
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge-input bg-surface-control px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg disabled:opacity-50"
              >
                <RotateCcw size={13} className={rebuilding ? 'animate-spin' : undefined} />
                {rebuilding ? 'Rebuilding...' : 'Rebuild'}
              </button>
            </CardTile>
          </>
        ) : null}
      </SettingsCard>

      {rebuildAsk !== null && (
        <ConfirmDialog
          testId="rebuild-confirm"
          // A rebuild, not a warning, so not the default warning triangle.
          icon={<RotateCcw size={16} className="text-accent-fg" />}
          title="Rebuild everything?"
          message={`Conversations, tasks, commits, summaries and source code are all rebuilt, in every project. ${rebuildAsk === 1
            ? 'The 1 summary written with an earlier model is rewritten'
            : `The ${rebuildAsk.toLocaleString()} summaries written with an earlier model are rewritten`}, about ${rewriteCalls.toLocaleString()} ${rewriteCalls === 1 ? 'call' : 'calls'} in the background.`}
          confirmLabel="Rebuild"
          onConfirm={runRebuild}
          onCancel={() => setRebuildAsk(null)}
        />
      )}
    </div>
  );
}

type KnowledgeGraphPatch = NonNullable<DeepPartial<AppConfig>['knowledgeGraph']>;

interface AgentRowsProps {
  config: AppConfig['knowledgeGraph'];
  agents: AgentDetectionInfo[];
  /** Installed agents that can answer: the Agent row's options. */
  capableAgents: AgentDetectionInfo[];
  onChange: (patch: KnowledgeGraphPatch) => void;
}

/**
 * Agent, Model and Effort in the Knowledge Graph card, under the local model. The same three
 * controls as Settings > Agent's Project Defaults and the column manager:
 * Combobox, ModelCombobox, Combobox. No Permissions: answer and summary runs
 * are read-only by construction, so a permission choice would be one the run
 * must ignore. The effort is for answers; summaries run at the recommended
 * level (`agentJobChoice`), which the Effort row's info says.
 */
function AgentRows({ config, agents, capableAgents, onChange }: AgentRowsProps) {
  const choice = agentJobChoice(config, 'answer');
  /**
   * The chosen agent, resolved through the SAME rule main uses: the configured
   * one, or nothing. There is no project fallback, so an unset row reads as
   * unset.
   */
  const chosen = useMemo(
    () => resolveAnswerAgent({ agents, configured: choice.agent, requireFound: true }),
    [agents, choice.agent],
  );
  const chosenName = chosen?.name ?? null;
  const { models, effortLevels } = useAgentCapabilityResolution(chosenName);
  const contextWindows = useModelContextWindows(chosenName);
  const displayNames = useModelDisplayNames(chosenName);
  // Whether this agent's run takes a model, as its adapter declares it. When it
  // does, the model is required: nothing runs on a default nobody chose.
  const takesModel = chosen?.answerCapabilities?.model === true;
  // Effort shows wherever the run passes it on AND the CLI reports levels.
  // Unset runs at the adapter's recommended level, shown as the placeholder, so
  // leaving it alone is a choice the user can see.
  const takesEffort = chosen?.answerCapabilities?.effort === true && effortLevels.length > 0;
  const recommendedEffort = chosen?.answerCapabilities?.defaultEffort;
  const effortDefault = recommendedEffort && effortLevels.includes(recommendedEffort) ? recommendedEffort : null;

  return (
    <>
      {/* Starts EMPTY: the agent and model are one explicit global choice,
          never assumed from a project. */}
      <CardRow {...settingProps('knowledgeGraph.agent')}>
        <Combobox
          value={chosenName ?? ''}
          // A model id and an effort level belong to ONE CLI - Claude's `haiku`
          // means nothing to Codex - so changing the agent clears both rather
          // than carrying a flag the new agent will reject.
          onChange={(next) => onChange({ agent: next === '' ? null : next, model: null, effort: null })}
          options={capableAgents.map((agent) => ({ value: agent.name, label: agent.displayName }))}
          placeholder="Choose an agent"
          placeholderVariant="muted"
          allowClear={false}
          testId="knowledge-graph-answer-agent"
        />
      </CardRow>

      {/* Rendered once the chosen agent's run takes a model, and REQUIRED then:
          there is no "agent default" to fall back on, for the same reason there
          is no default agent. */}
      {takesModel ? (
        <CardRow {...settingProps('knowledgeGraph.model')}>
          <ModelCombobox
            value={choice.model ?? ''}
            onChange={(next) => onChange({ model: next === '' ? null : next })}
            availableModels={models}
            placeholder="Choose a model"
            placeholderVariant="muted"
            testId="knowledge-graph-answer-model"
            onOpen={() => useConfigStore.getState().rescanModels()}
            contextWindows={contextWindows}
            modelDisplayNames={displayNames}
          />
        </CardRow>
      ) : null}

      {/* Optional, unlike the model: unset runs at the recommended level, shown
          as the placeholder, and clearing a pick returns to it. Plain "low",
          not "low (default)": the resolved placeholder styling already says it
          is what runs when nothing is picked. */}
      {takesEffort ? (
        <CardRow {...settingProps('knowledgeGraph.effort')}>
          <Combobox
            value={choice.effort ?? ''}
            onChange={(next) => onChange({ effort: next === '' ? null : next })}
            options={effortLevels.map((level) => ({ value: level, label: level }))}
            placeholder={effortDefault ?? 'Agent default'}
            placeholderVariant={effortDefault ? 'resolved' : 'muted'}
            testId="knowledge-graph-answer-effort"
          />
        </CardRow>
      ) : null}
    </>
  );
}

/**
 * The local model's state, as the status row under Search quality. Switching
 * the Knowledge Graph on starts the download, so a model not on disk
 * yet reads as Downloading at 0%, never as a separate waiting state.
 */
function EmbeddingModelStatus({ model, activeBackend }: { model: NonNullable<KnowledgeGraphStatus['model']>; activeBackend: string | null }) {
  if (model.state === 'ready') {
    return (
      <CardStatusRow
        // "Local model", never "Model": the agent's Model row sits below it.
        label="Local model"
        value={`${model.displayName}, ${model.approxSizeMb} MB${activeBackend ? `, ${activeBackend}` : ''}`}
        tone="ready"
        testId="embedding-model-card"
        valueTestId="embedding-model-ready"
      />
    );
  }
  if (model.state === 'error') {
    return <CardStatusRow label="Download failed" value={model.displayName} tone="failure" testId="embedding-model-card" />;
  }
  const percent = model.state === 'downloading' ? Math.min(100, Math.floor((model.progress ?? 0) * 100)) : 0;
  return (
    <CardStatusRow
      label="Downloading"
      value={`${percent}%, ${model.displayName}`}
      percent={percent}
      progressLabel="Search model downloaded"
      testId="embedding-model-card"
    />
  );
}
