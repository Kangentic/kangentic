import type Database from 'better-sqlite3';
import { createChokepointReporter } from '../../analytics/handled-report';
import { getOpenProjectDb } from '../../db/database';
import { SessionRepository, type CarriedOwnerTurn, type StoredTurnPosition } from '../../db/repositories/session-repository';
import type { TurnAnchorPayload } from '../../pty/session-manager';
import type { TranscriptAnchor } from '../../agent/shared/transcript-anchor';
import type { UserMessageRead } from '../../../shared/final-line-match';
import { readUserMessagesInTurn } from './final-reply-reader';

/**
 * A turn a restart cut off before its Stop, and the owner's message in it.
 *
 * A Text match on the user's message reads the messages of the turn that
 * ended (#1078), from where that turn began in the transcript. That position
 * lived only in memory, so a restart in the middle of a turn lost it: the
 * owner typed "signed off", Kangentic restarted before the agent's reply, and
 * the turn that recovery's nudge started ended with only the nudge to read.
 * The column's move never ran (kangentic-mobile #160).
 *
 * So a task session's open turn is kept on its `sessions` row
 * (`recordOpenTurn`), a recovery resume hands it to the record it starts
 * (`SessionRepository.carryOpenTurn`), and the session's first turn-end pass
 * takes it (`takeCarriedOwnerTurn`). When the turn that ended holds no message
 * of the owner's, that pass reads from where the cut-off turn began instead
 * (`readUserMessagesWithCarriedTurn`), so the one read covers the owner's
 * message, the interrupted work and the nudge.
 *
 * What is kept is a transcript position, never the owner's words. The carried
 * turn counts only within the column visit it began in, and only once: a
 * newer message of the owner's, a move (by hand or by a row) or a different
 * conversation file drops it. Nothing reads it at resume time, so no card
 * moves before the resumed agent has finished its turn. Kangentic's own texts
 * under every record the read spans are left out, so the nudge never counts as
 * the owner's.
 */

/** A failed write or read of a carried turn. The turn end goes on as before. */
export const carriedOwnerTurnReporter = createChokepointReporter('carried_owner_turn');

/** The stored form of a turn's start, or null when the turn has no anchor. */
export function storedTurnPositionOf(anchor: TranscriptAnchor | null, turnStartedAt: number | null): StoredTurnPosition | null {
  if (!anchor || turnStartedAt === null) return null;
  return { agentSessionId: anchor.agentSessionId, byteOffset: anchor.byteOffset, startedAt: new Date(turnStartedAt).toISOString() };
}

/**
 * Keep a task session's open turn on its row (`'turn-anchor'`), or clear it
 * when its turn end took it. Never throws: a failed write leaves a restart
 * with nothing to carry, which is today's behavior.
 */
export function recordOpenTurn(
  payload: TurnAnchorPayload,
  openProjectDb: (projectId: string) => Database.Database | null = getOpenProjectDb,
): void {
  try {
    const projectDb = openProjectDb(payload.projectId);
    if (!projectDb) return;
    new SessionRepository(projectDb).setOpenTurn(payload.sessionId, storedTurnPositionOf(payload.anchor, payload.turnStartedAt));
  } catch (error) {
    carriedOwnerTurnReporter.report(error);
  }
}

/**
 * Hand the record a recovery resume just wrote the turn its old record left
 * open (or carried in itself). Never throws: a failed carry fails no resume,
 * it only leaves the next turn end with its own turn to read.
 */
export function carryInterruptedTurn(sessionRepo: SessionRepository, fromRecordId: string, toRecordId: string): void {
  try {
    const carried = sessionRepo.carryOpenTurn(fromRecordId, toRecordId);
    if (carried) {
      console.log(
        `[SESSION_RECOVERY] Carried the turn a restart cut off from ${fromRecordId.slice(0, 8)} to ${toRecordId.slice(0, 8)} `
        + `(it spans ${carried.recordIds.length} earlier record(s)).`,
      );
    }
  } catch (error) {
    carriedOwnerTurnReporter.report(error);
  }
}

/** The carried turn of a session's record, taken. Null on any failure: the pass reads its own turn. */
export function takeCarriedOwnerTurn(sessionRepo: SessionRepository, sessionId: string): CarriedOwnerTurn | null {
  try {
    return sessionRepo.takeCarriedOwnerTurn(sessionId);
  } catch (error) {
    carriedOwnerTurnReporter.report(error);
    return null;
  }
}

/** What decides whether a turn end reads through a carried turn. */
interface CarriedTurnFacts {
  /** The turn's own read. */
  ownRead: UserMessageRead;
  carried: CarriedOwnerTurn;
  /** When the task entered its column (UTC ISO), or null with no move record. */
  visitStartedAt: string | null;
  /** The conversation the session's record names now. */
  recordAgentSessionId: string | null;
}

/**
 * Whether a turn end reads from a carried turn. Only when the turn's own read
 * was readable and holds no message of the owner's (a newer one cancels the
 * carried turn, even one that matches nothing), the carried turn began in this
 * column visit (a move since starts a new one), and it is in the conversation
 * the session still writes (an offset into another file means nothing).
 */
export function readsCarriedTurn({ ownRead, carried, visitStartedAt, recordAgentSessionId }: CarriedTurnFacts): boolean {
  if (!ownRead.readable || ownRead.messages.length > 0) return false;
  if (visitStartedAt !== null && Date.parse(carried.startedAt) < Date.parse(visitStartedAt)) return false;
  return recordAgentSessionId !== null && recordAgentSessionId === carried.agentSessionId;
}

/**
 * The owner's messages for a turn end's Text match: the turn's own, or, when
 * `readsCarriedTurn` says so, every one since the turn a restart cut off began,
 * marked so the run reasons say where the message came from.
 */
export async function readUserMessagesWithCarriedTurn(
  session: { sessionId: string; agentSessionId?: string | null; transcriptAnchor?: TranscriptAnchor | null },
  sessionRepo: SessionRepository,
  projectDb: Database.Database | null,
  carried: CarriedOwnerTurn | null,
  visitStartedAt: string | null,
): Promise<UserMessageRead> {
  const ownRead = await readUserMessagesInTurn(session, sessionRepo, projectDb);
  if (!carried) return ownRead;
  let recordAgentSessionId: string | null;
  try {
    recordAgentSessionId = sessionRepo.findByAnyId(session.sessionId)?.agent_session_id ?? null;
  } catch (error) {
    carriedOwnerTurnReporter.report(error);
    return ownRead;
  }
  if (!readsCarriedTurn({ ownRead, carried, visitStartedAt, recordAgentSessionId })) {
    console.log(`[turn-end] Dropped the turn a restart cut off for session ${session.sessionId.slice(0, 8)}: this turn decides on its own.`);
    return ownRead;
  }
  const read = await readUserMessagesInTurn(
    {
      sessionId: session.sessionId,
      agentSessionId: session.agentSessionId,
      transcriptAnchor: { agentSessionId: carried.agentSessionId, byteOffset: carried.byteOffset },
    },
    sessionRepo,
    projectDb,
    undefined,
    carried.recordIds,
  );
  console.log(`[turn-end] Read session ${session.sessionId.slice(0, 8)}'s messages from the turn a restart cut off.`);
  return read.readable ? { ...read, carriedAcrossRestart: true } : read;
}
