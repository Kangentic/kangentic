import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter } from '../agent/agent-adapter';
import type { CliPlace } from '../agent/shared/cli-target';
import type { SessionRepository } from '../db/repositories/session-repository';
import { sessionOutputPaths } from './session-paths';

/**
 * Reconcile WHICH agent session id a resume targets against the retiring
 * record's own on-disk status file.
 *
 * The live reconcile (SessionTelemetry's change-sensitive status-file capture
 * -> recoverStaleSessionId) keeps `sessions.agent_session_id` tracking a
 * mid-session fork (Claude /clear moves the conversation to a NEW id and the
 * statusline re-reports it). But suspend() closes the status watcher (with a
 * 100ms debounce) BEFORE the CLI exits, so a fork within the final ~2s of a
 * session - or one from before the live reconcile shipped - can leave the DB
 * holding the pre-fork id while the record's own
 * `.kangentic/sessions/<recordId>/status.json` holds the real one. This
 * helper runs at resume time, reads that Kangentic-owned file, and swaps the
 * resumed id when the agent's own last report disagrees with the DB.
 *
 * Deliberately NOT the `canResumeSession` transcript-presence guard that was
 * built and reverted in #255 (see docs/integrations/agents/session-history.md): it reads
 * ONLY Kangentic's own session directory (never the agent CLI's storage as a
 * gate), it can only swap WHICH id is resumed (the spawn stays `--resume`,
 * never downgraded to fresh), and on every failure path (missing dir or file,
 * malformed JSON, no reported id, same id) it silently returns the stored id,
 * degrading to exactly today's behavior. Mocked E2E resumes hit the
 * missing-file path structurally (mock-claude writes no status.json).
 *
 * The one positive check before swapping: the reported id's transcript must
 * actually exist (`adapter.locateSessionHistoryFile`, a fast existence probe).
 * If the CLI died right after forking and never persisted the new
 * conversation, swapping would resume an empty thread while the stored id
 * still reaches the pre-fork one - so a locate miss keeps the stored id.
 */
export async function reconcileResumeAgentSessionId(params: {
  adapter: AgentAdapter;
  /** The resume-eligible record's id (= its `.kangentic/sessions/` dir name). */
  recordId: string | null | undefined;
  storedAgentSessionId: string | null | undefined;
  /** The cwd the resumed conversation ran in (locates the reported id's transcript). */
  cwd: string | null | undefined;
  projectPath: string | null | undefined;
  /** Persists the swap so later resumes agree. Optional: null still returns the corrected id. */
  sessionRepo: Pick<SessionRepository, 'updateAgentSessionId'> | null | undefined;
  /** Where the record's CLI ran when it was not this machine (`placeOfRecord`): its transcript is there. */
  place?: CliPlace | null;
}): Promise<string | null> {
  const { adapter, recordId, storedAgentSessionId, cwd, projectPath, sessionRepo } = params;
  const storedId = storedAgentSessionId ?? null;

  if (!recordId || !storedId || !cwd || !projectPath) return storedId;

  // Adapters without a status-file pipeline have no on-disk id report to
  // consult: structural no-op. Optional-chained: a partially-shaped adapter
  // stub may lack `runtime` entirely, and every failure path here must
  // degrade to the stored id rather than throw.
  const statusFileHook = adapter.runtime?.statusFile;
  if (!statusFileHook) return storedId;

  try {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', recordId);
    const { statusOutputPath } = sessionOutputPaths(sessionDir);
    let raw: string;
    try {
      raw = fs.readFileSync(statusOutputPath, 'utf8');
    } catch {
      // No status.json (mocked CLI, pruned dir, agent never wrote one).
      return storedId;
    }

    const usage = statusFileHook.parseStatus(raw);
    const reportedId = usage?.sessionId;
    if (typeof reportedId !== 'string' || reportedId === storedId) return storedId;
    // Defense in depth against a hand-edited or corrupted file: only accept a
    // plausibly id-shaped value before pointing --resume at it.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(reportedId)) return storedId;

    const locatedTranscript = await adapter.locateSessionHistoryFile(reportedId, cwd, params.place ?? null);
    if (!locatedTranscript) return storedId;

    console.log(
      `[SESSION_LIFECYCLE] Resume-time reconcile: record ${recordId.slice(0, 8)} stored`
      + ` agent_session_id=${storedId.slice(0, 8)} but its status file last reported`
      + ` ${reportedId.slice(0, 8)} (mid-session fork, e.g. /clear). Resuming the reported id.`,
    );
    sessionRepo?.updateAgentSessionId(recordId, reportedId);
    return reportedId;
  } catch (error) {
    console.warn(`[SESSION_LIFECYCLE] Resume-time reconcile failed for record ${recordId.slice(0, 8)}:`, error);
    return storedId;
  }
}
