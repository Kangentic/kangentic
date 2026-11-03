import type { SessionManager } from './session-manager';

/**
 * Has the session's turn settled for a consumer that acts on the agent's
 * reply: idle, or, for a caller that asked (`acceptHeld`), held only by
 * background work its ended turn left (`SessionManager.isTurnHeldByBackgroundWork`).
 * The held case is a running workflow's alone: off a workflow, a column's
 * automations still wait for the work to drain.
 *
 * A permission prompt is never settled: it waits on the user mid-turn, and
 * keys typed into it answer it. Nothing here checks for one. The engine never
 * reports a turn held while a prompt is open, because permission outranks
 * `background-shell` in its reason ladder.
 */
export function isTurnSettled(
  sessionManager: Pick<SessionManager, 'getActivityCache' | 'isTurnHeldByBackgroundWork'>,
  sessionId: string,
  options: { acceptHeld?: boolean } = {},
): boolean {
  // activity-state-ok: granular, only idle is a settled turn.
  if (sessionManager.getActivityCache()[sessionId] === 'idle') return true;
  return options.acceptHeld === true && sessionManager.isTurnHeldByBackgroundWork(sessionId);
}
