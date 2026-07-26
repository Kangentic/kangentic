import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { withProject, PROJECT_SELECTOR_DESCRIPTION, type McpToolResult } from './handler-helpers';
import { MUTATING_ANNOTATIONS, READ_ONLY_ANNOTATIONS } from './annotations';
import type Database from 'better-sqlite3';
import { resolveTask } from '../commands/task-resolver';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SentSessionMessageRepository } from '../../db/repositories/sent-session-message-repository';
import type { RequestResolver } from './project-resolver';
import type { SessionSendCoordinator, SentMessageRecord } from './session-send';

/**
 * Steering tools: the write side of the session surface.
 *
 * Everything else under `mcp-http/` either reads a session or mutates the
 * board. These tools act on a RUNNING agent, so they live in their own file
 * rather than in `session-tools.ts`: they need main-process singletons
 * (SessionManager, TerminalSubmit) that `CommandContext` deliberately does not
 * carry, and they take those at registration time the way `browser-tools.ts`
 * does. `session-tools.ts` stays a pure `commandHandlers` consumer.
 */

/** The `SessionManager` lookups the tool layer needs to resolve a target and a caller. */
export interface SteeringSessionLookup {
  findLiveSessionByTaskId(taskId: string): { id: string } | undefined;
  getSessionTaskId(sessionId: string): string | undefined;
  getSessionProjectId(sessionId: string): string | undefined;
}

export interface SteeringToolDependencies {
  coordinator: SessionSendCoordinator;
  sessions: SteeringSessionLookup;
  /**
   * The authenticated caller's session id, parsed from the MCP URL path
   * (`/mcp/<projectId>/<sessionId>`). Undefined for a human-driven client or
   * any consumer of the legacy two-segment URL. Never required.
   */
  callerSessionId?: string;
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerSteeringTools(
  server: McpServer,
  resolver: RequestResolver,
  dependencies: SteeringToolDependencies,
): void {
  const { coordinator, sessions, callerSessionId } = dependencies;

  /**
   * Persist the provenance of a sent message into the TARGET project's
   * database, resolved server-side from the authenticated URL segment so a
   * caller cannot supply, omit, or forge it.
   *
   * This is the only record that a turn arrived through the tool rather than being typed: the
   * delivered text carries no in-band marker. Caller ids are stored raw (not
   * resolved to a display id) because a cross-project caller is not resolvable
   * in this database, and a raw id keeps the row honest either way.
   */
  function makeSentMessageRecorder(targetContext: { getProjectDb: () => Database.Database }) {
    return (delivery: SentMessageRecord): void => {
      const callerTaskId = delivery.callerSessionId
        ? sessions.getSessionTaskId(delivery.callerSessionId) ?? null
        : null;
      const callerProjectId = delivery.callerSessionId
        ? sessions.getSessionProjectId(delivery.callerSessionId) ?? null
        : null;
      new SentSessionMessageRepository(targetContext.getProjectDb()).insert({
        session_id: delivery.targetSessionId,
        caller_session_id: delivery.callerSessionId ?? null,
        caller_task_id: callerTaskId,
        caller_project_id: callerProjectId,
        message: delivery.message,
        status: delivery.status,
        error: delivery.error ?? null,
      });
    };
  }

  // --- kangentic_send_session_message ---
  server.registerTool(
    'kangentic_send_session_message',
    {
      description:
        'Send a message to another task\'s RUNNING agent session, exactly as if it had been typed into that session\'s input box. This is how one agent steers another: hand off a decision, unblock a stalled agent, answer a question a session is waiting on, or redirect work a newer decision superseded. Pair it with kangentic_get_session_events (watch for `idle` / `idle_hint`) and kangentic_get_transcript to see what the other agent is doing before and after you send. Provide either taskId or sessionId. The message is delivered VERBATIM - nothing is prepended, so the receiving agent sees exactly what you wrote and cannot tell it came from another agent. Say who you are and why you are writing if that matters; provenance is recorded out-of-band in session_messages_sent, readable via kangentic_get_session_messages_sent. Delivery is not instant: it goes through the same bracketed-paste submit path a human paste uses, and takes longer when nobody has that session\'s terminal open. Pass `project` to steer a session in a different project.',
      inputSchema: z.object({
        taskId: z
          .string()
          .optional()
          .describe('Task ID (numeric display ID like "42" or full UUID). Resolves to that task\'s live session. Use this unless you already hold a session id.'),
        sessionId: z
          .string()
          .optional()
          .describe('Kangentic session UUID (sessions.id), when you already have one from kangentic_list_sessions. Mutually exclusive with taskId.'),
        message: z
          .string()
          .min(1)
          .describe('The message to deliver. Write it as a prompt addressed to the receiving agent, with enough context to act on alone - it lands in a session that cannot see your conversation.'),
        deliverWhen: z
          .enum(['now', 'idle'])
          .optional()
          .describe('"now" (default) delivers immediately, like a human typing mid-turn: a busy agent picks it up when its current turn ends. "idle" holds the message until the target finishes its turn, then delivers - use it when the message would be misread mid-task. Returns "queued" instead of "delivered" when it holds.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, sessionId, message, deliverWhen, project }) => {
      if (!taskId && !sessionId) {
        return errorResult('Provide either taskId or sessionId to identify the session to send to.');
      }
      if (taskId && sessionId) {
        return errorResult('Provide taskId or sessionId, not both.');
      }

      return withProject(resolver, project, async (context, resolved) => {
        let targetSessionId = sessionId;

        if (!targetSessionId && taskId) {
          const task = resolveTask(new TaskRepository(context.getProjectDb()), taskId);
          if (!task) {
            return errorResult(`No task found for "${taskId}". Use kangentic_list_tasks or kangentic_find_task to get a valid task ID.`);
          }
          // Prefer the registry's live session over task.session_id, which is
          // known to drift (reconcileTaskSessionRef exists to heal it). When the
          // drift-prone column IS the only candidate, refuse it if the registry
          // says that session now belongs to a different task - liveness alone
          // is not ownership, and a stale pointer would steer a stranger.
          const liveSession = sessions.findLiveSessionByTaskId(task.id);
          const fallbackSessionId = task.session_id ?? undefined;
          if (liveSession) {
            targetSessionId = liveSession.id;
          } else if (fallbackSessionId && (sessions.getSessionTaskId(fallbackSessionId) ?? task.id) === task.id) {
            targetSessionId = fallbackSessionId;
          }
          if (!targetSessionId) {
            return errorResult(
              `Task #${task.display_id} "${task.title}" has no session to send to. Move it into a column that spawns an agent, or check kangentic_list_sessions for its history.`,
            );
          }
        }

        if (!targetSessionId) {
          return errorResult('Could not resolve a target session.');
        }

        // An explicit sessionId is not proof of ownership: the coordinator's
        // liveness check reads the GLOBAL PTY registry, so a session belonging
        // to another project would deliver successfully while its provenance
        // row silently vanished (the recorder writes into THIS project's
        // database, where no matching sessions row exists, and the repository
        // skips the insert). An unrecorded send is indistinguishable from a
        // human-typed turn, so fail closed instead.
        const targetProjectId = sessions.getSessionProjectId(targetSessionId);
        if (targetProjectId && targetProjectId !== resolved.projectId) {
          return errorResult(
            `Session ${targetSessionId} belongs to a different project than "${resolved.projectName}". ` +
              'Pass `project` naming the session\'s own project so the send is recorded against it.',
          );
        }

        const outcome = await coordinator.send({
          targetSessionId,
          message,
          callerSessionId,
          deliverWhen: deliverWhen ?? 'now',
          recordSentMessage: makeSentMessageRecorder(context),
        });

        if ('error' in outcome) {
          return errorResult(outcome.error);
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(outcome, null, 2) }],
        };
      });
    },
  );

  // --- kangentic_get_session_messages_sent ---
  server.registerTool(
    'kangentic_get_session_messages_sent',
    {
      description:
        'Read the log of messages sent INTO a session by another agent via kangentic_send_session_message. This is the debugging counterpart to that tool: it answers "did my message actually go through?" for every attempt, including the ones that never produced a turn. Each entry records the caller, the exact message text, and one of four statuses: "delivered" and "queued" produced a turn in the target\'s transcript; "refused" means a guard rejected it (the `error` field says which - self-send, dead session, a target sitting at a permission prompt, a session in another project, the hop-depth backstop, or the rate limit); "failed" means delivery was attempted and threw, or a queued message\'s target exited before it flushed, so whether a turn landed is genuinely unknown. Provide either taskId (covers every session the task has had, which is usually what you want) or sessionId. Pass `project` to inspect a different project.',
      inputSchema: z.object({
        taskId: z
          .string()
          .optional()
          .describe('Task ID (numeric display ID like "42" or full UUID). Returns messages across ALL of the task\'s sessions, so a resumed or handed-off task still reports its full history.'),
        sessionId: z
          .string()
          .optional()
          .describe('Kangentic session UUID (sessions.id), to scope to one session. Mutually exclusive with taskId.'),
        status: z
          .enum(['delivered', 'queued', 'refused', 'failed'])
          .optional()
          .describe('Only return attempts with this status. Use "failed" or "refused" to see just the ones that did not land cleanly.'),
        tail: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Return only the last N attempts (most recent). Default 100.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ taskId, sessionId, status, tail, project }) => {
      if (!taskId && !sessionId) {
        return errorResult('Provide either taskId or sessionId to identify whose messages to read.');
      }
      if (taskId && sessionId) {
        return errorResult('Provide taskId or sessionId, not both.');
      }

      return withProject(resolver, project, async (context) => {
        const repository = new SentSessionMessageRepository(context.getProjectDb());
        let messages;

        if (sessionId) {
          messages = repository.listForSession(sessionId);
        } else if (taskId) {
          const task = resolveTask(new TaskRepository(context.getProjectDb()), taskId);
          if (!task) {
            return errorResult(`No task found for "${taskId}". Use kangentic_list_tasks or kangentic_find_task to get a valid task ID.`);
          }
          messages = repository.listForTask(task.id);
        } else {
          return errorResult('Could not resolve a target.');
        }

        const filtered = status ? messages.filter((sent) => sent.status === status) : messages;
        const limit = tail ?? 100;
        const window = filtered.slice(-limit);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total: filtered.length,
              returned: window.length,
              messages: window,
            }, null, 2),
          }],
        };
      });
    },
  );
}
