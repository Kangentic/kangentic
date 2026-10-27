import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { CardRow } from '../settings-card';
import { settingProps } from '../settings-registry';
import { useConfigStore } from '../../../stores/config-store';
import { useAgentCapabilityResolution } from '../../../hooks/useAgentCapabilityResolution';
import { useModelAliases, useModelContextWindows, useModelDisplayNames } from '../../../hooks/useKnownModels';
import { ModelCombobox } from '../../dialogs/ModelCombobox';
import { Combobox } from '../../dialogs/Combobox';
import type { AgentJobChoice } from '../../../../shared/answer-agent';
import type { AgentDetectionInfo } from '../../../../shared/types';

/** What the rows write: any of the three, null clearing it. */
export interface AnswerAgentPatch {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface AnswerAgentRowsProps {
  /** The current choice (`agentJobChoice`, `automationAgentChoice`, `workflowAgentChoice`). */
  choice: AgentJobChoice;
  /**
   * Which run the choice is for, and so which capabilities decide the Model and
   * Effort rows. `'answer'` (the default): a background answer run, read from the
   * adapter's `answerCapabilities`. `'interactive'`: an agent in a terminal (the
   * Workflow agent), read from the CLI's own `--model` and effort support, as
   * Settings > Agent's Project defaults are.
   */
  capability?: 'answer' | 'interactive';
  /** Installed agents that can do the job (found, and capable of this run): the Agent row's options. */
  capableAgents: AgentDetectionInfo[];
  onChange: (patch: AnswerAgentPatch) => void;
  /** The registry ids the three rows read their label and description from. */
  settingIds: { agent: string; model: string; effort: string };
  /** The prefix of the three controls' test ids (`<prefix>-agent`, `-model`, `-effort`). */
  testIdPrefix: string;
}

/**
 * Agent, Model and Effort for an agent chosen once in Settings: the Knowledge
 * Graph's (questions and task summaries), the Automation agent (an automation's
 * Condition) and the Workflow agent (a workflow's planner). One component, so
 * the choices behave the same way: the same three controls as Settings > Agent's
 * Project Defaults and the column manager (Combobox, ModelCombobox, Combobox).
 * The name is from the first two, which are background answer runs; the
 * Workflow agent reuses the rows through `capability: 'interactive'`.
 *
 * No Permissions: the answer runs are read-only by construction, and the
 * Workflow agent launches read-only where its adapter can enforce it and in its
 * own default mode otherwise, so a permission choice would be one the run must
 * ignore. Agent and Model start EMPTY and,
 * where the run takes a model, are both required: nothing spends on an agent
 * nobody chose, and there is no project fallback.
 */
export function AnswerAgentRows({ choice, capability = 'answer', capableAgents, onChange, settingIds, testIdPrefix }: AnswerAgentRowsProps) {
  const { t } = useLingui();
  // The chosen agent: the configured one when it is installed and capable (the
  // caller's `capableAgents`), so a choice the picker cannot offer reads as
  // unset. There is no project fallback.
  const chosen = useMemo(
    () => capableAgents.find((agent) => agent.name === choice.agent) ?? null,
    [capableAgents, choice.agent],
  );
  const chosenName = chosen?.name ?? null;
  const { models, effortLevels, supportsModelOverride } = useAgentCapabilityResolution(chosenName);
  const contextWindows = useModelContextWindows(chosenName);
  const displayNames = useModelDisplayNames(chosenName);
  // The floating aliases (Claude's `haiku`), listed as Latest like every other
  // model picker, so a run set to one follows each new release on its own.
  const modelAliases = useModelAliases(chosenName);
  const interactive = capability === 'interactive';
  // Whether this agent's run takes a model: as the adapter declares it for an
  // answer run, as the CLI reports it for an interactive one. When it does, the
  // model is required: nothing runs on a default nobody chose.
  const takesModel = chosen !== null && (interactive ? supportsModelOverride : chosen.answerCapabilities?.model === true);
  // Effort shows wherever the run passes it on AND the CLI reports levels.
  // Unset runs at the adapter's recommended level (an answer run) or the CLI's
  // own (an interactive one), shown as the placeholder, so leaving it alone is a
  // choice the user can see.
  const takesEffort = chosen !== null && (interactive || chosen.answerCapabilities?.effort === true) && effortLevels.length > 0;
  const recommendedEffort = interactive ? undefined : chosen?.answerCapabilities?.defaultEffort;
  const effortDefault = recommendedEffort && effortLevels.includes(recommendedEffort) ? recommendedEffort : null;

  return (
    <>
      <CardRow {...settingProps(settingIds.agent)}>
        <Combobox
          value={chosenName ?? ''}
          // A model id and an effort level belong to ONE CLI - Claude's `haiku`
          // means nothing to Codex - so changing the agent clears both rather
          // than carrying a flag the new agent will reject.
          onChange={(next) => onChange({ agent: next === '' ? null : next, model: null, effort: null })}
          options={capableAgents.map((agent) => ({ value: agent.name, label: agent.displayName }))}
          placeholder={t`Choose an agent`}
          placeholderVariant="muted"
          allowClear={false}
          testId={`${testIdPrefix}-agent`}
        />
      </CardRow>

      {/* Rendered once the chosen agent's run takes a model, and REQUIRED then:
          there is no "agent default" to fall back on, for the same reason there
          is no default agent. */}
      {takesModel ? (
        <CardRow {...settingProps(settingIds.model)}>
          <ModelCombobox
            value={choice.model ?? ''}
            onChange={(next) => onChange({ model: next === '' ? null : next })}
            availableModels={models}
            placeholder={t`Choose a model`}
            placeholderVariant="muted"
            testId={`${testIdPrefix}-model`}
            onOpen={() => useConfigStore.getState().rescanModels()}
            contextWindows={contextWindows}
            modelDisplayNames={displayNames}
            modelAliases={modelAliases}
          />
        </CardRow>
      ) : null}

      {/* Optional, unlike the model: unset runs at the recommended level, shown
          as the placeholder, and clearing a pick returns to it. */}
      {takesEffort ? (
        <CardRow {...settingProps(settingIds.effort)}>
          <Combobox
            value={choice.effort ?? ''}
            onChange={(next) => onChange({ effort: next === '' ? null : next })}
            options={effortLevels.map((level) => ({ value: level, label: level }))}
            placeholder={effortDefault ?? t`Agent default`}
            placeholderVariant={effortDefault ? 'resolved' : 'muted'}
            testId={`${testIdPrefix}-effort`}
          />
        </CardRow>
      ) : null}
    </>
  );
}
