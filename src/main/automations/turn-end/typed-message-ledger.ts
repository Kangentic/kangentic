import type Database from 'better-sqlite3';
import { getOpenProjectDb } from '../../db/database';
import { SessionTypedMessageRepository, typedMessageKey } from '../../db/repositories/session-typed-message-repository';
import type { UserMessageRead } from '../../../shared/final-line-match';

/**
 * The record of what Kangentic itself typed into a session, and the read of
 * the user's last message in a turn that leaves those out (#1078).
 *
 * The agent's transcript cannot tell Kangentic's text from a person's, so a
 * Text match on the user's message drops every transcript message whose text
 * Kangentic recorded typing. This must never fail open: a column message that
 * names the sign-off phrase (the Design contract does) would otherwise move the
 * card at the first turn end. So a session whose record could not be written
 * is marked, and its reads answer "unreadable" for the rest of the run.
 */

/** Where a session lives, as the recorder needs it. */
export interface TypedMessageSessionLookup {
  getSession(sessionId: string): { projectId: string; taskId: string } | undefined;
}

/**
 * Sessions whose record is incomplete: a write failed, or a task session had
 * no database to write to. In memory, because the failure is this run's; a
 * restart starts each session's record afresh from the database it does have.
 */
const unreliableSessions = new Set<string>(); // hmr-safe: main process, no HMR

/**
 * Record one text Kangentic typed into a session. Called by `TerminalSubmit`
 * before the text is written, so a turn that ends fast still finds it. Never
 * throws: a failure marks the session unreliable instead.
 */
export function recordKangenticTyped(lookup: TypedMessageSessionLookup, sessionId: string, text: string): void {
  if (typedMessageKey(text) === null) return;
  const session = lookup.getSession(sessionId);
  // An unknown session leaves its text unaccounted for: fail closed.
  if (!session) {
    unreliableSessions.add(sessionId);
    return;
  }
  // A session with no task (a Command Terminal) runs no automations.
  if (!session.taskId) return;
  recordKangenticTypedInProject(session.projectId, sessionId, text);
}

/**
 * Record a text Kangentic gave a session some way other than typing it: the
 * prompt a spawn or a resume put on the agent's command line. A resumed
 * session starts idle, so its first turn has an anchor, and the prompt it was
 * resumed with is in that turn's transcript as a user message. Called once the
 * session's record row exists. Never throws.
 */
export function recordKangenticTypedInProject(projectId: string, sessionId: string, text: string): void {
  if (typedMessageKey(text) === null) return;
  try {
    const db = getOpenProjectDb(projectId);
    if (!db) {
      unreliableSessions.add(sessionId);
      console.warn(`[typed-message-ledger] no open database for session ${sessionId.slice(0, 8)}; its user messages will not be read`);
      return;
    }
    if (!new SessionTypedMessageRepository(db).record(sessionId, text)) {
      unreliableSessions.add(sessionId);
      console.warn(`[typed-message-ledger] session ${sessionId.slice(0, 8)} has no record row; its user messages will not be read`);
    }
  } catch (error) {
    unreliableSessions.add(sessionId);
    console.warn(`[typed-message-ledger] could not record typed text for session ${sessionId.slice(0, 8)}:`, error);
  }
}

/**
 * The user's last message among a turn's user messages, leaving out every
 * text Kangentic recorded typing into the session.
 *
 * `userMessages` is null when the transcript read failed or the agent has no
 * reader: unreadable. A session whose record is incomplete is unreadable too.
 * Fails closed on any error.
 */
export function lastUserMessage(
  projectDb: Database.Database | null,
  sessionId: string,
  userMessages: readonly string[] | null,
): UserMessageRead {
  if (userMessages === null || projectDb === null || unreliableSessions.has(sessionId)) return { readable: false };
  try {
    const typedKeys = new SessionTypedMessageRepository(projectDb).keysForSession(sessionId);
    for (let index = userMessages.length - 1; index >= 0; index -= 1) {
      const key = typedMessageKey(userMessages[index]);
      if (key === null) continue;
      if (typedKeys.has(key)) continue;
      return { readable: true, message: userMessages[index] };
    }
    return { readable: true, message: null };
  } catch (error) {
    console.warn(`[typed-message-ledger] could not read the typed record for session ${sessionId.slice(0, 8)}:`, error);
    return { readable: false };
  }
}

/**
 * Forget a removed session's unreliable mark. A removed session never ends
 * another turn, so nothing reads the mark again; dropping it keeps the set to
 * the sessions still running.
 */
export function forgetTypedMessageSession(sessionId: string): void {
  unreliableSessions.delete(sessionId);
}

/** Test seam: forget which sessions were marked unreliable. */
export function resetTypedMessageLedgerForTest(): void {
  unreliableSessions.clear();
}
