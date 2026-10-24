import type { AgentAdapter } from '../agent-adapter';

/**
 * Whether Kangentic can run this agent as a workflow's own agent. One test for
 * the agent list, which offers only these in Settings > Workflows, and the
 * workflow agent's start, which refuses any other.
 *
 * Two things, and read-only is not one of them:
 * - It reaches Kangentic's MCP server with a URL of its own
 *   (`kangenticMcp: 'per-session'`). The plan is saved through the workflow
 *   tools, and the server scopes them by that URL; a URL in a folder-shared
 *   file can be another session's by the time the agent reads it.
 * - Its conversation can be resumed: Kangentic chose its session id, the CLI
 *   creates one before launch (`createSessionId`), or the session's own id is
 *   captured after launch. The workflow records it and resumes by it.
 *
 * Read-only is an enhancement on top: where an adapter declares
 * `supportsReadOnlyLaunch` the agent launches without edit or shell tools, and
 * every other agent is asked by the workflow prompt to leave files alone.
 */
export function canBeWorkflowAgent(
  adapter: Pick<AgentAdapter, 'kangenticMcp' | 'supportsCallerSessionId' | 'capturesInteractiveSessionId' | 'createSessionId'>,
): boolean {
  return adapter.kangenticMcp === 'per-session' && canResumeConversationById(adapter);
}

/**
 * Whether Kangentic knows an interactive conversation's id and can resume it
 * by that id: it chose the id, the CLI creates one before launch, or the
 * session's own id is captured after launch. The workflow agent resumes by it,
 * and a Command Terminal resumes an earlier conversation the same way.
 */
export function canResumeConversationById(
  adapter: Pick<AgentAdapter, 'supportsCallerSessionId' | 'capturesInteractiveSessionId' | 'createSessionId'>,
): boolean {
  return adapter.supportsCallerSessionId
    || typeof adapter.createSessionId === 'function'
    || adapter.capturesInteractiveSessionId === true;
}
