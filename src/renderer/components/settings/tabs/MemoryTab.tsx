import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquare, Sparkles, Check, RotateCcw, Network, ScrollText, Clock, RefreshCw, TriangleAlert } from 'lucide-react';
import { Select, DownloadProgressBar, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardChoiceRow, CardTile } from '../settings-card';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../../SettingText';
import { settingProps } from '../settings-registry';
import { useProjectStore } from '../../../stores/project-store';
import { useConfigStore } from '../../../stores/config-store';
import { useAgentCapabilityResolution } from '../../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows, useModelDisplayNames } from '../../../hooks/useKnownModels';
import { ModelCombobox } from '../../dialogs/ModelCombobox';
import { Combobox } from '../../dialogs/Combobox';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { humanizeModelId } from '../../../../shared/model-id';
import { agentJobChoice, answerSetupGap, resolveAnswerAgent, taskDigestsOn, type AgentJob } from '../../../../shared/answer-agent';
import { DIGEST_BATCH_SIZE } from '../../../../shared/task-digests';
import { EMBEDDING_MODELS } from '../../../../shared/embedding-models';
import type {
  AgentDetectionInfo, AnswerSetupGap, AppConfig, DeepPartial, DigestChoice, MemoryDigestStatus, MemoryStatus, MemoryAcceleration,
} from '../../../../shared/types';

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
  // rather than a hardcoded list, per `agent-adapters-boundary.md`. The same
  // agents can answer or write digests: a digest batch is an answer run with no
  // tools.
  const agentList = useConfigStore((state) => state.agentList);
  const answerCapableAgents = useMemo(
    () => agentList.filter((agent) => agent.found && agent.supportsAnswerFromContext),
    [agentList],
  );
  const digestsOn = taskDigestsOn(globalConfig.memory);
  const digestChoice = agentJobChoice(globalConfig.memory, 'digest');
  // What digests still wait for, through the rule main applies before a pass.
  const digestSetup = answerSetupGap({
    agents: agentList,
    configured: digestChoice.agent,
    configuredModel: digestChoice.model,
    requireFound: true,
  });
  const updateMemory = useCallback(
    (patch: MemoryPatch) => updateGlobal({ memory: patch }),
    [updateGlobal],
  );

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

  // The Rewrite confirm, raised from the Task digests card and rendered at the
  // tab's top level like every settings dialog.
  const [rewriteAsk, setRewriteAsk] = useState<RewriteAsk | null>(null);
  const confirmRewrite = useCallback(() => {
    if (!currentProjectId) return;
    window.electronAPI.memory
      .rewriteDigests(currentProjectId)
      .catch(() => undefined)
      .finally(() => setRewriteAsk(null));
  }, [currentProjectId]);

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
          once nothing is missing. Named for what it chooses, not for the graph:
          it has no switch and never turns the graph on or off. */}
      <SettingsCard
        icon={<Network size={16} />}
        label="Answering agent"
        description="Answers the questions you ask in the Knowledge Graph."
        searchIds={['memory.answerAgent', 'memory.answerModel', 'memory.answerEffort']}
        requirement={!semanticReady
          ? 'Needs semantic search'
          : answerCapableAgents.length === 0
            ? 'Needs a supported agent'
            : undefined}
        testId="answering-agent-card"
      >
        {semanticReady && answerCapableAgents.length > 0 ? (
          <AgentJobRows job="answer" memory={globalConfig.memory} agents={agentList} capableAgents={answerCapableAgents} onChange={updateMemory} />
        ) : null}
      </SettingsCard>

      {/* Opt-in: digests spend about a call per ten finished tasks, in the
          background. Their own agent, model and effort, starting empty with no
          fallback to the answering agent, so switching on spends nothing until
          a choice is made, and the status line shows the backfill's size first.
          Dimmed on the same prerequisites as the Answering agent card. */}
      <SettingsCard
        icon={<ScrollText size={16} />}
        {...settingProps('memory.taskDigests')}
        info="The agent reads each finished task's title, description, changed files and how its sessions ended, about ten tasks a call, in the background."
        searchIds={['memory.digestAgent', 'memory.digestModel', 'memory.digestEffort']}
        checked={digestsOn}
        onChange={(value) => updateMemory({ taskDigests: value })}
        requirement={!semanticReady
          ? 'Needs semantic search'
          : answerCapableAgents.length === 0
            ? 'Needs a supported agent'
            : undefined}
        testId="task-digests-card"
      >
        {semanticReady && answerCapableAgents.length > 0 && digestsOn ? (
          <>
            <AgentJobRows job="digest" memory={globalConfig.memory} agents={agentList} capableAgents={answerCapableAgents} onChange={updateMemory} />
            <DigestStatusTile digests={status?.digests ?? null} setup={digestSetup} agents={agentList} />
            <RewriteDigestsTile digests={status?.digests ?? null} agents={agentList} onRewrite={setRewriteAsk} />
          </>
        ) : null}
      </SettingsCard>

      {rewriteAsk !== null && (
        <ConfirmDialog
          testId="rewrite-digests-confirm"
          // A rewrite, not a warning, so not the default warning triangle.
          icon={<RotateCcw size={16} className="text-accent-fg" />}
          title={`Rewrite ${rewriteAsk.count.toLocaleString()} digests with ${rewriteAsk.label}?`}
          message={`About ${Math.ceil(rewriteAsk.count / DIGEST_BATCH_SIZE).toLocaleString()} calls, three at a time, in the background. Each digest stays searchable until its new one is written.`}
          confirmLabel="Rewrite"
          onConfirm={confirmRewrite}
          onCancel={() => setRewriteAsk(null)}
        />
      )}
    </div>
  );
}

type MemoryPatch = NonNullable<DeepPartial<AppConfig>['memory']>;

/** Each job's registry rows and test hooks. */
const JOB_ROWS: Record<AgentJob, { agent: string; model: string; effort: string; testId: string }> = {
  answer: { agent: 'memory.answerAgent', model: 'memory.answerModel', effort: 'memory.answerEffort', testId: 'memory-answer' },
  digest: { agent: 'memory.digestAgent', model: 'memory.digestModel', effort: 'memory.digestEffort', testId: 'memory-digest' },
};

/** The config patch that sets one job's agent, model or effort. */
function jobPatch(job: AgentJob, choice: { agent?: string | null; model?: string | null; effort?: string | null }): MemoryPatch {
  const patch: MemoryPatch = {};
  if (choice.agent !== undefined) patch[job === 'digest' ? 'digestAgent' : 'answerAgent'] = choice.agent;
  if (choice.model !== undefined) patch[job === 'digest' ? 'digestModel' : 'answerModel'] = choice.model;
  if (choice.effort !== undefined) patch[job === 'digest' ? 'digestEffort' : 'answerEffort'] = choice.effort;
  return patch;
}

interface AgentJobRowsProps {
  job: AgentJob;
  memory: AppConfig['memory'];
  agents: AgentDetectionInfo[];
  /** Installed agents that can run the job: the Agent row's options. */
  capableAgents: AgentDetectionInfo[];
  onChange: (patch: MemoryPatch) => void;
}

/**
 * Agent, Model and Effort for one job, in the Answering agent card or the Task
 * digests card. The same three controls as Settings > Agent's Project Defaults
 * and the column manager: Combobox, ModelCombobox, Combobox. No Permissions:
 * both runs are read-only by construction, so a permission choice would be one
 * the run must ignore.
 */
function AgentJobRows({ job, memory, agents, capableAgents, onChange }: AgentJobRowsProps) {
  const rows = JOB_ROWS[job];
  const choice = agentJobChoice(memory, job);
  /**
   * The chosen agent, resolved through the SAME rule main uses: the configured
   * one, or nothing. There is no project fallback and no fallback between the
   * two jobs, so an unset row reads as unset.
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
      {/* Starts EMPTY: the agent and model are one explicit global choice per
          job, never assumed from a project or from the other job. */}
      <CardRow {...settingProps(rows.agent)}>
        <Combobox
          value={chosenName ?? ''}
          // A model id and an effort level belong to ONE CLI - Claude's `haiku`
          // means nothing to Codex - so changing the agent clears both rather
          // than carrying a flag the new agent will reject.
          onChange={(next) => onChange(jobPatch(job, { agent: next === '' ? null : next, model: null, effort: null }))}
          options={capableAgents.map((agent) => ({ value: agent.name, label: agent.displayName }))}
          placeholder="Choose an agent"
          placeholderVariant="muted"
          allowClear={false}
          testId={`${rows.testId}-agent`}
        />
      </CardRow>

      {/* Rendered once the chosen agent's run takes a model, and REQUIRED then:
          there is no "agent default" to fall back on, for the same reason there
          is no default agent. */}
      {takesModel ? (
        <CardRow {...settingProps(rows.model)}>
          <ModelCombobox
            value={choice.model ?? ''}
            onChange={(next) => onChange(jobPatch(job, { model: next === '' ? null : next }))}
            availableModels={models}
            placeholder="Choose a model"
            placeholderVariant="muted"
            testId={`${rows.testId}-model`}
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
        <CardRow {...settingProps(rows.effort)}>
          <Combobox
            value={choice.effort ?? ''}
            onChange={(next) => onChange(jobPatch(job, { effort: next === '' ? null : next }))}
            options={effortLevels.map((level) => ({ value: level, label: level }))}
            placeholder={effortDefault ?? 'Agent default'}
            placeholderVariant={effortDefault ? 'resolved' : 'muted'}
            testId={`${rows.testId}-effort`}
          />
        </CardRow>
      ) : null}
    </>
  );
}

/** What the Rewrite confirm names: how many digests, and what they are rewritten with. */
interface RewriteAsk {
  count: number;
  label: string;
}

function sameChoice(first: DigestChoice, second: DigestChoice): boolean {
  return first.agent === second.agent && first.model === second.model && first.effort === second.effort;
}

/**
 * How a digest's writer reads in a sentence: "Sonnet 5.5 at low effort". The
 * agent is named only when it differs from `relativeTo` (the current choice)
 * or there is no model to name.
 */
function choiceLabel(choice: DigestChoice, agents: ReadonlyArray<AgentDetectionInfo>, relativeTo?: DigestChoice | null): string {
  const model = choice.model ? humanizeModelId(choice.model) ?? choice.model : null;
  const agent = agents.find((entry) => entry.name === choice.agent)?.displayName ?? choice.agent;
  const writer = model && (!relativeTo || relativeTo.agent === choice.agent) ? model : model ? `${agent}, ${model}` : agent;
  return choice.effort ? `${writer} at ${choice.effort} effort` : writer;
}

/**
 * Rewrite this project's digests with the current choice, in the shape of
 * Rebuild this project's index: what they were written with on the left, the
 * action on the right. The button is always here; with nothing to rewrite it
 * is disabled and says why. It rewrites only the digests written some other
 * way, so none is paid for twice.
 */
function RewriteDigestsTile({ digests, agents, onRewrite }: {
  digests: MemoryDigestStatus | null;
  agents: ReadonlyArray<AgentDetectionInfo>;
  onRewrite: (ask: RewriteAsk) => void;
}) {
  if (!digests) return null;
  const written = digests.writtenWith.reduce((sum, entry) => sum + entry.count, 0);
  const choice = digests.choice;
  const others = choice ? digests.writtenWith.filter((entry) => !sameChoice(entry, choice)) : digests.writtenWith;
  const othersCount = others.reduce((sum, entry) => sum + entry.count, 0);
  const rewriting = digests.awaitingRewrite > 0;
  const busy = rewriting || digests.state === 'writing';

  let line: string;
  let reason: string;
  if (written === 0) {
    line = 'No digests written yet.';
    reason = 'Nothing to rewrite yet.';
  } else if (!choice) {
    line = digests.writtenWith.length === 1
      ? `All ${written.toLocaleString()} written with ${choiceLabel(digests.writtenWith[0], agents)}.`
      : `${written.toLocaleString()} written with ${digests.writtenWith.length} settings.`;
    reason = 'Choose an agent and model first.';
  } else if (othersCount === 0) {
    line = `All ${written.toLocaleString()} written with ${choiceLabel(choice, agents)}.`;
    reason = 'Every digest was written with the chosen agent, model and effort.';
  } else {
    const still = rewriting ? 'still ' : '';
    line = others.length === 1
      ? `${othersCount.toLocaleString()} ${still}written with ${choiceLabel(others[0], agents, choice)}.`
      : `${othersCount.toLocaleString()} ${still}written another way.`;
    reason = busy ? 'Digests are being written.' : `Rewrite the ${othersCount.toLocaleString()} with ${choiceLabel(choice, agents)}.`;
  }
  const enabled = choice !== null && othersCount > 0 && !busy;

  return (
    <CardTile className="flex items-center justify-between gap-3" testId="rewrite-digests-row">
      <div className="min-w-0">
        <div className={SETTING_LABEL_CLASS}>Rewrite this project&apos;s digests</div>
        <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`} data-testid="rewrite-digests-line">{line}</p>
      </div>
      <button
        type="button"
        onClick={() => { if (enabled && choice) onRewrite({ count: othersCount, label: choiceLabel(choice, agents) }); }}
        disabled={!enabled}
        title={reason}
        data-testid="rewrite-digests"
        className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge-input bg-surface-control px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg disabled:opacity-50 disabled:hover:border-edge-input disabled:hover:bg-surface-control disabled:hover:text-fg-secondary"
      >
        <RotateCcw size={13} className={rewriting ? 'animate-spin' : undefined} />
        {rewriting ? 'Rewriting...' : 'Rewrite'}
      </button>
    </CardTile>
  );
}

/**
 * What the open project's digests are doing, as one line under the Task
 * digests card's rows. Before an agent (or model) is chosen it shows the size
 * of the backfill, in tasks and calls, so the cost is visible before anything
 * runs. Calls, not dollars: no adapter reports a price.
 */
function DigestStatusTile({ digests, setup, agents }: {
  digests: MemoryDigestStatus | null;
  setup: AnswerSetupGap | null;
  agents: ReadonlyArray<AgentDetectionInfo>;
}) {
  if (!digests) return null;
  const toWrite = Math.max(0, digests.finishedTasks - digests.written);
  const calls = Math.ceil(toWrite / DIGEST_BATCH_SIZE);
  if (digests.awaitingRewrite > 0 && digests.choice && !setup) {
    // Every digest written some other way was marked, so what is left
    // unmarked is what the new choice has written.
    const total = digests.writtenWith.reduce((sum, entry) => sum + entry.count, 0);
    const done = Math.max(0, total - digests.awaitingRewrite);
    return (
      <CardTile className="text-xs text-fg-muted" testId="digest-status">
        <div className="flex items-center gap-1.5">
          <RefreshCw size={13} className="flex-shrink-0 text-accent-fg" aria-hidden="true" />
          <span data-testid="digest-status-text">
            Rewriting with {choiceLabel(digests.choice, agents)}: {done.toLocaleString()} of {total.toLocaleString()}.
          </span>
        </div>
        <DownloadProgressBar percent={total > 0 ? (done / total) * 100 : 0} />
      </CardTile>
    );
  }
  if (setup) {
    const waitingFor = setup === 'model' ? 'a model' : 'an agent';
    return (
      <CardTile className="flex items-center gap-1.5 text-xs text-fg-muted" testId="digest-status">
        <Clock size={13} className="flex-shrink-0" aria-hidden="true" />
        <span data-testid="digest-status-text">
          {toWrite > 0
            ? `Waiting for ${waitingFor}: ${toWrite.toLocaleString()} tasks here, about ${calls.toLocaleString()} calls.`
            : `Waiting for ${waitingFor}.`}
        </span>
      </CardTile>
    );
  }
  if (digests.state === 'retrying') {
    const minutes = Math.max(1, Math.round((digests.retryInMs ?? 0) / 60_000));
    return (
      <CardTile className="flex items-center gap-1.5 text-xs text-fg-muted" testId="digest-status">
        <TriangleAlert size={13} className="flex-shrink-0 text-warning" aria-hidden="true" />
        <span data-testid="digest-status-text">
          A call failed. Trying again in {minutes} {minutes === 1 ? 'minute' : 'minutes'}.
        </span>
      </CardTile>
    );
  }
  // Caught up: every finished task has a digest, or the rest are ones the agent
  // passed over this launch.
  if (toWrite === 0 || (digests.state === 'idle' && toWrite <= digests.skipped)) {
    return (
      <CardTile className="flex items-center gap-1.5 text-xs text-fg-muted" testId="digest-status">
        <Check size={13} className="flex-shrink-0 text-emerald-500" aria-hidden="true" />
        <span data-testid="digest-status-text">
          {toWrite === 0
            ? `All ${digests.finishedTasks.toLocaleString()} finished tasks in this project have one.`
            : `${digests.written.toLocaleString()} of ${digests.finishedTasks.toLocaleString()} written, ${digests.skipped.toLocaleString()} skipped until the next launch.`}
        </span>
      </CardTile>
    );
  }
  const percent = digests.finishedTasks > 0 ? (digests.written / digests.finishedTasks) * 100 : 0;
  return (
    <CardTile className="text-xs text-fg-muted" testId="digest-status">
      <div className="flex items-center gap-1.5">
        <RefreshCw size={13} className="flex-shrink-0 text-accent-fg" aria-hidden="true" />
        <span data-testid="digest-status-text">
          Writing: {digests.written.toLocaleString()} of {digests.finishedTasks.toLocaleString()} finished tasks in this project.
        </span>
      </div>
      <DownloadProgressBar percent={percent} />
    </CardTile>
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
