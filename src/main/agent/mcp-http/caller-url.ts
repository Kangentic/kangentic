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
