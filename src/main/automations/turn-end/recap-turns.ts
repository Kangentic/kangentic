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
 * recap leaves its mark behind, and the turn the user then starts with a prompt
 * runs its rows as usual once the session went idle in between. A Ctrl+C
 * between tool calls fires no hook, and the engine idles the session only
 * after its interrupt settle (about 3 s). A prompt typed inside that window
 * still belongs to the recap's turn, so that turn runs no rows.
 *
 * The first idle alone does not end the recap's turn. An idle no Stop caused
 * (the stale-thinking watchdog, PTY silence) can land mid-turn, and the engine
 * re-stamps the turn's start when thinking resumes, so that start says nothing
 * about which turn it is. A prompt the user submitted after the idle does.
 *
 * Main-process memory only, dropped when the session leaves the registry. A
 * restart loses it, which costs nothing: a recovered session is a new spawn
 * that marks itself again.
 */

interface RecapSession {
  /** When the session first went idle, or null while its opening turn runs. */
  firstIdleAt: number | null;
  /** True once a prompt arrived after that first idle: the recap's turn is over. */
  promptedAfterIdle: boolean;
}

const recapSessions = new Map<string, RecapSession>();

/** Mark a session that opened on the recap. Call once it has spawned. */
export function markRecapSession(sessionId: string): void {
  recapSessions.set(sessionId, { firstIdleAt: null, promptedAfterIdle: false });
}

/** Record the first time a marked session went idle. */
export function noteRecapSessionIdle(sessionId: string, at: number): void {
  const entry = recapSessions.get(sessionId);
  if (entry && entry.firstIdleAt === null) entry.firstIdleAt = at;
}

/** Record a prompt the agent received, which starts a turn of its own once the session has been idle. */
export function noteRecapSessionPrompt(sessionId: string): void {
  const entry = recapSessions.get(sessionId);
  if (entry && entry.firstIdleAt !== null) entry.promptedAfterIdle = true;
}

/**
 * Whether a turn end is the one that answered the recap. A query: the turn-end
 * runner forgets the session once this answers true (`forgetRecapSession`), so
 * a caller that asks without forgetting would read every later turn with no
 * prompt behind it as the recap's.
 */
export function isRecapTurn(sessionId: string, turnStartedAt: number | null): boolean {
  const entry = recapSessions.get(sessionId);
  if (!entry || turnStartedAt === null) return false;
  // The recap's turn lasts until a prompt arrives after the first idle. A turn
  // end whose turn began before that idle is the recap's own all the same.
  if (!entry.promptedAfterIdle) return true;
  return entry.firstIdleAt !== null && turnStartedAt < entry.firstIdleAt;
}

/** Forget a session that left the registry, or whose recap turn has ended. */
export function forgetRecapSession(sessionId: string): void {
  recapSessions.delete(sessionId);
}

/** Test-only: forget every session. */
export function resetRecapSessionsForTests(): void {
  recapSessions.clear();
}
