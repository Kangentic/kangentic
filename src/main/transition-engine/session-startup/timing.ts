import { app } from 'electron';

/**
 * Per-pass timing instrumentation for the startup reconciliation passes
 * (autoSpawnTasks / resumeSuspendedSessions).
 *
 * Distinct from `src/main/startup-timer.ts`, which builds a deferred global
 * timeline table. This helper logs a single line immediately when a pass
 * finishes, and only when it is worth seeing:
 *   - the pass did real work (workCount > 0), OR
 *   - the pass ran past STARTUP_TIMING_LOG_THRESHOLD_MS (a slow no-op is a
 *     perf-regression signal worth surfacing - e.g. blocked on shell
 *     resolution - even when nothing was spawned/resumed).
 *
 * A fast no-op (the common case on every project open) stays silent, which
 * keeps dev-mode boot logs quiet across many registered projects.
 *
 * Always a no-op in packaged builds - this helper owns the `app.isPackaged`
 * gate so callers never reference `app` themselves.
 */

/** Slow no-op threshold: below this, a zero-work pass logs nothing. */
export const STARTUP_TIMING_LOG_THRESHOLD_MS = 50;

/**
 * Start timing a startup pass. Returns a `done(workCount)` callback to call
 * at every exit point (early returns pass 0; the success path passes the
 * count of spawned/resumed sessions).
 *
 * @param label    The pass name, e.g. 'autoSpawnTasks'.
 * @param projectId The project id (only its first 8 chars are logged).
 * @param workVerb  The past-tense verb describing the work unit, e.g. 'spawned'.
 */
export function startStartupTimer(
  label: string,
  projectId: string,
  workVerb: string,
): (workCount: number) => void {
  if (app.isPackaged) {
    return () => {};
  }

  const startTime = Date.now();

  return (workCount: number): void => {
    const elapsed = Date.now() - startTime;
    if (workCount <= 0 && elapsed < STARTUP_TIMING_LOG_THRESHOLD_MS) return;
    console.log(`[startup] ${label}:${projectId.slice(0, 8)} ${workVerb}=${workCount} (${elapsed}ms)`);
  };
}
