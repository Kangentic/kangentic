import type { SessionRepository } from '../db/repositories/session-repository';
import type { SuspendedBy } from '../../shared/types';

/** Result of canResume() - whether a task's latest session can be resumed. */
export interface ResumeCheck {
  resumable: boolean;
  agentSessionId: string | null;
}

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
//   running    → suspended  (user pause, move to Done, auto_spawn=false)
//   running    → exited     (Claude exits naturally, crash, killed)
//   suspended  → exited     (replaced by new session on resume)
//   orphaned   → exited     (recovery dedup, or failed recovery)
//   exited     → suspended  (preserve for future resume on move to Done)
// ---------------------------------------------------------------------------

/**
 * Check whether a task's latest session can be resumed via --resume.
 *
 * Checks agent_session_id existence, NOT status. Any session with an
 * agent_session_id is potentially resumable - the agent wrote a transcript
 * (e.g. Claude's JSONL) that --resume can continue from. If the transcript
 * doesn't exist, --resume fails silently to a fresh session (no worse than
 * generating a new UUID).
 */
export function canResume(taskId: string, sessionRepo: SessionRepository): ResumeCheck {
  const latest = sessionRepo.getLatestForTask(taskId);
  if (!latest?.agent_session_id || latest.session_type === 'run_script') {
    return { resumable: false, agentSessionId: null };
  }
  // Queued sessions never started - no transcript to resume
  if (latest.status === 'queued') {
    return { resumable: false, agentSessionId: null };
  }
  return { resumable: true, agentSessionId: latest.agent_session_id };
}

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
  return sessionRepo.compareAndUpdateStatus(
    recordId,
    ['running', 'queued'],
    'exited',
    { exit_code: extra?.exit_code, exited_at: extra?.exited_at ?? new Date().toISOString() },
  );
}

/**
 * Atomically mark a session record as suspended. Accepts 'running' or
 * 'exited' as the source status (exited covers Claude natural exit).
 */
export function markRecordSuspended(
  sessionRepo: SessionRepository,
  recordId: string,
  suspendedBy: SuspendedBy,
): boolean {
  return sessionRepo.compareAndUpdateStatus(
    recordId,
    ['running', 'exited'],
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
 * Handle stale session ID recovery. When a resuming session reports a
 * different session_id (from status.json) than the agent_session_id stored
 * in the DB, --resume failed silently and the agent created a fresh session.
 * Update the DB so the next resume uses the agent's actual UUID.
 */
export function recoverStaleSessionId(
  sessionRepo: SessionRepository,
  taskId: string,
  agentReportedId: string,
): boolean {
  const record = sessionRepo.getLatestForTask(taskId);
  if (record && record.agent_session_id && record.agent_session_id !== agentReportedId) {
    console.log(
      `[SESSION_LIFECYCLE] Stale ID recovery: task ${taskId.slice(0, 8)} expected agent_session_id=${record.agent_session_id.slice(0, 8)} but agent reported ${agentReportedId.slice(0, 8)}. Updating DB.`,
    );
    sessionRepo.updateAgentSessionId(record.id, agentReportedId);
    return true;
  }
  return false;
}
