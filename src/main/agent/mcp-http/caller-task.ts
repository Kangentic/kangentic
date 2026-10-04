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
 */
export function resolveCallerTaskId(caller: Pick<BrowserToolDependencies, 'callerSessionId' | 'sessions'>): string | undefined {
  const { callerSessionId, sessions } = caller;
  return callerSessionId && sessions ? sessions.getSessionTaskId(callerSessionId) : undefined;
}
