import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import { captureSessionMetrics } from './session-metrics';
import type { SessionManager } from '../../pty/session-manager';
import type { Session } from '../../../shared/types';

/**
 * Crash-resilience snapshot interval. Session metrics otherwise persist only at
 * a clean exit/suspend (or app shutdown), so an app or OS kill mid-run loses
 * that run's cost/duration/compactions. This periodic flush bounds the loss to
 * one interval.
 *
 * Tokens are intentionally NOT transcript-refined on this tick: that file read
 * is reserved for the run-ending paths (`refineTranscriptTokens`). The snapshot
 * keeps cost/duration/compactions fresh; the transcript is cumulative across
 * `--resume`, so the next resume's run-end refine restores authoritative
 * lifetime tokens, and `getSummaryForTask` reads the latest row per session.
 */
const METRICS_SNAPSHOT_INTERVAL_MS = 45_000;

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic live-session metrics snapshot (idempotent). */
export function startMetricsSnapshotTimer(sessionManager: SessionManager): void {
  if (snapshotTimer) return;
  snapshotTimer = setInterval(() => snapshotRunningSessions(sessionManager), METRICS_SNAPSHOT_INTERVAL_MS);
  // Never keep the process alive on this timer alone.
  snapshotTimer.unref();
}

/**
 * Stop the snapshot timer. Called synchronously from the before-quit path so no
 * tick can race the synchronous shutdown writes (synchronous-shutdown rule).
 */
export function stopMetricsSnapshotTimer(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

/**
 * Flush metrics for every running session to its project DB. Sessions are
 * grouped by project so each project's captures commit in a SINGLE
 * `db.transaction` (one WAL commit per project per tick) instead of two write
 * transactions per session. Fully best-effort: a transiently-unavailable
 * project DB is skipped, and each session's capture is wrapped in its own
 * try/catch inside the shared transaction so one session's failure (in
 * `getLatestForTask` or the capture itself) cannot roll back its siblings in the
 * same project's batch. Mirrors the pre-batch per-session isolation.
 */
function snapshotRunningSessions(sessionManager: SessionManager): void {
  const runningSessionsByProject = new Map<string, Session[]>();
  for (const session of sessionManager.listSessions()) {
    if (session.status !== 'running') continue;
    const group = runningSessionsByProject.get(session.projectId);
    if (group) {
      group.push(session);
    } else {
      runningSessionsByProject.set(session.projectId, [session]);
    }
  }

  for (const [projectId, sessions] of runningSessionsByProject) {
    try {
      const db = getProjectDb(projectId);
      const sessionRepo = new SessionRepository(db);
      const usageHistoryRepo = new UsageHistoryRepository(db);
      db.transaction(() => {
        for (const session of sessions) {
          try {
            const record = sessionRepo.getLatestForTask(session.taskId);
            if (!record || record.status !== 'running') continue;
            captureSessionMetrics(
              sessionManager,
              sessionRepo,
              usageHistoryRepo,
              session.id,
              record.id,
              record.started_at,
              record.session_type,
            );
          } catch {
            // Isolate one session's failure (e.g. a transient getLatestForTask
            // throw) inside the shared transaction so it cannot roll back its
            // siblings' captures in this batch.
          }
        }
      })();
    } catch {
      // Best-effort: a project DB may be transiently unavailable. A throw here
      // aborts only this project's batch; other projects still snapshot.
    }
  }
}
