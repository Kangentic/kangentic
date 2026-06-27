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
 */

export interface EventLoopLagSpike {
  /** UTC ISO timestamp of the sample that observed the stall. */
  at: string;
  /** How long the event loop was blocked beyond the expected interval, in ms. */
  lagMs: number;
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
}

const SAMPLE_INTERVAL_MS = 100;
const SPIKE_THRESHOLD_MS = 75;
const RING_SIZE = 120;

let timer: ReturnType<typeof setInterval> | null = null;
let startedAtMs: number | null = null;
let lastFire = 0;
let samples = 0;
let maxLagMs = 0;
let spikeCount = 0;
const recentSpikes: EventLoopLagSpike[] = [];

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
  };
}
