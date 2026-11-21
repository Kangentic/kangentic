/**
 * Sessions whose opening turn is a recap rather than the column's work. Its
 * turn end runs no On agent turn end rows and no workflow step. Two kinds:
 *
 * - `expired`: the session opened on an expired conversation's recap as its
 *   whole prompt (`buildExpiredConversationRecap`, `whole-prompt` mode). The
 *   recap asks the agent to summarize where the work stands and wait, so the
 *   turn that answers it is a report for the user. The column's enter messages
 *   were withheld for the same reason (`AgentStartReport`), and held messages
 *   wait for the next start (`isExpiredRecapSession`).
 * - `return` (task #952): the task came back to its main conversation after an
 *   isolated column's session, and the column's opening message is a slash
 *   command. Text put ahead of one stops it running, so the recap of what the
 *   isolated session did is the resume's whole prompt, and the agent answers it
 *   in a line. The column's message and any held messages wait for that turn
 *   to end (`whenRecapTurnEnds`) and then go as usual. Nothing is withheld.
 *
 * An `expired` recap is bound to that one turn, never to "the next turn end".
 * A prompted spawn seeds its turn's start at the spawn, so the recap's turn
 * began before the session first went idle. A Ctrl+C ends a turn with no turn
 * end, so an interrupted recap leaves its mark behind, and the turn the user
 * then starts with a prompt runs its rows as usual once the session went idle
 * in between. A Ctrl+C between tool calls fires no hook, and the engine idles
 * the session only after its interrupt settle (about 3 s). A prompt typed
 * inside that window still belongs to the recap's turn, so that turn runs no
 * rows.
 *
 * The first idle alone does not end an `expired` recap's turn. An idle no Stop
 * caused (the stale-thinking watchdog, PTY silence) can land mid-turn, and the
 * engine re-stamps the turn's start when thinking resumes, so that start says
 * nothing about which turn it is. A prompt the user submitted after the idle
 * does.
 *
 * A `return` recap is the session's first turn end, whatever its start: a
 * resumed session starts idle, so its first turn is the recap's, and the
 * column's message waits on that turn end. If it never comes (the user
 * interrupted the recap), `whenRecapTurnEnds` gives up after its wait, drops
 * the mark, and lets the message go.
 *
 * Main-process memory only, dropped when the session leaves the registry. A
 * restart loses it, which costs nothing: a recovered session is a new spawn
 * that marks itself again, and a `return` mark's waiters are told the session
 * is gone.
 *
 * A restart in place that replaces the session before its recap turn ended
 * (an account continuation at a usage limit, task #1147) carries the mark to
 * the session that replaces it (`carryRecapAcross`), so what waited on the
 * recap goes once the replacement's recap turn ends, instead of being dropped
 * with the old session.
 */

export type RecapKind = 'expired' | 'return';

interface RecapSession {
  /** The session the mark is on now. It changes when a restart carries the mark. */
  sessionId: string;
  kind: RecapKind;
  /** When the session first went idle, or null while its opening turn runs. */
  firstIdleAt: number | null;
  /** True once a prompt arrived after that first idle: the recap's turn is over. */
  promptedAfterIdle: boolean;
  /** Told once the recap's turn ends (true) or the session leaves without one (false). */
  waiters: Array<(proceed: boolean) => void>;
  /** The `whenRecapTurnEnds` bound, kept so a carried mark can start it again. */
  timeoutMs: number | null;
  /** True while the session waits at a usage limit and cannot take its recap's turn. */
  waitPaused: boolean;
  /** The running bound, cleared with the mark. */
  timer: ReturnType<typeof setTimeout> | null;
}

const recapSessions = new Map<string, RecapSession>();

/** Mark a session whose opening turn is a recap. Call once it has spawned. */
export function markRecapSession(sessionId: string, kind: RecapKind = 'expired'): void {
  const previous = recapSessions.get(sessionId);
  if (previous) settle(previous, true);
  recapSessions.set(sessionId, {
    sessionId,
    kind,
    firstIdleAt: null,
    promptedAfterIdle: false,
    waiters: [],
    timeoutMs: null,
    waitPaused: false,
    timer: null,
  });
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
  if (!entry) return false;
  // A return recap is the session's first turn end, whatever its start.
  if (entry.kind === 'return') return true;
  if (turnStartedAt === null) return false;
  // The recap's turn lasts until a prompt arrives after the first idle. A turn
  // end whose turn began before that idle is the recap's own all the same.
  if (!entry.promptedAfterIdle) return true;
  return entry.firstIdleAt !== null && turnStartedAt < entry.firstIdleAt;
}

/** The kind of recap a session opened on, or null when it opened on none (or its recap turn is over). */
export function recapKindOf(sessionId: string): RecapKind | null {
  return recapSessions.get(sessionId)?.kind ?? null;
}

/**
 * Whether a session opened on an expired conversation's recap and its recap
 * turn has not been forgotten yet. Held messages (src/main/held-messages)
 * wait out such a start, as the column's messages do. A `return` recap holds
 * nothing back, so it is not one.
 */
export function isExpiredRecapSession(sessionId: string): boolean {
  return recapSessions.get(sessionId)?.kind === 'expired';
}

/**
 * Resolve once the session's recap turn has ended (true), or it left the
 * registry first (false). True at once for a session with no mark. After
 * `timeoutMs` the mark is dropped and the wait resolves true, so a recap the
 * user interrupted never holds the column's message for good.
 */
export function whenRecapTurnEnds(sessionId: string, timeoutMs: number): Promise<boolean> {
  const entry = recapSessions.get(sessionId);
  if (!entry) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    entry.waiters.push(resolve);
    entry.timeoutMs ??= timeoutMs;
    armWait(entry);
  });
}

/** Starts the mark's bound, unless one runs, none was asked for, or the wait is paused. */
function armWait(entry: RecapSession): void {
  if (entry.timer !== null || entry.timeoutMs === null || entry.waitPaused) return;
  const timeoutMs = entry.timeoutMs;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (recapSessions.get(entry.sessionId) !== entry) return;
    console.log(`[recap-turns] The recap turn of session ${entry.sessionId.slice(0, 8)} did not end within ${Math.round(timeoutMs / 60_000)} minutes; what waited on it goes now.`);
    forgetRecapSession(entry.sessionId, true);
  }, timeoutMs);
  entry.timer.unref?.();
}

/**
 * The session waits at a usage limit with every account full, so it cannot
 * take its recap's turn. Its bound stops, or what waited on the recap would go
 * to a session that cannot answer it. It starts again, whole, on the session a
 * later restart carries the mark to (`carryRecapAcross`).
 */
export function pauseRecapTurnWait(sessionId: string): void {
  const entry = recapSessions.get(sessionId);
  if (!entry) return;
  entry.waitPaused = true;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
}

/**
 * Runs `replace`, a restart in place of `fromSessionId`, and carries that
 * session's recap mark to the session that replaces it (`replacementOf`, read
 * once `replace` settles). The replacement opens on the same recap, so its
 * first turn is the recap's, and what waited on the old session's recap goes
 * once that turn ends. The old session's removal then settles nothing.
 *
 * With no replacement (the restart failed and the task has no session), or a
 * `replace` or `replacementOf` that throws, the waiters are told the session is
 * gone, as its removal would have told them. A
 * replacement already marked takes the carried waiters into its own mark.
 */
export async function carryRecapAcross<T>(
  fromSessionId: string,
  replace: () => Promise<T>,
  replacementOf: () => string | null,
): Promise<T> {
  const entry = recapSessions.get(fromSessionId);
  if (!entry) return replace();
  recapSessions.delete(fromSessionId);
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  let result: T;
  try {
    result = await replace();
  } catch (error) {
    settle(entry, false);
    throw error;
  }
  let replacement: string | null;
  try {
    replacement = replacementOf();
  } catch (error) {
    // The mark is off the map and its bound is cleared: nothing else would ever tell the waiters.
    settle(entry, false);
    throw error;
  }
  if (replacement === null) {
    settle(entry, false);
    return result;
  }
  const existing = recapSessions.get(replacement);
  if (existing) {
    existing.waiters.push(...entry.waiters.splice(0));
    existing.timeoutMs ??= entry.timeoutMs;
    armWait(existing);
    return result;
  }
  // Only a restart that kept the old session (it failed with the session still
  // live) keeps the old session's progress through its turn.
  if (replacement !== fromSessionId) {
    entry.firstIdleAt = null;
    entry.promptedAfterIdle = false;
  }
  entry.sessionId = replacement;
  entry.waitPaused = false;
  recapSessions.set(replacement, entry);
  armWait(entry);
  return result;
}

/**
 * Forget a session whose recap turn has ended (`proceed` true, the default), or
 * that left the registry (`proceed` false). Its waiters are told which.
 */
export function forgetRecapSession(sessionId: string, proceed = true): void {
  const entry = recapSessions.get(sessionId);
  if (!entry) return;
  recapSessions.delete(sessionId);
  settle(entry, proceed);
}

function settle(entry: RecapSession, proceed: boolean): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  const waiters = entry.waiters.splice(0);
  for (const resolve of waiters) resolve(proceed);
}

/** Test-only: forget every session. */
export function resetRecapSessionsForTests(): void {
  for (const entry of recapSessions.values()) settle(entry, false);
  recapSessions.clear();
}
