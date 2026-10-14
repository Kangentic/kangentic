import type { AgentReply } from '../../agent/shared/agent-reply';
import type { SessionRepository } from '../../db/repositories/session-repository';
import { retrievalClient } from '../../retrieval/retrieval-client';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import { agentRegistry } from '../../agent/agent-registry';

/** How long a final-reply read may take before it reads as none. */
export const AGENT_REPLY_TIMEOUT_MS = 15_000;

/**
 * A session's final reply with when it was written, read in the retrieval
 * worker, or null on any failure.
 *
 * Shared by the turn-end pass and Run again, so a re-run of a turn-end row
 * judges its Text match and its Condition against the same text a turn end
 * reads, rather than against nothing.
 */
export async function readSessionFinalReply(
  session: { sessionId: string; agentSessionId?: string | null },
  sessionRepo: SessionRepository,
): Promise<AgentReply | null> {
  try {
    const record = sessionRepo.findByAnyId(session.sessionId);
    const agentSessionId = record?.agent_session_id ?? session.agentSessionId;
    if (!record || !agentSessionId) return null;
    const reply = await retrievalClient.call(
      'transcript.finalReply',
      {
        facts: { sessionType: record.session_type, agentSessionId, cwd: record.cwd },
        remoteTargets: collectRemoteTargets(agentRegistry),
      },
      { timeoutMs: AGENT_REPLY_TIMEOUT_MS },
    );
    return reply ?? null;
  } catch (error) {
    // Not `[turn-end]`: Run again reads through here too.
    console.warn(`[automations] Could not read the agent's reply for ${session.sessionId.slice(0, 8)}:`, error);
    return null;
  }
}
