import type { IpcContext } from '../ipc/ipc-context';
import type { InjectionReport } from '../transition-engine/terminal-submit-scheduler';
import type { CommandVerifier } from '../pty/terminal-submit';
import type { Session } from '../../shared/types';
import { MOVE_MESSAGE_MAX_CHARS } from '../agent/commands/move-message-limit';
import { getProjectDb } from '../db/database';
import { SentSessionMessageRepository } from '../db/repositories/sent-session-message-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import {
  deliverAgentMessageInBackground,
  isSlashCommand,
  pasteAgentMessageInBackground,
} from '../automations/turn-end/agent-message-delivery';
import { isExpiredRecapSession } from '../automations/turn-end/recap-turns';

/**
 * Held messages (GitHub #452): a message for a task whose agent is not running
 * is held against the TASK and goes to the next agent that starts or resumes
 * there, in its opening message, after the column's own message.
 *
 * Producers, all through `holdTaskMessage`: `kangentic_send_session_message`
 * to a task with no live agent, a Move to column message into a column that
 * runs none, and the phone's chat (the mobile bridge's `send-user-message`) to
 * a task session that is not writable, a paused one above all.
 *
 * Storage: the sent-messages log (`session_messages_sent`). The `held` row is
 * the hold itself, keyed on the task with no session yet, and its status moves
 * on once: `delivered_from_hold`, `cleared`, or `failed`. Every one of those
 * writes is a compare-and-swap on `status = 'held'`.
 *
 * Delivery: `spawnAgent` and `resumeTaskSession` claim the held messages as
 * they start an agent and fold them into its opening message
 * (`composeOpeningMessage`). Every other start (startup recovery, the legacy
 * Start agent row, a queued session's promotion) and a message held while a
 * start was already under way go out through `flushHeldIfLive`, pasted once
 * the agent's first turn settles.
 *
 * Clearing: a move to Done or To Do (`clearHeldMessages`, in the move's commit
 * block), and a delete, Backlog demote or move to another project, which take
 * the task's log rows with the task (`TaskRepository.delete`).
 */

/** What a hold answers its producer. */
export type HoldOutcome =
  | { status: 'held'; displayId: number; rowId: string }
  | { status: 'refused'; error: string };

export interface HoldTaskMessageInput {
  projectId: string;
  taskId: string;
  /**
   * The message, delivered as written with nothing prepended, as a sent message
   * is. Riding a resume command line under PowerShell or cmd.exe, its `"`
   * become `'`, as in every prompt the command builders quote there.
   */
  message: string;
  /** Who sent it. All null for a human with no Kangentic session of their own. */
  callerSessionId?: string | null;
  callerTaskId?: string | null;
  callerProjectId?: string | null;
  /**
   * The producer's own last check, run once the task can hold the message and
   * just before the row is written, so a refusal above never spends what it
   * takes (a rate-limit slot). A string refuses the hold with that error.
   */
  admit?: () => string | null;
}

/**
 * Hold a message for the task's next agent: the MCP tool's and a Move to
 * column message's path when no agent runs on the task.
 *
 * Refused for a missing task, for a task in Done (archived included), and for
 * a message longer than a Move to column message may be: the move into Done
 * clears what is held, and the move out of it is a recovery move that sends no
 * messages, so anything held there would arrive stale or never. Every write
 * here is synchronous, so it takes no task lock.
 */
export function holdTaskMessage(context: IpcContext, input: HoldTaskMessageInput): HoldOutcome {
  const db = getProjectDb(input.projectId);
  const task = new TaskRepository(db).getById(input.taskId);
  if (!task) {
    return { status: 'refused', error: `No task found for "${input.taskId}".` };
  }
  const lane = new SwimlaneRepository(db).getById(task.swimlane_id);
  if (task.archived_at !== null || lane?.role === 'done') {
    return {
      status: 'refused',
      error: `Task #${task.display_id} is in Done, where no agent runs, so nothing is held for it. Move it out of Done first.`,
    };
  }
  // A held message is stored and replayed into an opening message, so it gets
  // the cap a Move to column message has.
  if (input.message.length > MOVE_MESSAGE_MAX_CHARS) {
    return {
      status: 'refused',
      error: `The message is ${input.message.length} characters; a held message can be at most ${MOVE_MESSAGE_MAX_CHARS}.`,
    };
  }
  const admitRefusal = input.admit?.() ?? null;
  if (admitRefusal !== null) return { status: 'refused', error: admitRefusal };
  const row = new SentSessionMessageRepository(db).insertHeld({
    taskId: task.id,
    message: input.message,
    caller_session_id: input.callerSessionId ?? null,
    caller_task_id: input.callerTaskId ?? null,
    caller_project_id: input.callerProjectId ?? null,
  });
  console.log(`[held-messages] Held a message for task ${task.id.slice(0, 8)} (#${task.display_id})`);
  // An agent that went live while this was being decided would never start
  // again to collect it, so it is handed over now.
  flushHeldIfLive(context, input.projectId, task.id);
  return { status: 'held', displayId: task.display_id, rowId: row.id };
}

/**
 * Several held messages as ONE message: oldest first, numbered, a blank line
 * between. A single one goes as written, with no number. No heading and no
 * sender line: a message goes in verbatim, because an attribution prefix made
 * the receiving agent read it as an injection and refuse it.
 */
export function formatHeldMessages(messages: readonly string[]): string {
  if (messages.length === 1) return messages[0];
  return messages.map((message, index) => `${index + 1}. ${message}`).join('\n\n');
}

export interface OpeningMessage {
  /** What the agent is opened with, or undefined when there is nothing to send. */
  prompt: string | undefined;
  /**
   * True when the held messages could not join the opening message and go out
   * on their own after its turn: the lead is a slash command, and text after
   * one becomes the command's arguments in some CLIs.
   */
  heldAfterTurn: boolean;
}

/**
 * The opening message of an agent that starts or resumes: the lead (the
 * column's message, the task's own command, or a plan continuation, already
 * interpolated), then the held messages after a blank line. With no lead the
 * held messages are the whole opening message. Held text is never
 * interpolated: what was sent arrives as written.
 */
export function composeOpeningMessage(lead: string | undefined, heldText: string | undefined): OpeningMessage {
  const hasLead = lead !== undefined && lead.trim() !== '';
  if (heldText === undefined || heldText === '') return { prompt: hasLead ? lead : undefined, heldAfterTurn: false };
  if (!hasLead) return { prompt: heldText, heldAfterTurn: false };
  if (isSlashCommand(lead)) return { prompt: lead, heldAfterTurn: true };
  return { prompt: `${lead}\n\n${heldText}`, heldAfterTurn: false };
}

/**
 * A task's held messages, reserved for one delivery. Settles exactly once:
 * `commit` when the agent got them, `fail` when their delivery began and did
 * not finish, `release` when nothing of them reached the agent (they go back to
 * held, for the next start). Whoever claims must settle, in a `finally` for
 * any path that hands the claim to nothing.
 */
export interface HeldClaim {
  readonly projectId: string;
  readonly taskId: string;
  readonly ids: readonly string[];
  /** The held messages as one message (`formatHeldMessages`). */
  readonly text: string;
  commit(sessionId: string): void;
  fail(reason: string): void;
  /** `flush`: hand them to the task's agent now if one is live (a newer start may have missed them). */
  release(options?: { flush?: boolean }): void;
  isSettled(): boolean;
}

/**
 * Row ids each task has claimed for a delivery in flight. In memory only: a
 * restart forgets a claim, and its rows, still `held`, go to the next start
 * rather than being lost.
 */
const claimedRowIds = new Map<string, Set<string>>();

/** Command-line rides waiting for their session to run, by session id. */
const pendingRides = new Map<string, HeldClaim>();

/** How long the flush waits after a session first runs, for a recap mark to land. */
const HELD_FLUSH_SETTLE_MS = 1_000;

/**
 * Claim the task's held messages that no other delivery holds. Null when there
 * are none. The claim reads the database once; the rows stay `held` until it
 * settles.
 */
export function claimHeldMessages(context: IpcContext, projectId: string, taskId: string): HeldClaim | null {
  let rows;
  try {
    rows = new SentSessionMessageRepository(getProjectDb(projectId)).listHeldForTask(taskId);
  } catch (error) {
    console.error(`[held-messages] Could not read the held messages of task ${taskId.slice(0, 8)}:`, error);
    return null;
  }
  const inFlight = claimedRowIds.get(taskId) ?? new Set<string>();
  const claimable = rows.filter((row) => !inFlight.has(row.id));
  if (claimable.length === 0) return null;
  const ids = claimable.map((row) => row.id);
  for (const id of ids) inFlight.add(id);
  claimedRowIds.set(taskId, inFlight);

  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    return true;
  };
  const unreserve = (): void => {
    const current = claimedRowIds.get(taskId);
    if (!current) return;
    for (const id of ids) current.delete(id);
    if (current.size === 0) claimedRowIds.delete(taskId);
  };
  // A write that fails leaves its rows `held`. They stay reserved, so this
  // process does not deliver them a second time; a restart forgets that.
  const writeThenUnreserve = (label: string, apply: (repository: SentSessionMessageRepository) => number): void => {
    try {
      const changed = apply(new SentSessionMessageRepository(getProjectDb(projectId)));
      console.log(`[held-messages] ${label}: ${changed} of ${ids.length} for task ${taskId.slice(0, 8)}`);
    } catch (error) {
      console.error(`[held-messages] Could not record ${label} for task ${taskId.slice(0, 8)}:`, error);
      return;
    }
    unreserve();
  };

  return {
    projectId,
    taskId,
    ids,
    text: formatHeldMessages(claimable.map((row) => row.message)),
    commit(sessionId: string): void {
      if (!settle()) return;
      writeThenUnreserve('Delivered held messages', (repository) => repository.markDeliveredFromHold(ids, sessionId));
    },
    fail(reason: string): void {
      if (!settle()) return;
      writeThenUnreserve('Held messages failed', (repository) => repository.markHeldFailed(ids, reason));
    },
    release(options?: { flush?: boolean }): void {
      if (!settle()) return;
      unreserve();
      if (options?.flush) flushHeldIfLive(context, projectId, taskId);
    },
    isSettled: () => settled,
  };
}

/**
 * Settle a claim from the report of the delivery that carried it. Confirmed
 * or unconfirmed (typed, and not proven) commits. A delivery that ended before
 * writing anything (`textReachedAgent: false`: superseded, the session gone,
 * the agent never ready) puts the messages back on hold, so pausing a task in
 * its first turn does not lose them. Anything else began typing and failed.
 */
export function settleClaimFromReport(claim: HeldClaim, report: InjectionReport, options: { flushOnRelease: boolean }): void {
  if (report.outcome === 'confirmed' || report.outcome === 'unconfirmed') {
    claim.commit(report.sessionId);
  } else if (report.textReachedAgent === false) {
    claim.release({ flush: options.flushOnRelease });
  } else {
    claim.fail(report.reason ?? 'The delivery did not finish.');
  }
}

/**
 * The claim rode a session's command line: it commits when that session first
 * runs, not when the spawn returns. A queued session (the concurrency cap) has
 * its command built now and run later, and a move before its promotion means
 * it never runs. A session already running commits at once; one already gone
 * releases.
 */
export function commitWhenSessionRuns(context: IpcContext, claim: HeldClaim, sessionId: string): void {
  const session = context.sessionManager.getSession(sessionId);
  if (session?.status === 'running') {
    claim.commit(sessionId);
  } else if (session?.status === 'queued') {
    // One ride per queued session. An earlier one would otherwise be dropped
    // unsettled, its rows reserved until a restart.
    pendingRides.get(sessionId)?.release({ flush: false });
    pendingRides.set(sessionId, claim);
  } else {
    claim.release({ flush: true });
  }
}

/**
 * Paste the held messages as their own message once the agent's current turn
 * ends: after a slash command, whose arguments they would otherwise become.
 * The paste waits until the scheduler holds nothing for the task, so it lands
 * after the command's own keystrokes, not among them.
 */
export function pasteHeldAfterTurn(context: IpcContext, claim: HeldClaim, sessionId: string): void {
  pasteAgentMessageInBackground(context, {
    taskId: claim.taskId,
    sessionId,
    message: claim.text,
    onOutcome: (report) => settleClaimFromReport(claim, report, { flushOnRelease: true }),
  });
}

/**
 * After a start that was given an opening message, send what did not ride its
 * command line and settle the held claim that was part of it.
 *
 * - `unsentPrompt` (the engine's `SpawnOutcome.unsentPrompt`) is typed in once
 *   the agent is ready, as one delivery. When the held messages were in the
 *   prompt, they are in it, and they settle from its report.
 * - Otherwise held messages that were in the prompt rode the command line, and
 *   commit once the session runs.
 * - Held messages that waited out a slash command are pasted after its turn.
 */
export function deliverOpeningRemainder(
  context: IpcContext,
  input: {
    taskId: string;
    sessionId: string;
    unsentPrompt: string | null;
    held: HeldClaim | null;
    /** Held messages were part of the prompt the spawn was given. */
    heldInPrompt: boolean;
    /** Held messages wait for the lead's turn (`OpeningMessage.heldAfterTurn`). */
    heldAfterTurn: boolean;
    verifier: CommandVerifier | null;
    /** Where else a typed delivery's report goes (the column message's outcome record). */
    onReport?: (report: InjectionReport) => void;
  },
): void {
  const { held } = input;
  if (input.unsentPrompt !== null && input.unsentPrompt.trim() !== '') {
    const carried = held !== null && input.heldInPrompt ? held : null;
    deliverAgentMessageInBackground(context, {
      taskId: input.taskId,
      sessionId: input.sessionId,
      message: input.unsentPrompt,
      mode: 'immediate',
      verifier: input.verifier,
      freshlySpawned: true,
      onOutcome: (report) => {
        input.onReport?.(report);
        if (carried) settleClaimFromReport(carried, report, { flushOnRelease: true });
      },
    });
  } else if (held !== null && input.heldInPrompt) {
    commitWhenSessionRuns(context, held, input.sessionId);
  }
  if (held !== null && input.heldAfterTurn) pasteHeldAfterTurn(context, held, input.sessionId);
  // A claim none of the above took goes back on hold rather than staying
  // reserved with nothing to settle it.
  if (held !== null && !input.heldInPrompt && !input.heldAfterTurn) held.release({ flush: true });
}

/**
 * Clear every message held for a task: its move to Done or To Do (a reset), or
 * its unarchive into To Do. In-flight claims are dropped with them; a delivery
 * that settles later finds its rows `cleared` and leaves them so.
 */
export function clearHeldMessages(projectId: string, taskId: string): void {
  claimedRowIds.delete(taskId);
  try {
    const cleared = new SentSessionMessageRepository(getProjectDb(projectId)).markClearedForTask(taskId);
    if (cleared > 0) console.log(`[held-messages] Cleared ${cleared} held message(s) for task ${taskId.slice(0, 8)}`);
  } catch (error) {
    console.error(`[held-messages] Could not clear the held messages of task ${taskId.slice(0, 8)}:`, error);
  }
}

/**
 * Hand a task's unclaimed held messages to its agent when one is live, as one
 * message pasted once the agent's turn has settled and the scheduler holds
 * nothing for the task, so it never lands inside the opening message's own
 * keystrokes (a second keystroke burst for a fresh session would cancel the
 * first). Does nothing for a session that opened on an expired conversation's
 * recap: the messages wait for the next start, as the column's do.
 *
 * A release from this delivery never flushes again, so a paste that keeps
 * failing cannot loop. It never throws: its callers are a hold that already
 * wrote its row and the `finally` blocks of the starts, where a throw would
 * replace the start's own error. What it cannot hand over stays held.
 */
export function flushHeldIfLive(context: IpcContext, projectId: string, taskId: string): void {
  let taken: HeldClaim | null = null;
  try {
    const session = context.sessionManager.findLiveSessionByTaskId(taskId);
    if (!session || session.transient || !context.sessionManager.isWritable(session.id)) return;
    if (isExpiredRecapSession(session.id)) return;
    const claim = claimHeldMessages(context, projectId, taskId);
    if (!claim) return;
    taken = claim;
    console.log(`[held-messages] Handing ${claim.ids.length} held message(s) to the live agent of task ${taskId.slice(0, 8)}`);
    pasteAgentMessageInBackground(context, {
      taskId,
      sessionId: session.id,
      message: claim.text,
      onOutcome: (report) => settleClaimFromReport(claim, report, { flushOnRelease: false }),
    });
  } catch (error) {
    // A claim the paste never took goes back on hold (a no-op if it settled).
    taken?.release({ flush: false });
    console.error(`[held-messages] Flush failed for task ${taskId.slice(0, 8)}:`, error);
  }
}

/**
 * Deliver held messages to agents that start outside `spawnAgent` and
 * `resumeTaskSession`, and commit the command-line rides of queued sessions.
 * Keyed on a task session's first `running` status, which a direct spawn, a
 * queued session's promotion and startup recovery all emit. The flush waits a
 * beat so a recap mark, set just after the spawn returns, has landed.
 *
 * A ride on a queued session goes back on hold when the session leaves the
 * queue without running: removed, exited, or suspended (a pause while queued
 * emits neither `exit` nor `session-removed`, only its status).
 *
 * Returns the unsubscribe, which puts back every ride still waiting.
 */
export function registerHeldMessageFlush(context: IpcContext): () => void {
  const seenRunning = new Set<string>();
  const releaseRide = (sessionId: string, flush: boolean): void => {
    const ride = pendingRides.get(sessionId);
    if (!ride) return;
    pendingRides.delete(sessionId);
    // The command that carried them never ran.
    ride.release({ flush });
  };
  const onSessionChanged = (sessionId: string, session: Session): void => {
    if (session.status !== 'running') {
      if (session.status !== 'queued') releaseRide(sessionId, true);
      return;
    }
    if (seenRunning.has(sessionId)) return;
    seenRunning.add(sessionId);
    const ride = pendingRides.get(sessionId);
    if (ride) {
      pendingRides.delete(sessionId);
      ride.commit(sessionId);
    }
    if (session.transient || !session.taskId || !session.projectId) return;
    const { taskId, projectId } = session;
    setTimeout(() => flushHeldIfLive(context, projectId, taskId), HELD_FLUSH_SETTLE_MS);
  };
  const onSessionGone = (sessionId: string): void => {
    seenRunning.delete(sessionId);
    releaseRide(sessionId, true);
  };
  context.sessionManager.on('session-changed', onSessionChanged);
  context.sessionManager.on('session-removed', onSessionGone);
  context.sessionManager.on('exit', onSessionGone);
  return () => {
    context.sessionManager.off('session-changed', onSessionChanged);
    context.sessionManager.off('session-removed', onSessionGone);
    context.sessionManager.off('exit', onSessionGone);
    for (const sessionId of [...pendingRides.keys()]) releaseRide(sessionId, false);
  };
}

/** Test-only: forget every claim and pending ride. */
export function resetHeldMessagesForTests(): void {
  claimedRowIds.clear();
  pendingRides.clear();
}
