import type Database from 'better-sqlite3';
import type { AgentReply } from '../../agent/shared/agent-reply';
import type { UserMessageRead } from '../../../shared/final-line-match';
import { lastUserMessage } from './typed-message-ledger';
import type { TranscriptAnchor } from '../../agent/shared/transcript-anchor';
import type { SessionRepository } from '../../db/repositories/session-repository';
import { retrievalClient, RetrievalUnavailableError } from '../../retrieval/retrieval-client';
import type { MethodResult } from '../../retrieval/worker/protocol';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import { agentRegistry } from '../../agent/agent-registry';
import { parseStoredCliTarget } from '../../agent/shared/cli-target';
import { canReadTurnUserMessages } from '../../agent/shared/transcript-reader-capability';

/** How long one final-reply read may take before it reads as none. */
export const AGENT_REPLY_TIMEOUT_MS = 15_000;

/**
 * How long a read that met no worker waits before its one retry: past the
 * restart policy's 1 s wait after a first crash, the case this exists for.
 */
export const AGENT_REPLY_RETRY_DELAY_MS = 1_500;

type SessionReadInput = { sessionId: string; agentSessionId?: string | null; transcriptAnchor?: TranscriptAnchor | null };

/** The transcript reads a turn end makes in the retrieval worker. */
type TurnTranscriptMethod = 'transcript.finalReply' | 'transcript.turnUserMessages';

/**
 * One transcript read of a session in the retrieval worker, from the turn's
 * anchor (null reads the latest). Null when the session has no record or no
 * agent session id. Throws what the worker call threw, after one retry when
 * no worker answered.
 */
async function callSessionTranscript<Method extends TurnTranscriptMethod>(
  method: Method,
  session: SessionReadInput,
  sessionRepo: SessionRepository,
  timeoutMs: number,
): Promise<{ recordId: string; result: MethodResult<Method> } | null> {
  const record = sessionRepo.findByAnyId(session.sessionId);
  const agentSessionId = record?.agent_session_id ?? session.agentSessionId;
  if (!record || !agentSessionId) return null;
  const read = () => retrievalClient.call(
    method,
    {
      facts: {
        sessionType: record.session_type,
        agentSessionId,
        cwd: record.cwd,
        cliTarget: parseStoredCliTarget(record.cli_target),
        // What the agent reported it is writing: a resumed conversation can
        // stay outside the folder its cwd maps to.
        transcriptPath: record.transcript_path,
      },
      since: session.transcriptAnchor ?? null,
      remoteTargets: collectRemoteTargets(agentRegistry),
    },
    { timeoutMs },
  );
  try {
    return { recordId: record.id, result: await read() };
  } catch (error) {
    if (!(error instanceof RetrievalUnavailableError)) throw error;
    // The worker is one thread, so a search that held it past the budget got
    // this read's worker restarted (7.6 s in one search, measured 2026-11-05).
    // The transcript is still there and the next worker can read it, and a
    // turn end judged on nothing skips rows that should have run.
    await new Promise((resolve) => setTimeout(resolve, AGENT_REPLY_RETRY_DELAY_MS));
    return { recordId: record.id, result: await read() };
  }
}

/**
 * A session's final reply with when it was written, read in the retrieval
 * worker, or null on any failure.
 *
 * Shared by the turn-end pass and Run again, so a re-run of a turn-end row
 * judges its Text match and its Condition against the same text a turn end
 * reads, rather than against nothing.
 *
 * `transcriptAnchor` is where the turn being judged began (a turn end's
 * `TurnEndedPayload.transcriptAnchor`). The read then never returns a reply
 * from before it. Run again passes none: it judges the latest reply, whatever
 * turn wrote it.
 */
export async function readSessionFinalReply(
  session: SessionReadInput,
  sessionRepo: SessionRepository,
  timeoutMs: number = AGENT_REPLY_TIMEOUT_MS,
): Promise<AgentReply | null> {
  const read = await tryReadSessionFinalReply(session, sessionRepo, timeoutMs);
  return read.ok ? read.reply : null;
}

/**
 * Whether the agent of a session can report the messages a person sends it
 * (`canReadTurnUserMessages`), from the agent its record names. Undefined when
 * the session has no record or its agent is unknown: the read then fails such
 * a row closed on its own.
 */
export function sessionReportsUserMessages(sessionId: string, sessionRepo: SessionRepository): boolean | undefined {
  try {
    const record = sessionRepo.findByAnyId(sessionId);
    const adapter = record ? agentRegistry.getBySessionType(record.session_type) : undefined;
    return adapter ? canReadTurnUserMessages(adapter) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's last message in the turn that began at `transcriptAnchor`, for a
 * Text match on the user's message (#1078): the turn's user messages read in
 * the retrieval worker, less every text Kangentic recorded typing into the
 * session (`typed-message-ledger.ts`).
 *
 * Fails closed. Unreadable when: there is no anchor (a fresh spawn's first
 * turn, Run again), the session has no record or agent session id, the worker
 * read failed or answered null, or the session's typed record is incomplete.
 * The row then does not run. The typed record is read under the record's own
 * id, the id Kangentic recorded under, even when the lookup matched the agent's.
 */
export async function readTurnUserMessage(
  session: SessionReadInput,
  sessionRepo: SessionRepository,
  projectDb: Database.Database | null,
  timeoutMs: number = AGENT_REPLY_TIMEOUT_MS,
): Promise<UserMessageRead> {
  if ((session.transcriptAnchor ?? null) === null) return { readable: false };
  try {
    const read = await callSessionTranscript('transcript.turnUserMessages', session, sessionRepo, timeoutMs);
    if (read === null) return { readable: false };
    return lastUserMessage(projectDb, read.recordId, read.result ?? null);
  } catch (error) {
    console.warn(`[automations] Could not read the user's messages for ${session.sessionId.slice(0, 8)}:`, error);
    return { readable: false };
  }
}

/** A final-reply read that keeps a failed read apart from a turn that wrote no reply. */
export type FinalReplyRead = { ok: true; reply: AgentReply | null } | { ok: false };

/**
 * `readSessionFinalReply`, for a caller that must not read a failure as no
 * reply: a reclaimed turn end, which judges an earlier reply only when the
 * newer work wrote none. No session record or agent session id is a failure.
 */
export async function tryReadSessionFinalReply(
  session: SessionReadInput,
  sessionRepo: SessionRepository,
  timeoutMs: number = AGENT_REPLY_TIMEOUT_MS,
): Promise<FinalReplyRead> {
  try {
    const read = await callSessionTranscript('transcript.finalReply', session, sessionRepo, timeoutMs);
    if (read === null) return { ok: false };
    return { ok: true, reply: read.result ?? null };
  } catch (error) {
    // Not `[turn-end]`: Run again reads through here too.
    console.warn(`[automations] Could not read the agent's reply for ${session.sessionId.slice(0, 8)}:`, error);
    return { ok: false };
  }
}
