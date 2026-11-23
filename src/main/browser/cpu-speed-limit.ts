/**
 * The latest CPU speed limit the OS advertised this run, from powerMonitor's
 * `speed-limit-change` event (percent; under 100 means the OS is throttling the
 * CPU). A screenshot that timed out reports it as a bucket, because both Windows
 * DESKTOP-46 events ran while that event fired every 1 to 2 s, and no report said
 * how far the CPU was held down.
 *
 * `src/main/index.ts` stamps it from its powerMonitor handler. Electron emits the
 * event on Windows and macOS only. `unknown` means no event arrived this run: on
 * Linux always, and elsewhere when the limit never changed. It never means "not
 * throttled". No electron import, so a unit test can load it as is.
 */

export type CpuSpeedLimitBucket = '100' | '75-99' | '50-74' | '<50' | 'unknown';

let latestLimit: number | null = null;

/** Record the limit a `speed-limit-change` event carried. A value that is not a finite number clears it. */
export function noteCpuSpeedLimit(limit: unknown): void {
  latestLimit = typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
}

/** The latest limit, bucketed. A value past 100 reads `100`, so it never falls through to `unknown`. */
export function cpuSpeedLimitBucket(): CpuSpeedLimitBucket {
  if (latestLimit === null) return 'unknown';
  if (latestLimit >= 100) return '100';
  if (latestLimit >= 75) return '75-99';
  if (latestLimit >= 50) return '50-74';
  return '<50';
}

/** Test-only: forget the recorded limit. */
export function resetCpuSpeedLimitForTests(): void {
  latestLimit = null;
}
