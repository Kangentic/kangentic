/**
 * Always-on (dev) event-loop lag monitor for the MAIN process - a freeze
 * "flight recorder".
 *
 * A timer scheduled every `SAMPLE_INTERVAL_MS` measures its own drift: if the
 * event loop was blocked (a synchronous burst - heavy fs, a big DB write, a
 * giant JSON.parse), the callback fires late, and `actual - expected` is how
 * long the loop was stalled. Stalls beyond `SPIKE_THRESHOLD_MS` are recorded
 * into a bounded ring with timestamps, so a freeze can be diagnosed
 * RETROACTIVELY: when a user reports "it just froze", the inspection bridge
 * reads this ring and shows exactly when and for how long the loop blocked -
 * no need to have been probing at that instant.
 *
 * Cost is negligible (one arithmetic callback per `SAMPLE_INTERVAL_MS`). The
 * timer is `unref`'d so it never keeps the process alive past a clean quit.
 * Started only in dev (gated by `__KANGENTIC_DEV__` at the call site); read via
 * the inspection server's `/event-loop-lag` route.
 *
 * The drift sampler says WHEN the loop blocked, never WHAT blocked it: a spike
 * is a timestamp and a duration. The 2026-09-16 board-drag audit found five
 * blocks of 929 to 1160ms in one afternoon with nothing in the IPC log or the
 * console log inside their windows, which is exactly the shape of unlogged
 * synchronous work (a sync sqlite transaction, a sync file read). So the known
 * synchronous suspects wrap themselves in `timeSyncWork`, which records any
 * span at or over `SLOW_SYNC_THRESHOLD_MS` into a second ring the same report
 * carries as `recentSlowSyncWork`. Join the two rings by wall clock: a spike
 * whose window contains a labelled span is attributed, one with no span is a
 * suspect that is not wrapped yet. Recording is skipped entirely while the
 * monitor is not running, so a production build pays one boolean check.
 */

export interface EventLoopLagSpike {
  /** UTC ISO timestamp of the sample that observed the stall. */
  at: string;
  /** How long the event loop was blocked beyond the expected interval, in ms. */
  lagMs: number;
}

export interface SlowSyncWork {
  /** UTC ISO timestamp of when the span ENDED (the moment it was recorded). */
  at: string;
  /** The label the wrapping site chose, e.g. `metrics-snapshot`. */
  label: string;
  /** The span's duration in ms. */
  ms: number;
}

export interface EventLoopLagReport {
  monitoring: boolean;
  /** Milliseconds the monitor has been running, or null if never started. */
  monitoringForMs: number | null;
  sampleIntervalMs: number;
  spikeThresholdMs: number;
  /** Total samples taken since start. */
  samples: number;
  /** Worst single stall observed since start, in ms. */
  maxLagMs: number;
  /** Count of stalls over the threshold since start (may exceed the ring size). */
  spikeCount: number;
  /** The most recent stalls (bounded ring, newest last). */
  recentSpikes: EventLoopLagSpike[];
  /** Spans wrapped in `timeSyncWork` had to reach this many ms to be recorded. */
  slowSyncThresholdMs: number;
  /** The most recent slow synchronous spans (bounded ring, newest last). */
  recentSlowSyncWork: SlowSyncWork[];
}

const SAMPLE_INTERVAL_MS = 100;
const SPIKE_THRESHOLD_MS = 75;
const RING_SIZE = 120;
const SLOW_SYNC_THRESHOLD_MS = 50;
const SLOW_SYNC_RING_SIZE = 60;

let timer: ReturnType<typeof setInterval> | null = null;
let startedAtMs: number | null = null;
let lastFire = 0;
let samples = 0;
let maxLagMs = 0;
let spikeCount = 0;
const recentSpikes: EventLoopLagSpike[] = [];
const recentSlowSyncWork: SlowSyncWork[] = [];

/**
 * Run a synchronous piece of main-process work and, while the monitor is
 * running, record it into `recentSlowSyncWork` if it took at least
 * `SLOW_SYNC_THRESHOLD_MS`. The work's return value and any throw pass through
 * unchanged; a throwing span is still recorded, since a slow failure blocks the
 * loop exactly as long as a slow success.
 */
export function timeSyncWork<T>(label: string, work: () => T): T {
  if (timer === null) return work();
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    const elapsed = performance.now() - startedAt;
    if (elapsed >= SLOW_SYNC_THRESHOLD_MS) {
      recentSlowSyncWork.push({ at: new Date().toISOString(), label, ms: Math.round(elapsed) });
      while (recentSlowSyncWork.length > SLOW_SYNC_RING_SIZE) recentSlowSyncWork.shift();
    }
  }
}

export function startEventLoopLagMonitor(): void {
  if (timer) return;
  startedAtMs = Date.now();
  lastFire = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastFire - SAMPLE_INTERVAL_MS;
    lastFire = now;
    samples += 1;
    if (lag > maxLagMs) maxLagMs = lag;
    if (lag >= SPIKE_THRESHOLD_MS) {
      spikeCount += 1;
      recentSpikes.push({ at: new Date().toISOString(), lagMs: Math.round(lag) });
      while (recentSpikes.length > RING_SIZE) recentSpikes.shift();
    }
  }, SAMPLE_INTERVAL_MS);
  // Never keep the process alive on its own - mirrors the file-watcher poll.
  timer.unref();
}

export function stopEventLoopLagMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getEventLoopLagReport(): EventLoopLagReport {
  return {
    monitoring: timer !== null,
    monitoringForMs: startedAtMs !== null ? Date.now() - startedAtMs : null,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    spikeThresholdMs: SPIKE_THRESHOLD_MS,
    samples,
    maxLagMs: Math.round(maxLagMs),
    spikeCount,
    recentSpikes: [...recentSpikes],
    slowSyncThresholdMs: SLOW_SYNC_THRESHOLD_MS,
    recentSlowSyncWork: [...recentSlowSyncWork],
  };
}
