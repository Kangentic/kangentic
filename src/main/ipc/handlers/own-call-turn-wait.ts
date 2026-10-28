import type { SessionManager } from '../../pty/session-manager';
import { waitForTurnCompletion } from '../../transition-engine/turn-completion';

/**
 * An MCP call by a task's own agent session that ends that same session, and
 * the turn that made the call.
 *
 * `kangentic_move_task` replies at once and fires the move, and a move that
 * ends the caller's session (Done, a column with no agent, an isolated or
 * always-fresh column, an agent handoff, a model or effort restart) used to
 * suspend it 2 to 4 ms after the commit. The console close is Claude's graceful
 * exit, and Claude left without writing the move's tool call or its result to
 * its transcript: measured on #916 twice (PostToolUse even ran) and on #915's
 * Done move (it never did). The next resume of that conversation had no record
 * of the move, so the agent made it again, and in a Testing <-> Code Review
 * workflow that costs a review pass each time. `kangentic_pause_workflow` had
 * the same shape: it suspended every member, the caller included, before it
 * replied, so after a Resume the agent paused its workflow again.
 *
 * So such a call ends the caller's session only after the caller's turn ends,
 * on the predicate the turn-end runner already acts on: once the session is
 * idle and its PTY quiet, the turn is in the transcript (the runner reads its
 * final reply from there at that point).
 *
 * The session is marked while the call is still taking effect. For a move that
 * is its whole Phase 1, from the commit: the source column's exit rows run
 * between the commit and the wait, and one that waits for the caller's turn
 * lets that turn end land while the task already sits in the new column and its
 * `session_id` still names the caller. For a pause it is the wait and the
 * pause. The turn-end runner, the workflow recovery and the idle notifications
 * read the mark and leave that turn alone: it belongs to the column the task
 * left, or to a workflow that is now paused, and the session is about to end.
 *
 * Dependency-light on purpose, like `task-move-controllers.ts`, so the
 * turn-end runner can read the mark without the move handler's import cone.
 */

/**
 * How long a call waits for its caller's turn to end. The turn after the call
 * is usually one short reply, but a long conversation can take several seconds
 * just to start it (#916's had 559k tokens of context). Past the bound the
 * session ends mid-turn, as every such call did before.
 */
export const OWN_CALL_TURN_WAIT_MS = 30_000;

/**
 * Sessions whose own call is still taking effect, with how many calls each
 * has. One turn can hold two: a move of its task and a pause of its workflow.
 * A move's release also runs outside the task lock, after the next move of
 * the task may have marked. So each release drops only its own call.
 */
const ownCallCounts = new Map<string, number>();

/** Mark a session while its own call takes effect. Returns the release, which runs once. */
export function markOwnCallSession(sessionId: string): () => void {
  ownCallCounts.set(sessionId, (ownCallCounts.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (ownCallCounts.get(sessionId) ?? 1) - 1;
    if (remaining > 0) ownCallCounts.set(sessionId, remaining);
    else ownCallCounts.delete(sessionId);
  };
}

/** True while any of the session's own calls is still taking effect. */
export function isSessionInOwnCall(sessionId: string): boolean {
  return ownCallCounts.has(sessionId);
}

/**
 * Wait for the calling agent's turn to end, then return, whatever happened.
 * `call` names what the agent did, for the log line ("moved its task"). A
 * newer move of the task aborts a move (`abortInFlightMove`) and with it the
 * wait. A session that exited needs no wait. At the bound, the call goes on
 * and ends the session mid-turn.
 */
export async function waitForOwnAgentTurn(
  sessionManager: SessionManager,
  sessionId: string,
  call: string,
  signal?: AbortSignal,
): Promise<void> {
  // An exit before the wait starts sends no event the wait could hear, so a
  // session that is no longer running would hold the call to the bound.
  if (sessionManager.getSession(sessionId)?.status !== 'running') return;
  const startedAt = Date.now();
  const settled = await waitForTurnCompletion(sessionManager, sessionId, { signal, timeoutMs: OWN_CALL_TURN_WAIT_MS });
  const waitedMs = Date.now() - startedAt;
  if (settled === 'completed') {
    console.log(`[OWN_CALL] Session ${sessionId.slice(0, 8)} ended the turn in which it ${call} (${waitedMs} ms); ending the session now.`);
  } else {
    console.warn(`[OWN_CALL] Session ${sessionId.slice(0, 8)} ${call}, and the wait for its turn ended ${settled} after ${waitedMs} ms; ending the session now.`);
  }
}
