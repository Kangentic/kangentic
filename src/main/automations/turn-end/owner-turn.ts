import type Database from 'better-sqlite3';
import { createChokepointReporter } from '../../analytics/handled-report';
import { getOpenProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import type { TranscriptAnchor } from '../../agent/shared/transcript-anchor';
import type { UserMessageRead } from '../../../shared/final-line-match';
import { readUserMessagesInTurn } from './final-reply-reader';

/**
 * How long the read may take in all, the worker's one retry included
 * (`readUserMessagesInTurn` retries 1.5 s later when the worker is restarting).
 * The move waits on it before it commits, and the agent's turn usually ends a
 * few seconds after its call. A read that outlasted that turn end would let
 * the column's turn-end rows judge a turn whose task is leaving, so a read
 * that runs out answers false and the move stays the agent's. The agent's
 * tool call never waits: `kangentic_move_task` answers at once.
 */
export const OWNER_TURN_READ_TIMEOUT_MS = 2_000;

/** A defect in the read. Its move still runs, as the agent's. */
export const ownerTurnReporter = createChokepointReporter('owner_turn');

/** What the read needs to know about a live session. `SessionManager` is one. */
export interface OwnerTurnSessions {
  getSession(sessionId: string): { projectId: string } | undefined;
  currentTurnAnchor(sessionId: string): TranscriptAnchor | null;
}

/** The read's answer, or null once `budgetMs` has passed. */
function readWithinBudget(read: Promise<UserMessageRead>, budgetMs: number): Promise<UserMessageRead | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Did the owner start the turn this session is in? True when the turn holds a
 * message the owner typed: its user messages, read from the transcript where
 * the turn began, less every text Kangentic typed into the session
 * (`session_typed_messages`, #1078).
 *
 * An agent's `kangentic_move_task` in such a turn is the owner's move, so it
 * starts a row's Frequency over (`task_moves.owner_requested`, #1100). One in
 * a turn the board started is not: a Code Review agent that sends itself back
 * after `/code-review`, which Kangentic typed, keeps its round-trip limit.
 *
 * Every doubt answers false, which leaves the move the agent's, as every move
 * an agent made was before this: no live session, no anchor, no `sessions`
 * row, an incomplete typed record, a failed or slow read, or a turn with no
 * message at all (one a task notification or a wakeup opened). The agent
 * passes nothing that decides it.
 *
 * A Command Terminal's move is never the owner's, by decision. Kangentic
 * records nothing it types into a session with no task (`recordKangenticTyped`),
 * and another agent can message one with `kangentic_send_session_message`, so
 * no read could tell those texts from the owner's. Its session has no
 * `sessions` row, so the read answers false on its own.
 *
 * Never rejects. `handleTaskMove` waits on this answer before it commits, and
 * `kangentic_move_task` fires that move without awaiting it, so a throw here
 * would fail the agent's move with no one told.
 */
export async function turnStartedByOwner(
  sessions: OwnerTurnSessions,
  sessionId: string,
  openProjectDb: (projectId: string) => Database.Database | null = getOpenProjectDb,
): Promise<boolean> {
  try {
    const session = sessions.getSession(sessionId);
    if (!session) return false;
    const transcriptAnchor = sessions.currentTurnAnchor(sessionId);
    if (transcriptAnchor === null) return false;
    const projectDb = openProjectDb(session.projectId);
    if (projectDb === null) return false;
    const read = await readWithinBudget(
      readUserMessagesInTurn(
        { sessionId, transcriptAnchor },
        new SessionRepository(projectDb),
        projectDb,
        OWNER_TURN_READ_TIMEOUT_MS,
      ),
      OWNER_TURN_READ_TIMEOUT_MS,
    );
    return read !== null && read.readable && read.messages.length > 0;
  } catch (error) {
    ownerTurnReporter.report(error);
    return false;
  }
}
