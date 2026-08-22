import type { SessionRepository } from '../db/repositories/session-repository';
import type { SuspendedBy } from '../../shared/types';
import { destroyLanesForSession } from '../browser/browser-lane-manager';

// ---------------------------------------------------------------------------
// Session lifecycle: centralized state machine for session DB records
//
// All DB status transitions flow through these functions. They use atomic
// compare-and-set SQL (compareAndUpdateStatus) to prevent race conditions
// between concurrent writers (e.g. suspend() vs onExit handler).
//
// Valid transitions:
//   queued     → running    (slot opened)
//   queued     → exited     (cancelled before start)
//   running    → suspended  (user pause, move to Done, auto_spawn=false, or a
//                            PTY exit during app shutdown via onExit hardening)
//   running    → exited     (Claude exits naturally, crash, killed)
//   suspended  → exited     (replaced by new session on resume)
//   orphaned   → exited     (recovery dedup, or failed recovery)
//   orphaned   → suspended  (pause-on-restart setting upgrades crashed sessions)
//   exited     → suspended  (preserve for future resume on move to Done; also
//                            startup recovery upgrading an OS-killed
//                            interrupted-exited record)
// ---------------------------------------------------------------------------

/**
 * Atomically mark a session record as exited. Only transitions from
 * 'running' or 'queued' - never overwrites 'suspended' status.
 * Called from the PTY onExit handler.
 */
export function markRecordExited(
  sessionRepo: SessionRepository,
  recordId: string,
  extra?: { exit_code?: number; exited_at?: string },
): boolean {
  const transitioned = sessionRepo.compareAndUpdateStatus(
    recordId,
    ['running', 'queued'],
    'exited',
    { exit_code: extra?.exit_code, exited_at: extra?.exited_at ?? new Date().toISOString() },
  );

  // Destroy any offscreen browser lanes this session opened.
  //
  // This is the GUARANTEE that lanes cannot leak, and it lives here rather than
  // on a hook because only one of the ten supported agent CLIs emits a
  // SubagentStop signal. A session ending is a lifecycle every agent goes
  // through, whatever CLI it runs. The idle timeout and the synchronous
  // shutdown sweep are the backstops behind it.
  //
  // Guarded on the transition so a repeated onExit does not re-run it, and kept
  // best-effort: a lane that fails to close must never stop a session record
  // from being marked exited, or the board would keep counting a dead agent.
  if (transitioned) {
    try {
      destroyLanesForSession(recordId);
    } catch (error) {
      console.warn(`[browser-lane] Could not close lanes for session ${recordId.slice(0, 8)}:`, error);
    }
  }

  return transitioned;
}

/**
 * Atomically mark a session record as suspended. Accepts 'running', 'exited',
 * or 'orphaned' as the source status. 'running' covers user pause, move to Done,
 * and the onExit shutdown-race hardening; 'exited' covers preserving a stopped
 * or OS-killed (interrupted-exited) record for future resume; 'orphaned' covers
 * the pause-on-restart upgrade for crash-recovered records.
 */
export function markRecordSuspended(
  sessionRepo: SessionRepository,
  recordId: string,
  suspendedBy: SuspendedBy,
): boolean {
  return sessionRepo.compareAndUpdateStatus(
    recordId,
    ['running', 'exited', 'orphaned'],
    'suspended',
    { suspended_at: new Date().toISOString(), suspended_by: suspendedBy },
  );
}

/**
 * Retire an old session record (mark as exited) when spawning a new
 * session to replace it. Accepts suspended, orphaned, or exited source status.
 */
export function retireRecord(
  sessionRepo: SessionRepository,
  recordId: string,
): boolean {
  return sessionRepo.compareAndUpdateStatus(
    recordId,
    ['suspended', 'orphaned', 'exited'],
    'exited',
    { exited_at: new Date().toISOString() },
  );
}

/**
 * Atomically promote a queued session record to running.
 */
export function promoteRecord(
  sessionRepo: SessionRepository,
  recordId: string,
): boolean {
  return sessionRepo.compareAndUpdateStatus(recordId, 'queued', 'running');
}

/**
 * Handle agent session ID capture or stale recovery. Called when an agent
 * reports its real session ID (from status.json for Claude, from hooks for
 * Gemini/Codex). Updates the DB record so the ID can be used for --resume.
 *
 * Three scenarios:
 * 1. Fresh capture: agent_session_id was null (Codex/Gemini), now captured.
 * 2. Stale recovery: agent_session_id was pre-specified (Claude) but the
 *    agent created a different session (--resume failed silently).
 * 3. Mid-session fork: the agent moved the live conversation to a NEW id
 *    (Claude /clear forks to a fresh session id) and its status file
 *    re-reported it. Same branch as scenario 2, and repeatable: each fork
 *    lands another update against the same record. Note the metrics
 *    consequence: lifetime token rollups partition by
 *    COALESCE(agent_session_id, id), so this record's lineage key follows the
 *    fork and any pre-fork leg is accounted to the new lineage (accepted; the
 *    pre-fork context is what the user chose to discard).
 */
export function recoverStaleSessionId(
  sessionRepo: SessionRepository,
  sessionId: string,
  taskId: string,
  agentReportedId: string,
): boolean {
  // Target the EXACT live record by its id (the PTY session id is the record's
  // primary key). This is isolation-safe: a task can hold multiple session records
  // (its main session + per-column isolated sessions), so resolving by "latest for
  // task" could misattribute the captured id to a different session. Fall back to
  // getLatestForTask only for the pre-insert window where the record row does not
  // exist yet (the same coarse behavior as before, see session-spawn-flow.ts's
  // attach() note).
  const record = sessionRepo.findByAnyId(sessionId) ?? sessionRepo.getLatestForTask(taskId);
  if (!record) return false;

  // Fresh capture: agent_session_id was null, now we have the real ID
  if (!record.agent_session_id) {
    console.log(
      `[SESSION_LIFECYCLE] Captured agent session ID for task ${taskId.slice(0, 8)}: ${agentReportedId.slice(0, 8)}`,
    );
    sessionRepo.updateAgentSessionId(record.id, agentReportedId);
    return true;
  }

  // Stale recovery: ID was pre-specified but agent reports a different one
  if (record.agent_session_id !== agentReportedId) {
    console.log(
      `[SESSION_LIFECYCLE] Stale ID recovery: task ${taskId.slice(0, 8)} expected agent_session_id=${record.agent_session_id.slice(0, 8)} but agent reported ${agentReportedId.slice(0, 8)}. Updating DB.`,
    );
    sessionRepo.updateAgentSessionId(record.id, agentReportedId);
    return true;
  }

  return false;
}
