import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { withProject, PROJECT_SELECTOR_DESCRIPTION, type McpToolResult } from './handler-helpers';
import { MUTATING_ANNOTATIONS, READ_ONLY_ANNOTATIONS } from './annotations';
import type Database from 'better-sqlite3';
import { resolveTask } from '../commands/task-resolver';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { SentSessionMessageRepository } from '../../db/repositories/sent-session-message-repository';
import type { RequestResolver } from './project-resolver';
import type { SessionSendCoordinator, SentMessageRecord } from './session-send';
import type { HoldOutcome, HoldTaskMessageInput } from '../../held-messages/held-messages';
import type { Task } from '../../../shared/types';

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
  /** `cwd` is the session's worktree directory, which the browser tools use to
   *  derive an isolated lane's cookie-jar partition. */
  findLiveSessionByTaskId(taskId: string): { id: string; cwd: string } | undefined;
  getSessionTaskId(sessionId: string): string | undefined;
  getSessionProjectId(sessionId: string): string | undefined;
  /** Whether the session has a PTY to deliver into: running, not suspended, exited or still queued. */
  isWritable(sessionId: string): boolean;
}

/** `holdTaskMessage` (src/main/held-messages), bound to main's IPC context. */
export type HeldMessageHolder = (input: HoldTaskMessageInput) => HoldOutcome;

export interface SteeringToolDependencies {
  coordinator: SessionSendCoordinator;
  sessions: SteeringSessionLookup;
  /** Holds a message for a task whose agent is not running. */
  holdTaskMessage: HeldMessageHolder;
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

/**
 * What the sending agent is told when its message is held.
 * docs/integrations/mcp-server/session-tools.md quotes it, so change both together.
 */
export function heldMessageReply(displayId: number): string {
  return `Held for task #${displayId}: no agent is running on it. It goes out when an agent starts or resumes there, `
    + 'and is cleared if the task moves to Done, To Do or Backlog, or is archived or deleted.';
}

export function registerSteeringTools(
  server: McpServer,
  resolver: RequestResolver,
  dependencies: SteeringToolDependencies,
): void {
  const { coordinator, sessions, holdTaskMessage, callerSessionId } = dependencies;

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
        'Send a message to another task\'s agent, exactly as if it had been typed into that session\'s input box. This is how one agent steers another: hand off a decision, unblock a stalled agent, answer a question a session is waiting on, or redirect work a newer decision superseded. Pair it with kangentic_get_session_events (watch for `idle` / `idle_hint`) and kangentic_get_transcript to see what the other agent is doing before and after you send. Identify the task with taskId; sessionId is optional. When the task has no running agent (paused, exited, still queued, or never started), the message is HELD for the task instead: it goes out in the opening message of the next agent that starts or resumes there, and is cleared if the task moves to Done, To Do or Backlog, or is archived or deleted. A task in Done holds nothing. The message is delivered VERBATIM - nothing is prepended, so the receiving agent sees exactly what you wrote and cannot tell it came from another agent. The one change: a held message that rides a resume command line under PowerShell or cmd.exe has each double quote turned into a single quote. Say who you are and why you are writing if that matters; provenance is recorded out-of-band in session_messages_sent, readable via kangentic_get_session_messages_sent. Delivery is not instant: it goes through the same bracketed-paste submit path a human paste uses, and takes longer when nobody has that session\'s terminal open. Pass `project` to steer a session in a different project.',
      inputSchema: z.object({
        taskId: z
          .string()
          .optional()
          .describe('Task ID (numeric display ID like "42" or full UUID). The message goes to that task\'s running agent, or is held for its next one.'),
        sessionId: z
          .string()
          .optional()
          .describe('Optional Kangentic session UUID (sessions.id) from kangentic_list_sessions. With taskId it must be that task\'s session. Alone, it names the task through its session.'),
        message: z
          .string()
          .min(1)
          .describe('The message to deliver. Write it as a prompt addressed to the receiving agent, with enough context to act on alone - it lands in a session that cannot see your conversation.'),
        deliverWhen: z
          .enum(['now', 'idle'])
          .optional()
          .describe('For a running agent only. "now" (default) delivers immediately, like a human typing mid-turn: a busy agent picks it up when its current turn ends. "idle" holds the message until the target finishes its turn, then delivers - use it when the message would be misread mid-task. Returns "queued" instead of "delivered" when it holds. A message held for a task with no running agent goes into the next agent\'s opening message either way.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, sessionId, message, deliverWhen, project }) => {
      if (!taskId && !sessionId) {
        return errorResult('Provide taskId to identify the task to send to (sessionId is optional).');
      }

      return withProject(resolver, project, async (context, resolved) => {
        const taskRepository = new TaskRepository(context.getProjectDb());
        let task: Task | undefined;
        if (taskId) {
          task = resolveTask(taskRepository, taskId);
          if (!task) {
            return errorResult(`No task found for "${taskId}". Use kangentic_list_tasks or kangentic_find_task to get a valid task ID.`);
          }
        }

        // A session id names a task too: the live registry's, else its record
        // here (a paused or exited session). Given with a taskId, it must be
        // that task's own, or the send would go to a stranger.
        if (sessionId) {
          const sessionTaskId = sessions.getSessionTaskId(sessionId)
            ?? new SessionRepository(context.getProjectDb()).findByAnyId(sessionId)?.task_id;
          if (task && sessionTaskId !== undefined && sessionTaskId !== task.id) {
            const owner = taskRepository.getById(sessionTaskId);
            return errorResult(
              `Session ${sessionId} belongs to ${owner ? `task #${owner.display_id}` : 'a different task'}, not task #${task.display_id}. Pass that task's own session, or taskId alone.`,
            );
          }
          // An id that names no session at all is not the task's either. Going
          // on by taskId alone would report success for a session never used.
          if (task && sessionTaskId === undefined && !sessions.isWritable(sessionId)) {
            return errorResult(
              `Session ${sessionId} is not a session of task #${task.display_id} in "${resolved.projectName}". Pass taskId alone, or a session id from kangentic_list_sessions.`,
            );
          }
          if (!task && sessionTaskId !== undefined) task = taskRepository.getById(sessionTaskId);
        }

        // The agent to deliver to now: the given session when it is writable,
        // else the task's live one. Prefer the registry over task.session_id,
        // which is known to drift (reconcileTaskSessionRef exists to heal it),
        // and take the drift-prone column only when the registry does not say
        // its session now belongs to a different task: liveness alone is not
        // ownership, and a stale pointer would steer a stranger. Checked in the
        // same synchronous stretch as the coordinator's own check below, so the
        // two cannot disagree.
        let targetSessionId: string | undefined;
        if (sessionId && sessions.isWritable(sessionId)) {
          targetSessionId = sessionId;
        } else if (task) {
          const liveSession = sessions.findLiveSessionByTaskId(task.id);
          const fallbackSessionId = task.session_id ?? undefined;
          if (liveSession && sessions.isWritable(liveSession.id)) {
            targetSessionId = liveSession.id;
          } else if (
            fallbackSessionId
            && sessions.isWritable(fallbackSessionId)
            && (sessions.getSessionTaskId(fallbackSessionId) ?? task.id) === task.id
          ) {
            targetSessionId = fallbackSessionId;
          }
        }

        if (!targetSessionId) {
          // No agent is running on the task: hold the message for its next one.
          if (!task) {
            return errorResult(
              `Session ${sessionId} is not running and no task in "${resolved.projectName}" owns it, so there is nothing to hold the message for. Pass taskId, or use kangentic_list_sessions.`,
            );
          }
          const callerTaskId = callerSessionId ? sessions.getSessionTaskId(callerSessionId) : undefined;
          if (callerTaskId === task.id) {
            return errorResult(
              'Refused: a session cannot send a message to its own task. To continue your own work, just keep going - this tool is for steering a DIFFERENT task.',
            );
          }
          const heldTask = task;
          const held = holdTaskMessage({
            projectId: resolved.projectId,
            taskId: heldTask.id,
            message,
            callerSessionId: callerSessionId ?? null,
            callerTaskId: callerTaskId ?? null,
            callerProjectId: callerSessionId ? sessions.getSessionProjectId(callerSessionId) ?? null : null,
            // Taken only once the task can hold it, so sends a task refuses
            // (one in Done) never use up its window.
            admit: () => (coordinator.reserveHoldSlot(heldTask.id)
              ? null
              : `Rate limit: task #${heldTask.display_id} has already had a burst of messages held for it in the last few minutes. This ceiling exists to stop runaway send loops; wait for the window to roll off before sending again.`),
          });
          if (held.status === 'refused') return errorResult(held.error);
          return { content: [{ type: 'text' as const, text: heldMessageReply(held.displayId) }] };
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
        'Read the log of messages sent INTO a session by another agent via kangentic_send_session_message. This is the debugging counterpart to that tool: it answers "did my message actually go through?" for every attempt, including the ones that never produced a turn. Each entry records the caller, the exact message text, and a status: "delivered" and "queued" produced a turn in the target\'s transcript; "refused" means a guard rejected it (the `error` field says which - self-send, a target sitting at a permission prompt, a session in another project, the hop-depth backstop, or the rate limit); "failed" means delivery was attempted and threw, or a queued message\'s target exited before it flushed, so whether a turn landed is genuinely unknown. A message sent while the task had no running agent reads "held" (no session yet) until its next agent got it ("delivered_from_hold", with that session) or the task moved to Done, To Do or Backlog first ("cleared"). Provide either taskId (covers every session the task has had and its held messages, which is usually what you want) or sessionId. Pass `project` to inspect a different project.',
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
          .enum(['delivered', 'queued', 'refused', 'failed', 'held', 'delivered_from_hold', 'cleared'])
          .optional()
          .describe('Only return attempts with this status. Use "failed" or "refused" to see just the ones that did not land cleanly, or "held" for the messages still waiting for the task\'s next agent.'),
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
