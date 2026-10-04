/**
 * The index's source lines (Conversations, Tasks, Commits, Task summaries,
 * Source code) as the Knowledge Graph shows them: the map's Index panel, and
 * the building card while the first map builds. One hook, so the two read the
 * same lines in the same states.
 *
 * What each line still waits for comes through the rule the Settings card
 * reads. The agent's half comes from config, so choosing one shows at once.
 * The Knowledge Graph counts as on only while its setting is on and the
 * snapshot has vectors, as the Settings card reads it. The vectors alone are
 * the map's off card signal, so the card and the lines never disagree, but they
 * outlive switching the Knowledge Graph off: a map still drawn from them would
 * otherwise show shares that never move, since nothing embeds while it is off.
 */

import { useMemo } from 'react';
import { sourceRequirements } from '../settings/tabs/index-sources';
import { useConfigStore } from '../../stores/config-store';
import { agentJobChoice, answerSetupGap, taskSummariesOn } from '../../../shared/answer-agent';
import type { CardSourceLineProps } from '../settings/settings-card';
import type { KnowledgeGraphIndexSummary } from '../../../shared/types';
import { indexSourceLines } from './index-panel-lines';

export function useIndexSourceLines(index: KnowledgeGraphIndexSummary, semanticAvailable: boolean): CardSourceLineProps[] {
  const knowledgeGraphConfig = useConfigStore((state) => state.config.knowledgeGraph);
  const agentList = useConfigStore((state) => state.agentList);
  return useMemo(() => {
    const knowledgeGraphOn = semanticAvailable && knowledgeGraphConfig?.enabled === true;
    const choice = agentJobChoice(knowledgeGraphConfig, 'answer');
    const requirements = sourceRequirements({
      semanticEnabled: knowledgeGraphOn,
      answerCapableAgents: agentList.filter((agent) => agent.found && agent.supportsAnswerFromContext).length,
      agentSetup: answerSetupGap({ agents: agentList, configured: choice.agent, configuredModel: choice.model, requireFound: true }),
      agentChosen: Boolean(choice.agent),
    });
    return indexSourceLines({
      index,
      semanticAvailable: knowledgeGraphOn,
      summariesOn: taskSummariesOn(knowledgeGraphConfig),
      codeOn: knowledgeGraphConfig?.sourceCode !== false,
      requirements,
    });
  }, [index, semanticAvailable, knowledgeGraphConfig, agentList]);
}
