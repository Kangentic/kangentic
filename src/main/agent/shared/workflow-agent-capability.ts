import type { AgentAdapter } from '../agent-adapter';

/**
 * Whether Kangentic can run this agent as a workflow's own agent: launched
 * read-only, on a session id Kangentic chose (the workflow records it and
 * resumes the conversation by it). One test for the agent list, which offers
 * only these in Settings > Workflows, and the workflow agent's start, which
 * refuses any other.
 */
export function canBeWorkflowAgent(adapter: Pick<AgentAdapter, 'supportsReadOnlyLaunch' | 'supportsCallerSessionId'>): boolean {
  // `supportsReadOnlyLaunch` is optional on the adapter (absent means no);
  // `supportsCallerSessionId` is a required boolean.
  return adapter.supportsReadOnlyLaunch === true && adapter.supportsCallerSessionId;
}
