import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { MUTATING_ANNOTATIONS } from './annotations';
import type { McpToolResult } from './handler-helpers';
import { looksLikeShellId } from '../../activity-engine/background-shell/looks-like-shell-id';
import { NO_ACTIVITY_HOLD_FLAG } from '../../../shared/background-shell-hold';
import type { BackgroundShellServiceOutcome } from '../../activity-engine/engine';

/**
 * The agent's way to say a background shell it started is a service, not work
 * it is waiting on (task #857).
 *
 * A background shell holds its session `thinking` until it exits, so a dev
 * server or watcher left running kept the task busy forever and the column's
 * On agent turn end automations never ran. Only the agent knows whether a
 * shell is a build it waits on or a server it leaves up, so Kangentic asks it:
 * where its CLI can add context beside a tool result, a post-tool hook names
 * this tool beside every background launch that carries no
 * `--kangentic-no-activity-hold` flag (`background-shell-hint-bridge.js`), and
 * the agent answers here by shell id. The tool is offered only to a session
 * whose agent reports background commands (`AgentAdapter.backgroundCommands`).
 *
 * The caller can only mark its own session's shells: the session comes from
 * the MCP URL (`/mcp/<projectId>/<callerSessionId>`), never from a parameter.
 */

/** The `SessionManager` calls this tool needs. */
export interface BackgroundShellServiceMarker {
  markBackgroundShellsAsServices(sessionId: string, shellIds: readonly string[]): BackgroundShellServiceOutcome[] | null;
  /** Whether the session's agent reports background commands; the tool is offered only then. */
  reportsBackgroundCommands(sessionId: string): boolean;
}

export interface BackgroundShellToolDependencies {
  sessions: BackgroundShellServiceMarker;
  /** The caller's session id from the MCP URL. Undefined for a client that is not a Kangentic session. */
  callerSessionId?: string;
}

/** Most shell ids one call may name. An agent leaves a handful of services up, not dozens. */
const MAX_SHELL_IDS_PER_CALL = 10;

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function describeOutcome(entry: BackgroundShellServiceOutcome): string {
  switch (entry.outcome) {
    case 'marked':
      return `${entry.shellId}: marked as a service. It keeps running, and the task no longer waits on it.`;
    case 'already-marked':
      return `${entry.shellId}: already marked as a service.`;
    case 'pending':
      return `${entry.shellId}: Kangentic has not seen this shell start yet. It is marked as a service as soon as it does.`;
  }
}

export function registerBackgroundShellTools(
  server: McpServer,
  dependencies: BackgroundShellToolDependencies,
): void {
  const { sessions, callerSessionId } = dependencies;

  server.registerTool(
    'kangentic_mark_background_service',
    {
      // The second-to-last sentence is the only guidance an agent with no
      // launch hint gets (Grok, Kimi, Codex: their CLIs cannot add context at
      // a launch), so it says when to call, not only what a call does (task #859).
      description:
        'Mark background shells you started as services meant to keep running after your turn, such as a dev server or a watcher, rather than work you are waiting on. Kangentic shows your task as working, and holds the column\'s turn-end automations, until every background shell you started exits; a marked shell no longer counts, and it keeps running. Do not mark a build or test run you are waiting for. '
        + `Call this as soon as you start such a service in the background, or put ${NO_ACTIVITY_HOLD_FLAG} in its command when you start it. `
        + 'Pass the shell ids your background commands returned.',
      inputSchema: z.object({
        shellIds: z
          .array(z.string())
          .min(1)
          .max(MAX_SHELL_IDS_PER_CALL)
          .describe('Background shell ids, as your background command returned them (the shell, task or process id).'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ shellIds }) => {
      const malformed = shellIds.filter((shellId) => !looksLikeShellId(shellId));
      if (malformed.length > 0) {
        return errorResult(
          `Not a background shell id: ${malformed.map((shellId) => JSON.stringify(shellId)).join(', ')}. `
          + 'Pass the id your background command returned, which is letters, digits, "-" or "_". Nothing was changed.',
        );
      }
      if (!callerSessionId) {
        return errorResult(
          'This tool marks shells of the Kangentic task session that calls it, and this connection does not come from one. Nothing was changed.',
        );
      }
      const outcomes = sessions.markBackgroundShellsAsServices(callerSessionId, [...new Set(shellIds)]);
      if (outcomes === null) {
        return errorResult(
          'Kangentic has no running session for this connection, so nothing was changed.',
        );
      }
      return {
        content: [{ type: 'text' as const, text: outcomes.map(describeOutcome).join('\n') }],
      };
    },
  );
}
