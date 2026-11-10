import { agentRegistry } from '../../agent/agent-registry';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { hostOfRecord } from '../../remote/record-host';
import { lineageHadTurns, resolveResumeLineage } from '../../transition-engine/resume-conversation-guard';
import type { IpcContext } from '../ipc-context';
import { withTaskLock } from '../task-lifecycle-lock';

/**
 * A resume whose CLI said the conversation does not exist, and whose lineage
 * never had a turn, is a launch that never ran. Marking its record sends the next
 * start down the path a failed fresh launch takes: `assessResumeConversationWithEvidence`
 * answers `never-started`, and the lineage's prompt is replayed (`owedPromptOf`).
 * Without it the retry runs the same `--resume`, and the task stays paused across
 * every restart with its prompt undelivered.
 *
 * This does not need a mark on any earlier record. A launch 0.54.0 paused has none,
 * and the CLI's own words on this resume are what decide.
 *
 * The turns check stays, on the write and not only on the verdict: a moved project
 * prints the same line, and a mark would replay the prompt into a conversation
 * that ran, so a miss with turns stays unmarked and resumes as before.
 *
 * Runs after the pause, because the report's read of the output is still pending
 * when the pause is accepted. It awaits that read itself: `mayRetryLaunch` returns
 * ahead of it on a session that is already a retry, and that failure is the one the
 * next Resume has to heal from. It takes the task lock, which the pause has released,
 * and a newer record means a person started the task in the gap, so that record
 * judges itself. Never throws: a report must not cost the listener its retry.
 *
 * A session on a host is left unmarked. Only the host shows that a conversation had turns: the evidence here is a
 * copy that can be empty or stale, and read as "no turns" it would replay the prompt into one that ran.
 *
 * What it answers decides the retry (`agent-never-started` in `handlers/sessions.ts`):
 *
 * - `marked`: the next start is fresh, so the retry runs.
 * - `left_unmarked`: a miss this record still owns, kept unmarked because its lineage
 *   had turns or because of doubt (no adapter, no project path, no agent session id).
 *   On a resume, the retry would run the same `--resume` and get the same answer
 *   (DESKTOP-2M), so the task gets the notice instead. A fresh launch keeps its retry.
 * - `not_a_miss`: no `conversation_missing`, a newer record that judges itself, or a
 *   read or write that threw. The listener decides as it always has.
 */
export type ResumeMissOutcome = 'marked' | 'left_unmarked' | 'not_a_miss';

export async function markResumeMiss(
  context: IpcContext,
  input: { sessionId: string; taskId: string; projectId: string },
): Promise<ResumeMissOutcome> {
  const { sessionId, taskId, projectId } = input;
  try {
    const outputClass = await context.sessionManager.launchOutputClass(sessionId);
    if (outputClass !== 'conversation_missing') return 'not_a_miss';
    const agentName = context.sessionManager.getSessionAgentName(sessionId);
    const adapter = agentName ? agentRegistry.get(agentName) : undefined;
    const projectPath = context.projectRepo.getById(projectId)?.path;
    return await withTaskLock(taskId, async (): Promise<ResumeMissOutcome> => {
      const sessionRepo = new SessionRepository(getProjectDb(projectId));
      const latest = sessionRepo.getLatestForTask(taskId);
      if (latest?.id !== sessionId) return 'not_a_miss';
      // Any doubt is read as turns, which leaves the record to resume as before. A host's session is doubt:
      // its turns are known only there.
      if (!adapter || !projectPath || !latest.agent_session_id || hostOfRecord(latest)) return 'left_unmarked';
      const { lineage } = resolveResumeLineage({
        taskRecords: sessionRepo.listForTaskNewestFirst(taskId),
        retiringRecordId: sessionId,
        resumedAgentSessionId: latest.agent_session_id,
      });
      if (lineageHadTurns({ adapter, agentSessionId: latest.agent_session_id, records: lineage, projectPath })) {
        console.log(`[AGENT-LAUNCH] session=${sessionId.slice(0, 8)} resume found no conversation and the lineage has turns, so it stays unmarked and is not retried`);
        return 'left_unmarked';
      }
      sessionRepo.markLaunchFailed(sessionId);
      console.log(`[AGENT-LAUNCH] session=${sessionId.slice(0, 8)} resume found no conversation and the lineage has no turns, so the next start is fresh`);
      return 'marked';
    });
  } catch (error) {
    console.warn('[AGENT-LAUNCH] Could not mark a resume that found no conversation:', error);
    return 'not_a_miss';
  }
}
