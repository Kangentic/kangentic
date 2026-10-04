import { useCallback, useMemo, useState } from 'react';
import { CircleCheck, ListTree } from 'lucide-react';
import { useScopedUpdate } from '../shared';
import { CardTile, SettingsCard } from '../settings-card';
import { settingProps } from '../settings-registry';
import { useConfigStore } from '../../../stores/config-store';
import { automationAgentChoice } from '../../../../shared/answer-agent';
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
 * The Automation agent leads, because nothing it does runs until it is set up:
 * it answers every automation's Condition (and, with workflows, judges when a
 * column's work is done). Its own choice, not the Knowledge Graph's and not the
 * project's default agent, so a user can run automations without the
 * Knowledge Graph, and nothing spends on an agent nobody chose.
 */
export function WorkflowsTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const agentList = useConfigStore((state) => state.agentList);
  // Installed agents whose adapter can answer a one-shot question: the check
  // runs through the same headless answer path as the Knowledge Graph's.
  const capableAgents = useMemo(
    () => agentList.filter((agent) => agent.found && agent.supportsAnswerFromContext),
    [agentList],
  );
  const choice = automationAgentChoice(globalConfig.automation);
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
        icon={<CircleCheck size={16} />}
        {...settingProps('automation.agentCard')}
        searchIds={['automation.agent', 'automation.model', 'automation.effort']}
        testId="settings-card-automation-agent"
      >
        <AnswerAgentRows
          choice={choice}
          agents={agentList}
          capableAgents={capableAgents}
          onChange={updateAutomationAgent}
          settingIds={{ agent: 'automation.agent', model: 'automation.model', effort: 'automation.effort' }}
          testIdPrefix="automation-agent"
        />
      </SettingsCard>
      <SettingsCard
        icon={<ListTree size={16} />}
        {...settingProps('workflows.agentPrompt')}
        testId="settings-card-workflow-agent-prompt"
        headerAction={<WorkflowAgentPromptExpandButton onClick={() => setPromptExpanded(true)} />}
      >
        <CardTile>
          <WorkflowAgentPromptSetting key={storedPrompt} stored={storedPrompt} onSave={savePrompt} />
        </CardTile>
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
