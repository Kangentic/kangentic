import type { BrowserToolDependencies } from './browser-tools';

/**
 * The calling agent's own task, from the session in its MCP URL. Resolved ONCE
 * per request by the server builder, not per tool call: the McpServer is
 * rebuilt for every HTTP request, so the value can never go stale. Two tool
 * families read it: the browser tools scope their default pane to it, and the
 * move tool's workflow lock lets a task's own agent move it.
 *
 * A missing lookup or an unknown session leaves it undefined, which degrades
 * the browser default to "the single pane in my project" rather than refusing.
 *
 * The segment is the caller's word, behind only the server's shared token: an
 * agent that put another task's session id in its URL would read as that
 * task's own agent. So the workflow lock it unlocks guards against mistakes
 * (an agent moving the wrong card), not against an agent working to get round
 * it, which the token already lets act on the whole board.
 */
export function resolveCallerTaskId(caller: Pick<BrowserToolDependencies, 'callerSessionId' | 'sessions'>): string | undefined {
  const { callerSessionId, sessions } = caller;
  return callerSessionId && sessions ? sessions.getSessionTaskId(callerSessionId) : undefined;
}
