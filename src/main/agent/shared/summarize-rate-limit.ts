/**
 * Sliding-window rate limit for headless summarize calls. Each entry is a
 * Date.now() timestamp, and entries older than an hour expire on every check.
 * A burst of task creation, or of new Command Terminals, could otherwise spam
 * the agent CLI and burn the user's subscription quota; this caps the damage.
 * The window is in-memory only: a restart clears it, which is the correct
 * behavior (the user has explicitly chosen to start a new session).
 *
 * ONE window for every caller. The `AGENT_SUMMARIZE` IPC handler (task names
 * the renderer suggests) and main's Command Terminal namer both draw from it,
 * so `autoNameRateLimitPerHour` caps their combined total, which is what the
 * setting promises.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;

const summarizeCallTimestamps: number[] = [];

/**
 * Record one summarize call if the window allows it. `limitPerHour` of 0 (or
 * less) means no limit. Returns false when the call must not run.
 */
export function tryAcquireSummarizeSlot(limitPerHour: number, now: number = Date.now()): boolean {
  if (limitPerHour <= 0) return true;
  const cutoff = now - ONE_HOUR_MS;
  while (summarizeCallTimestamps.length > 0 && summarizeCallTimestamps[0] < cutoff) {
    summarizeCallTimestamps.shift();
  }
  if (summarizeCallTimestamps.length >= limitPerHour) return false;
  summarizeCallTimestamps.push(now);
  return true;
}

/** Forget every recorded call (for tests). */
export function resetSummarizeRateLimit(): void {
  summarizeCallTimestamps.length = 0;
}
