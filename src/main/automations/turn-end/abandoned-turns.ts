import type { TurnEndedPayload } from '../../pty/session-manager';

/**
 * Turn ends whose pass gave up because newer work began, kept until that work
 * ends one way or another.
 *
 * A pass judges only the session's latest turn (`isLatestTurn`), and leaves a
 * newer turn to its own turn end. Some newer work never gets one. An internal
 * CLI agent's tool start after a Stop reopened the turn with no Stop to follow
 * (the engine now only logs those), and a turn whose Stop was lost ends by a
 * watchdog or an idle hint, neither of which is a turn end. The rows the first
 * turn end was owed were then lost for good, and the card sat in the column
 * until a person moved it.
 *
 * So when the newer work ends with no turn end, the runner judges the earlier
 * reply after all, but only when that work changed nothing a person would
 * judge instead:
 *
 * - no prompt reached the agent, and nothing was interrupted or failed, since
 *   the earlier turn end (`userWorkMark`): the user acted, and the turn the
 *   user started owns what happens next. This sees only what reaches the
 *   event stream: a hook's interrupt, a failed turn, the Ctrl+C the terminal
 *   synthesizes. An Esc between tool calls and a denied permission prompt
 *   report nothing, so they do not count on newer work no prompt began;
 * - the newer work wrote no reply of its own (read from where it began);
 * - no turn end of its own arrived (`turnEndMark`), which forgets the entry at
 *   once and stops a pass still running for an older turn from keeping one.
 *
 * Main-process memory only. A restart loses it, which costs what the bug did
 * before: a person moves the card.
 */

export interface AbandonedTurn {
  payload: TurnEndedPayload;
  /**
   * The column the abandoned pass judged for. A move out of it forgets the
   * entry, and a reclaimed pass runs only while the task is still there, since
   * a move made while the reclaim reads finds no entry left to forget.
   */
  columnId: string;
  /** `userWorkMark` when the abandoned turn ended. */
  userWorkMarkAtTurnEnd: number;
  /** `turnEndMark` when the abandoned turn ended. */
  turnEndMarkAtTurnEnd: number;
}

/** Per session: how many prompts, interrupts and failed turns it has seen. */
const userWorkCounts = new Map<string, number>();
/** Per session: how many turn ends it has seen. */
const turnEndCounts = new Map<string, number>();
const abandonedTurns = new Map<string, AbandonedTurn>();

/** Count a prompt the agent received, or an interrupt or failed turn: work the user owns what follows. */
export function noteUserWork(sessionId: string): void {
  userWorkCounts.set(sessionId, (userWorkCounts.get(sessionId) ?? 0) + 1);
}

/** The session's user-work count now. A counter, not a clock, so a WSL guest's drift never matters. */
export function userWorkMark(sessionId: string): number {
  return userWorkCounts.get(sessionId) ?? 0;
}

/**
 * A turn end of the session's own arrived: count it, and forget the session's
 * abandoned turn end, since this newer turn's pass judges instead. Called
 * synchronously as the turn end is emitted, ahead of the pass it schedules.
 */
export function noteTurnEnded(sessionId: string): void {
  turnEndCounts.set(sessionId, (turnEndCounts.get(sessionId) ?? 0) + 1);
  abandonedTurns.delete(sessionId);
}

/** The session's turn-end count now. */
export function turnEndMark(sessionId: string): number {
  return turnEndCounts.get(sessionId) ?? 0;
}

/**
 * Keep a turn end whose pass gave up because newer work began. One per
 * session: the newest wins. Not when a turn end of the session's own arrived
 * since it ended: that turn's pass judges it.
 */
export function noteAbandonedTurn(entry: AbandonedTurn): void {
  if (turnEndMark(entry.payload.sessionId) !== entry.turnEndMarkAtTurnEnd) return;
  abandonedTurns.set(entry.payload.sessionId, entry);
}

export function hasAbandonedTurn(sessionId: string): boolean {
  return abandonedTurns.has(sessionId);
}

/** Take the session's abandoned turn end, if any, so no second idle judges it again. */
export function takeAbandonedTurn(sessionId: string): AbandonedTurn | null {
  const entry = abandonedTurns.get(sessionId) ?? null;
  abandonedTurns.delete(sessionId);
  return entry;
}

/** Forget a task's abandoned turn ends because the task is moving out of the column they were for. */
export function forgetAbandonedTurnsForTask(taskId: string): void {
  for (const [sessionId, entry] of abandonedTurns) {
    if (entry.payload.taskId === taskId) abandonedTurns.delete(sessionId);
  }
}

/** Forget everything about a session that left the registry. */
export function forgetAbandonedTurnSession(sessionId: string): void {
  abandonedTurns.delete(sessionId);
  userWorkCounts.delete(sessionId);
  turnEndCounts.delete(sessionId);
}

/** Test-only: forget every session. */
export function resetAbandonedTurnsForTests(): void {
  abandonedTurns.clear();
  userWorkCounts.clear();
  turnEndCounts.clear();
}
