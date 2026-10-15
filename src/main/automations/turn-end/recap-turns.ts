/**
 * Sessions that opened on an expired conversation's recap as their whole
 * prompt (`buildExpiredConversationRecap`, `whole-prompt` mode). The recap asks
 * the agent to summarize where the work stands and wait, so the turn that
 * answers it is a report for the user, not the column's work: its turn end runs
 * no On agent turn end rows and no workflow step. The column's enter messages
 * were withheld for the same reason (`AgentStartReport`).
 *
 * Bound to that one turn, never to "the next turn end". A prompted spawn seeds
 * its turn's start at the spawn, so the recap's turn began before the session
 * first went idle. A Ctrl+C ends a turn with no turn end, so an interrupted
 * recap leaves its mark behind, and a turn the user starts after it begins
 * after that first idle and runs its rows as usual.
 *
 * Main-process memory only, dropped when the session leaves the registry. A
 * restart loses it, which costs nothing: a recovered session is a new spawn
 * that marks itself again.
 */

interface RecapSession {
  /** When the session first went idle, or null while its opening turn runs. */
  firstIdleAt: number | null;
}

const recapSessions = new Map<string, RecapSession>();

/** Mark a session that opened on the recap. Call once it has spawned. */
export function markRecapSession(sessionId: string): void {
  recapSessions.set(sessionId, { firstIdleAt: null });
}

/** Record the first time a marked session went idle. */
export function noteRecapSessionIdle(sessionId: string, at: number): void {
  const entry = recapSessions.get(sessionId);
  if (entry && entry.firstIdleAt === null) entry.firstIdleAt = at;
}

/** Whether a turn end is the one that answered the recap. */
export function isRecapTurn(sessionId: string, turnStartedAt: number | null): boolean {
  const entry = recapSessions.get(sessionId);
  if (!entry || turnStartedAt === null) return false;
  return entry.firstIdleAt === null || turnStartedAt < entry.firstIdleAt;
}

/** Forget a session that left the registry. */
export function forgetRecapSession(sessionId: string): void {
  recapSessions.delete(sessionId);
}

/** Test-only: forget every session. */
export function resetRecapSessionsForTests(): void {
  recapSessions.clear();
}
