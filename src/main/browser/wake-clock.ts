/**
 * When the machine last came back: the latest `unlock-screen` or `resume` power
 * event this run. A screenshot that timed out reports how long ago that was, as a
 * bucket, because the one such report (DESKTOP-46) fired 18 s after an unlock and
 * nothing in it said whether that mattered.
 *
 * `src/main/index.ts` stamps it from its powerMonitor handlers. No electron
 * import, so a unit test can load it as is. The time it buckets already reaches
 * Sentry as an `electron` lifecycle breadcrumb with a timestamp.
 */

export type SinceWakeBucket = 'none' | 'under_30s' | 'under_2m' | 'under_10m' | 'over_10m';

let lastWakeAt: number | null = null;

/** Record an unlock or a resume from sleep. */
export function noteWake(now: number = Date.now()): void {
  lastWakeAt = now;
}

/** How long since the last wake, bucketed. `none` when the machine has not woken this run. */
export function sinceWakeBucket(now: number = Date.now()): SinceWakeBucket {
  if (lastWakeAt === null) return 'none';
  const elapsedMs = now - lastWakeAt;
  if (elapsedMs < 30_000) return 'under_30s';
  if (elapsedMs < 120_000) return 'under_2m';
  if (elapsedMs < 600_000) return 'under_10m';
  return 'over_10m';
}

/** Test-only: forget the last wake. */
export function resetWakeClockForTests(): void {
  lastWakeAt = null;
}
