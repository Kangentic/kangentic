/**
 * The Workflow agent: which agent, model and effort every workflow's own agent
 * runs on, and what is still missing before one can start.
 *
 * SHARED, because three places need the same answer: the Settings card, the
 * Workflows view's pane (which shows the setup state instead of starting), and
 * the main process (which refuses a start). If the pane and main disagreed, the
 * pane would start an agent main refuses, or ask for a setting already made.
 *
 * EXPLICIT, with no fallback. The workflow agent used to run on the project's
 * default agent, model and effort, so a user who set a small model for the
 * Automation agent watched the planner start on the project's largest one. It is
 * now one global choice, made in Settings > Workflows, and nothing starts until
 * it is made (the rule `answer-agent.ts` already follows for the Knowledge Graph
 * and the Automation agent).
 *
 * Kept apart from `answerSetupGap` on purpose. The two read different
 * capabilities (`supportsWorkflowAgent` and the CLI's own `--model` support, not
 * an answer run's), and this one never asks whether the CLI is installed: main
 * detects it right after and the pane shows main's reason, where an answer run
 * has no such reason to show and treats a missing CLI as unchosen.
 */

import type { AppConfig } from './types';

type WorkflowsConfig = NonNullable<AppConfig['workflows']>;

export interface WorkflowAgentChoice {
  agent: string | null;
  model: string | null;
  /** The configured level, or null for the CLI's own. */
  effort: string | null;
}

/** The Workflow agent's choice (`AppConfig.workflows`). */
export function workflowAgentChoice(config: WorkflowsConfig | undefined): WorkflowAgentChoice {
  return {
    agent: config?.agent ?? null,
    model: config?.model ?? null,
    effort: config?.effort ?? null,
  };
}

export interface WorkflowAgentCandidate {
  name: string;
  supportsWorkflowAgent?: boolean;
  capabilities?: { supportsModelOverride?: boolean };
}

/**
 * What is still missing before a workflow agent can start, or null when nothing is.
 *
 * `'agent'` covers every way the choice is not usable: never chosen, unknown, or
 * not one Kangentic can run as a workflow's agent. `'model'` means the agent is
 * fine but its CLI takes a model and none has been chosen. Effort is never
 * required.
 *
 * An agent that is chosen but not installed is no gap. The pane and main read
 * the same answer, and main's start detects the CLI right after this check, so
 * the pane shows that precise reason ("cannot find ... on this machine") rather
 * than asking again for a choice already made.
 */
export function workflowAgentSetupGap<T extends WorkflowAgentCandidate>(input: {
  agents: ReadonlyArray<T>;
  choice: WorkflowAgentChoice;
}): 'agent' | 'model' | null {
  const { agents, choice } = input;
  if (!choice.agent) return 'agent';
  const candidate = agents.find((entry) => entry.name === choice.agent);
  if (!candidate || !candidate.supportsWorkflowAgent) return 'agent';
  if (candidate.capabilities?.supportsModelOverride === true && !choice.model) return 'model';
  return null;
}
