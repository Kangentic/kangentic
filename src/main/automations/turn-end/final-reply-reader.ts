import type { AgentReply } from '../../agent/shared/agent-reply';
import type { TranscriptAnchor } from '../../agent/shared/transcript-anchor';
import type { SessionRepository } from '../../db/repositories/session-repository';
import { retrievalClient, RetrievalUnavailableError } from '../../retrieval/retrieval-client';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import { agentRegistry } from '../../agent/agent-registry';
import { parseStoredCliTarget } from '../../agent/shared/cli-target';

/** How long one final-reply read may take before it reads as none. */
export const AGENT_REPLY_TIMEOUT_MS = 15_000;

/**
 * How long a read that met no worker waits before its one retry: past the
 * restart policy's 1 s wait after a first crash, the case this exists for.
 */
export const AGENT_REPLY_RETRY_DELAY_MS = 1_500;

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
  session: { sessionId: string; agentSessionId?: string | null; transcriptAnchor?: TranscriptAnchor | null },
  sessionRepo: SessionRepository,
  timeoutMs: number = AGENT_REPLY_TIMEOUT_MS,
): Promise<AgentReply | null> {
  const read = await tryReadSessionFinalReply(session, sessionRepo, timeoutMs);
  return read.ok ? read.reply : null;
}

/** A final-reply read that keeps a failed read apart from a turn that wrote no reply. */
export type FinalReplyRead = { ok: true; reply: AgentReply | null } | { ok: false };

/**
 * `readSessionFinalReply`, for a caller that must not read a failure as no
 * reply: a reclaimed turn end, which judges an earlier reply only when the
 * newer work wrote none. No session record or agent session id is a failure.
 */
export async function tryReadSessionFinalReply(
  session: { sessionId: string; agentSessionId?: string | null; transcriptAnchor?: TranscriptAnchor | null },
  sessionRepo: SessionRepository,
  timeoutMs: number = AGENT_REPLY_TIMEOUT_MS,
): Promise<FinalReplyRead> {
  try {
    const record = sessionRepo.findByAnyId(session.sessionId);
    const agentSessionId = record?.agent_session_id ?? session.agentSessionId;
    if (!record || !agentSessionId) return { ok: false };
    const read = () => retrievalClient.call(
      'transcript.finalReply',
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
    let reply: Awaited<ReturnType<typeof read>>;
    try {
      reply = await read();
    } catch (error) {
      if (!(error instanceof RetrievalUnavailableError)) throw error;
      // The worker is one thread, so a search that held it past the budget got
      // this read's worker restarted (7.6 s in one search, measured 2026-11-05).
      // The reply is still in the transcript and the next worker can read it,
      // and a turn end judged on no reply skips rows that should have run.
      await new Promise((resolve) => setTimeout(resolve, AGENT_REPLY_RETRY_DELAY_MS));
      reply = await read();
    }
    return { ok: true, reply: reply ?? null };
  } catch (error) {
    // Not `[turn-end]`: Run again reads through here too.
    console.warn(`[automations] Could not read the agent's reply for ${session.sessionId.slice(0, 8)}:`, error);
    return { ok: false };
  }
}
