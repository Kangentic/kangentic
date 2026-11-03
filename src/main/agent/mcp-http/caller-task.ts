import type { BrowserToolDependencies } from './browser-tools';
import { commandTerminalBrowserOwner } from '../../../shared/browser-owner';

/**
 * Who is calling, from the session in the MCP URL. Resolved ONCE per request by
 * the server builder, not per tool call: the McpServer is rebuilt for every
 * HTTP request, so the value can never go stale.
 *
 * A Command Terminal's session carries a synthetic `taskId` (its process tag, a
 * fresh uuid with no task row; `transient-sessions.ts`). Handing that out as
 * the caller's task would make every task-keyed consumer treat it as a board
 * task: the workflow lock, the dev-port defaults, the steering self-send check,
 * the automation tools, and the browser tools, whose `open_pane` would answer
 * `task-not-found`. So a Command Terminal resolves to its SLOT and never to a
 * task id.
 *
 * The segment is the caller's word, behind only the server's shared token: an
 * agent that put another task's session id in its URL would read as that
 * task's own agent. So the workflow lock it unlocks guards against mistakes
 * (an agent moving the wrong card), not against an agent working to get round
 * it, which the token already lets act on the whole board.
 */
export interface McpCaller {
  /** The caller's own board task, when its session runs on one. */
  taskId?: string;
  /** The caller's Command Terminal slot, when its session is a Command Terminal. */
  commandTerminalSlot?: string;
}

export function resolveMcpCaller(caller: Pick<BrowserToolDependencies, 'callerSessionId' | 'sessions'>): McpCaller {
  const { callerSessionId, sessions } = caller;
  if (!callerSessionId || !sessions) return {};
  const commandTerminalSlot = sessions.getCommandTerminalSlot?.(callerSessionId);
  if (commandTerminalSlot) return { commandTerminalSlot };
  const taskId = sessions.getSessionTaskId(callerSessionId);
  return taskId ? { taskId } : {};
}

/**
 * The calling agent's own BOARD task. Undefined for a Command Terminal, a
 * workflow agent with no task, an unknown session, or no session at all, so
 * every task-keyed consumer sees exactly what it saw before Command Terminals
 * named their session.
 */
export function resolveCallerTaskId(caller: Pick<BrowserToolDependencies, 'callerSessionId' | 'sessions'>): string | undefined {
  return resolveMcpCaller(caller).taskId;
}

/**
 * The key the browser family scopes the caller's own surface by: its task id,
 * or its Command Terminal's owner key (`commandTerminalBrowserOwner`). The
 * browser registry, opener, lanes and URL sidecar all key a surface by this
 * one string, so a Command Terminal's pane is its OWN, never "the single pane
 * open in the project".
 */
export function callerBrowserOwner(projectId: string, caller: McpCaller): string | undefined {
  if (caller.commandTerminalSlot) return commandTerminalBrowserOwner(projectId, caller.commandTerminalSlot);
  return caller.taskId;
}
