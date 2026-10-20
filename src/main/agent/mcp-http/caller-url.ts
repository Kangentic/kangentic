/**
 * Caller-identity URL segment for the MCP HTTP server.
 *
 * Deliberately a standalone, dependency-free module rather than a helper on
 * `mcp-http-server.ts`: its consumers are the two agent-spawn chokepoints
 * (`prepare-spawn.ts` and `transition-engine.ts`), and importing it from the
 * server module would drag the entire MCP tool graph (the SDK, every
 * `*-tools.ts` file, the DB repositories, the browser/CDP surface) into their
 * module load for the sake of one string concatenation.
 */

/**
 * Append the caller's session id to a project-scoped MCP URL, producing
 * `/mcp/<projectId>/<sessionId>`.
 *
 * The server otherwise has no way to know WHICH session is calling: the token
 * is per-launch and the URL is per-project. Stamping the spawning session's own
 * id into its own `mcp.json` makes caller identity correct by construction - it
 * is written, never looked up, so it cannot drift - and takes it out of the set
 * of things the agent can choose through the tool's own parameters. That is
 * what lets `kangentic_send_session_message` refuse self-sends, track a steer
 * chain server-side, and attribute a relayed message truthfully instead of
 * trusting a caller-supplied field.
 *
 * This is honesty-by-default, NOT cryptographic attribution. The bearer token
 * is one shared per-launch secret every spawned agent holds, and the server
 * does not verify that the segment names a real or currently-connected session,
 * so a process with the token (an agent has both the token and shell access)
 * can dial any caller id via a raw HTTP request. The guards this feeds are
 * circuit breakers against a looping or careless agent, not a defense against a
 * deliberately lying one. A real guarantee would need a per-session secret
 * distinct from the session id, which `kangentic_list_sessions` already exposes.
 *
 * Returns undefined when there is no URL (MCP server disabled or not yet
 * listening), so call sites can pass the result straight through.
 */
export function appendCallerSession(
  projectUrl: string | undefined,
  callerSessionId: string,
): string | undefined {
  if (!projectUrl) return undefined;
  return `${projectUrl}/${callerSessionId}`;
}

/**
 * The caller segment prefix that marks a Knowledge Graph answer run.
 *
 * An answer run is not a task session: it is a headless agent reading the
 * user's own history to answer a question, and it must be able to change
 * nothing. The server gives a caller with this prefix exactly one tool,
 * `kangentic_search` (see `buildAnswerMcpServer`), whatever the agent's own
 * permission handling does. That matters because several CLIs cannot be told
 * to call one tool and refuse the rest: Cursor's `--force` approves every call,
 * and OpenCode called an MCP tool without asking in the probe. So the server
 * is the guarantee, and the CLI flags are a second lock at best.
 */
export const ANSWER_CALLER_PREFIX = 'answer-';

/**
 * The MCP URL for one Knowledge Graph chat's answer runs:
 * `/mcp/<projectId>/answer-<chatId>`.
 *
 * Keyed by the CHAT, not by one question, because a warm answer session's MCP
 * URL is fixed when its process starts, so every later turn's searches arrive
 * on the first turn's URL.
 */
export function appendAnswerCaller(projectUrl: string, chatId: string): string {
  return `${projectUrl}/${ANSWER_CALLER_PREFIX}${chatId}`;
}

/** True for a caller segment minted by `appendAnswerCaller`. */
export function isAnswerCaller(callerSessionId: string | undefined): boolean {
  return callerSessionId !== undefined && callerSessionId.startsWith(ANSWER_CALLER_PREFIX);
}

/**
 * The caller segment prefix that marks a workflow's own agent.
 *
 * That agent plans a workflow. It is launched read-only where its CLI can
 * enforce that, and every other agent is asked by its first message to leave
 * files alone. The server gives a caller with this prefix the read-only tools
 * and the planning tools only (see `buildWorkflowAgentMcpServer`), so a tool
 * that creates, moves or deletes board work is not there to call, whatever the
 * CLI's own permissions allow.
 */
export const WORKFLOW_AGENT_CALLER_PREFIX = 'workflow-';

/** The MCP URL for one workflow's agent: `/mcp/<projectId>/workflow-<workflowId>`. */
export function appendWorkflowAgentCaller(projectUrl: string | undefined, workflowId: string): string | undefined {
  if (!projectUrl) return undefined;
  return `${projectUrl}/${WORKFLOW_AGENT_CALLER_PREFIX}${workflowId}`;
}

/** The workflow a `appendWorkflowAgentCaller` segment names, or null for any other caller. */
export function workflowIdOfCaller(callerSessionId: string | undefined): string | null {
  if (callerSessionId === undefined || !callerSessionId.startsWith(WORKFLOW_AGENT_CALLER_PREFIX)) return null;
  const workflowId = callerSessionId.slice(WORKFLOW_AGENT_CALLER_PREFIX.length);
  return workflowId.length > 0 ? workflowId : null;
}

/**
 * True when a spawn's MCP URL names a task session as its caller
 * (`appendCallerSession`): a third path segment that is neither an answer run
 * nor a workflow's own agent. Only such a caller is offered the tools that act
 * on the calling session itself (`kangentic_mark_background_service`), so a
 * spawn uses this to decide whether to point its agent at them.
 */
export function urlNamesTaskSessionCaller(mcpServerUrl: string | undefined): boolean {
  if (!mcpServerUrl) return false;
  let pathname: string;
  try {
    pathname = new URL(mcpServerUrl).pathname;
  } catch {
    return false;
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 3 || segments[0] !== 'mcp') return false;
  const caller = segments[2];
  return !isAnswerCaller(caller) && workflowIdOfCaller(caller) === null;
}
