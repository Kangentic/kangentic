import { useCallback, useMemo, useState } from 'react';
import { Bot, CircleCheck, Workflow as WorkflowIcon } from 'lucide-react';
import { useScopedUpdate } from '../shared';
import { CardTile, SettingsCard } from '../settings-card';
import { settingProps } from '../settings-registry';
import { useConfigStore } from '../../../stores/config-store';
import { automationAgentChoice } from '../../../../shared/answer-agent';
import { workflowAgentChoice } from '../../../../shared/workflow-agent-choice';
import { DEFAULT_WORKFLOW_AGENT_PROMPT, workflowAgentPromptTemplate } from '../../../../shared/workflow-agent-prompt';
import type { AppConfig } from '../../../../shared/types';
import { AnswerAgentRows, type AnswerAgentPatch } from './answer-agent-rows';
import {
  WorkflowAgentPromptDialog,
  WorkflowAgentPromptExpandButton,
  WorkflowAgentPromptSetting,
} from './WorkflowAgentPromptField';

/**
 * Settings > Workflows (tab id `workflows`). GLOBAL/shared scope, first in the
 * Advanced tier: it applies to every project and works with no project open.
 *
 * The Workflow agent leads, with its first message right under it: no workflow
 * agent starts until it is chosen, and the Workflows view's pane sends the user
 * here to choose it (`open-workflow-agent-settings.ts`). Its own choice, with no
 * fallback to the project's default agent (`src/shared/workflow-agent-choice.ts`).
 *
 * The Automation agent follows. It answers every automation's Condition (and,
 * with workflows, judges when a column's work is done). Also its own choice, not
 * the Knowledge Graph's and not the project's default agent, so a user can run
 * automations without the Knowledge Graph, and nothing spends on an agent nobody
 * chose. It is not the Workflow agent. A judge that answers yes or no runs well
 * on a small model a planner should not.
 */
export function WorkflowsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const agentList = useConfigStore((state) => state.agentList);
  // Installed agents Kangentic can run as a workflow's agent: they reach its MCP
  // server with a URL of their own, and their conversation can be resumed.
  const workflowCapableAgents = useMemo(
    () => agentList.filter((agent) => agent.found && agent.supportsWorkflowAgent),
    [agentList],
  );
  const workflowChoice = workflowAgentChoice(globalConfig.workflows);
  const updateWorkflowAgent = useCallback(
    (patch: AnswerAgentPatch) => updateGlobal({ workflows: patch }),
    [updateGlobal],
  );

  // Installed agents whose adapter can answer a one-shot question: the check
  // runs through the same headless answer path as the Knowledge Graph's.
  const answerCapableAgents = useMemo(
    () => agentList.filter((agent) => agent.found && agent.supportsAnswerFromContext),
    [agentList],
  );
  const automationChoice = automationAgentChoice(globalConfig.automation);
  const updateAutomationAgent = useCallback(
    (patch: AnswerAgentPatch) => updateGlobal({ automation: patch }),
    [updateGlobal],
  );

  // The prompt as the agent would get it. Stored only when it differs from the
  // default, so a later change to the default reaches everyone who never edited it.
  const storedPrompt = workflowAgentPromptTemplate(globalConfig.workflows?.agentPrompt);
  const savePrompt = useCallback((next: string) => {
    const agentPrompt = next.trim() && next !== DEFAULT_WORKFLOW_AGENT_PROMPT ? next : null;
    updateGlobal({ workflows: { agentPrompt } });
  }, [updateGlobal]);
  const [promptExpanded, setPromptExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        icon={<Bot size={16} />}
        {...settingProps('workflows.agentCard')}
        searchIds={['workflows.agent', 'workflows.model', 'workflows.effort']}
        testId="settings-card-workflow-agent"
      >
        <AnswerAgentRows
          choice={workflowChoice}
          capability="interactive"
          capableAgents={workflowCapableAgents}
          onChange={updateWorkflowAgent}
          settingIds={{ agent: 'workflows.agent', model: 'workflows.model', effort: 'workflows.effort' }}
          testIdPrefix="workflow-agent-setting"
        />
      </SettingsCard>
      <SettingsCard
        icon={<WorkflowIcon size={16} />}
        {...settingProps('workflows.agentPrompt')}
        testId="settings-card-workflow-agent-prompt"
        headerAction={<WorkflowAgentPromptExpandButton onClick={() => setPromptExpanded(true)} />}
      >
        <CardTile>
          <WorkflowAgentPromptSetting key={storedPrompt} stored={storedPrompt} onSave={savePrompt} />
        </CardTile>
      </SettingsCard>
      <SettingsCard
        icon={<CircleCheck size={16} />}
        {...settingProps('automation.agentCard')}
        searchIds={['automation.agent', 'automation.model', 'automation.effort']}
        testId="settings-card-automation-agent"
      >
        <AnswerAgentRows
          choice={automationChoice}
          capableAgents={answerCapableAgents}
          onChange={updateAutomationAgent}
          settingIds={{ agent: 'automation.agent', model: 'automation.model', effort: 'automation.effort' }}
          testIdPrefix="automation-agent"
        />
      </SettingsCard>
      {promptExpanded && (
        <WorkflowAgentPromptDialog
          initial={storedPrompt}
          onSave={savePrompt}
          onClose={() => setPromptExpanded(false)}
        />
      )}
    </div>
  );
}
