import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, RotateCcw, Brain } from 'lucide-react';
import type { I18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardChoiceRow, CardTile, CardStatusRow, CardSourceList, CardLinkRow, type CardSourceLineProps } from '../settings-card';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../../SettingText';
import { settingProps } from '../settings-registry';
import { useConfigStore } from '../../../stores/config-store';
import { useToastStore } from '../../../stores/toast-store';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { agentJobChoice, answerSetupGap, taskSummariesOn } from '../../../../shared/answer-agent';
import { AnswerAgentRows } from './answer-agent-rows';
import { SUMMARY_BATCH_SIZE } from '../../../../shared/task-summaries';
import { EMBEDDING_MODELS, resolveEmbeddingModel } from '../../../../shared/embedding-models';
import { licenseLinks } from '../../../../shared/model-licenses';
import { alwaysOnLine, codeLine, CODE_INFO, sourceRequirements, SUMMARIES_INFO, summariesLine } from './index-sources';
import { KNOWLEDGE_GRAPH_UNAVAILABLE_TAG, knowledgeGraphOn, knowledgeGraphSupported, knowledgeGraphUnsupportedLine } from '../../../lib/knowledge-graph-support';
import type {
  AppConfig, DeepPartial, KnowledgeGraphStatus, KnowledgeGraphAcceleration,
} from '../../../../shared/types';
import { asSentence, describeIpcError } from '../../../lib/ipc-error';
import { translateText } from '../../../i18n/translate';

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
function semanticPlatformNote(status: KnowledgeGraphStatus | null, i18n: I18n): string | null {
  if (!status) return null;
  if (status.semantic === 'lexical') {
    const vecError = status.vecError;
    return vecError
      ? i18n._(msg`Vector search is unavailable - showing keyword matches. (${vecError})`)
      : i18n._(msg`Vector search is unavailable on this platform - showing keyword matches.`);
  }
  if (status.semantic === 'error') {
    const workerError = status.workerError;
    return workerError
      ? i18n._(msg`The local model is unavailable - showing keyword matches. (${workerError})`)
      : i18n._(msg`The local model is unavailable - showing keyword matches.`);
  }
  return null;
}

export function KnowledgeGraphTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t, i18n } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  // Default on when unset (matches DEFAULT_CONFIG.knowledgeGraph.indexingEnabled).
  const indexingEnabled = globalConfig.knowledgeGraph?.indexingEnabled ?? true;
  // Off when unset (matches DEFAULT_CONFIG.knowledgeGraph.enabled), and off in a
  // build whose platform the local model has no build for (Intel Macs), where
  // main never runs it whatever the config says.
  const supported = knowledgeGraphSupported();
  const semanticEnabled = knowledgeGraphOn(globalConfig.knowledgeGraph);
  // The model main runs: the saved id, or the default when it is unset or names a
  // model the registry dropped (bge-base, bge-large), so the control always
  // shows a selection.
  const embeddingModel = resolveEmbeddingModel(globalConfig.knowledgeGraph?.localModel);
  const embeddingModelId = embeddingModel.id;
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
    // One read at a time: main reads every indexed project, which can outlast
    // the interval on a busy worker, and a second read would only add to its load.
    let polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      window.electronAPI.knowledgeGraph
        .getStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [indexingEnabled, semanticEnabled]);

  const platformNote = semanticPlatformNote(status, i18n);
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
          title: t`Rebuild didn't start`,
          message: asSentence(describeIpcError(error)),
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
    knowledgeGraphSupported: supported,
    semanticEnabled,
    answerCapableAgents: answerCapableAgents.length,
    agentSetup,
    agentChosen: Boolean(agentChoice.agent),
  });

  const summaries = settingProps('knowledgeGraph.taskSummaries');
  const code = settingProps('knowledgeGraph.sourceCode');
  const sourceLines: CardSourceLineProps[] = [
    { label: t`Conversations`, ...alwaysOnLine(status?.sources?.conversations, t`Conversations embedded`), testId: 'index-source-conversations' },
    { label: t`Tasks`, ...alwaysOnLine(status?.sources?.tasks, t`Tasks embedded`), testId: 'index-source-tasks' },
    { label: t`Commits`, ...alwaysOnLine(status?.sources?.commits, t`Commits indexed`), testId: 'index-source-commits' },
    {
      label: summaries.label,
      info: translateText(SUMMARIES_INFO),
      ...summariesLine(summariesOn, status?.summaries, summariesRequirement),
      toggle: { checked: summariesOn, onChange: (value) => updateKnowledgeGraph({ taskSummaries: value }), testId: `setting-row-${summaries.searchId}` },
      testId: 'index-source-summaries',
    },
    {
      label: code.label,
      info: translateText(CODE_INFO),
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
      {!supported ? (
        // No switch to offer: the local model cannot load in this build, so
        // the card says so instead of a toggle that would do nothing.
        <SettingsCard
          icon={<Brain size={16} />}
          {...settingProps('knowledgeGraph.enabled')}
          searchIds={['knowledgeGraph.localModel', 'knowledgeGraph.acceleration', 'knowledgeGraph.agent', 'knowledgeGraph.model', 'knowledgeGraph.effort']}
          tag={KNOWLEDGE_GRAPH_UNAVAILABLE_TAG}
          testId="knowledge-graph-card"
        >
          <CardTile testId="knowledge-graph-unsupported">
            <p className="text-xs text-fg-secondary">{knowledgeGraphUnsupportedLine()}</p>
          </CardTile>
        </SettingsCard>
      ) : (
        <SettingsCard
          icon={<Brain size={16} />}
          {...settingProps('knowledgeGraph.enabled')}
          searchIds={['knowledgeGraph.localModel', 'knowledgeGraph.acceleration', 'knowledgeGraph.agent', 'knowledgeGraph.model', 'knowledgeGraph.effort']}
          // Reads off while the index is off, since it cannot run then, and turning
          // it on turns the index on too, in one write: the index's switch is
          // further down the tab.
          checked={semanticReady}
          onChange={(value) => updateGlobal({ knowledgeGraph: value ? { enabled: true, indexingEnabled: true } : { enabled: false } })}
          requirement={indexingEnabled ? undefined : t`Needs indexing`}
          testId="knowledge-graph-card"
        >
          {/* Gated on indexingEnabled too: with the index off the Knowledge
              Graph cannot run, so its rows stay hidden until the index is back. */}
          {semanticReady ? (
            <>
              {/* The local model: it finds by meaning and draws the map. */}
              <CardChoiceRow
                {...settingProps('knowledgeGraph.localModel')}
                options={EMBEDDING_MODELS.map((option) => ({ value: option.id, label: translateText(option.tierLabel), testId: `embedding-model-${option.id}` }))}
                value={embeddingModelId}
                onChange={(next: string) => updateGlobal({ knowledgeGraph: { localModel: next } })}
                testId="embedding-model-choice"
              />
              {/* The chosen model's state, as a status row right under the
                  control that picks it, then the license it ships under. */}
              {model ? <EmbeddingModelStatus model={model} activeBackend={status?.activeBackend ?? null} /> : null}
              <CardLinkRow
                label={t`License`}
                links={licenseLinks([embeddingModel.license])}
                onOpen={(href) => void window.electronAPI.shell.openExternal(href)}
                testId="embedding-model-license"
              />

              <CardChoiceRow
                {...settingProps('knowledgeGraph.acceleration')}
                options={[
                  { value: 'auto', label: t({ message: 'Auto', context: 'acceleration' }), testId: 'knowledge-graph-acceleration-auto' },
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
                <CardStatusRow label={t`Agent`} value={t`Needs a supported agent`} testId="knowledge-graph-no-agent" />
              ) : (
                <AnswerAgentRows
                  choice={agentChoice}
                  capableAgents={answerCapableAgents}
                  onChange={updateKnowledgeGraph}
                  settingIds={{ agent: 'knowledgeGraph.agent', model: 'knowledgeGraph.model', effort: 'knowledgeGraph.effort' }}
                  testIdPrefix="knowledge-graph-answer"
                />
              )}
            </>
          ) : null}
        </SettingsCard>
      )}

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
                the task summaries. The figures are every indexed project's,
                summed the way the Knowledge Graph's All projects panel sums
                them, so the two read the same. */}
            <CardSourceList lines={sourceLines} testId="index-sources" />
            <CardTile className="flex items-center justify-between gap-3" testId="knowledge-graph-rebuild-row">
              <div className="min-w-0">
                <div className={SETTING_LABEL_CLASS}><Trans>Rebuild the index</Trans></div>
                <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}><Trans>Reads every source again, in every project.</Trans></p>
              </div>
              <button
                type="button"
                onClick={handleRebuild}
                disabled={rebuilding || planning}
                data-testid="knowledge-graph-rebuild-index"
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge-input bg-surface-control px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg disabled:opacity-50"
              >
                <RotateCcw size={13} className={rebuilding ? 'animate-spin' : undefined} />
                {rebuilding ? t`Rebuilding...` : t`Rebuild`}
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
          title={t`Rebuild everything?`}
          message={t`Conversations, tasks, commits, summaries and source code are all rebuilt, in every project. ${plural(rebuildAsk, {
            one: 'The # summary written with an earlier model is rewritten',
            other: 'The # summaries written with an earlier model are rewritten',
          })}, about ${plural(rewriteCalls, { one: '# call', other: '# calls' })} in the background.`}
          confirmLabel={t`Rebuild`}
          onConfirm={runRebuild}
          onCancel={() => setRebuildAsk(null)}
        />
      )}
    </div>
  );
}

type KnowledgeGraphPatch = NonNullable<DeepPartial<AppConfig>['knowledgeGraph']>;

/**
 * The local model's state, as the status row under Search quality. Switching
 * the Knowledge Graph on starts the download, so a model not on disk
 * yet reads as Downloading at 0%, never as a separate waiting state.
 */
function EmbeddingModelStatus({ model, activeBackend }: { model: NonNullable<KnowledgeGraphStatus['model']>; activeBackend: string | null }) {
  const { t } = useLingui();
  const displayName = model.displayName;
  if (model.state === 'ready') {
    const approxSizeMb = model.approxSizeMb;
    return (
      <CardStatusRow
        // "Local model", never "Model": the agent's Model row sits below it.
        label={t`Local model`}
        value={activeBackend
          ? t`${displayName}, ${approxSizeMb} MB, ${activeBackend}`
          : t`${displayName}, ${approxSizeMb} MB`}
        tone="ready"
        testId="embedding-model-card"
        valueTestId="embedding-model-ready"
      />
    );
  }
  if (model.state === 'error') {
    return <CardStatusRow label={t`Download failed`} value={displayName} tone="failure" testId="embedding-model-card" />;
  }
  const percent = model.state === 'downloading' ? Math.min(100, Math.floor((model.progress ?? 0) * 100)) : 0;
  return (
    <CardStatusRow
      label={t`Downloading`}
      value={t`${percent}%, ${displayName}`}
      percent={percent}
      progressLabel={t`Search model downloaded`}
      testId="embedding-model-card"
    />
  );
}
