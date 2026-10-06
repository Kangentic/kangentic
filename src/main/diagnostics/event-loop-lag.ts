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
 *
 * The rings hold the latest few; the counters beside them hold everything.
 * `syncWorkByLabel` counts every span per label, with its total, its worst and
 * how many reached each of `DURATION_EDGES_MS`, and `lagAtLeastMs` does the same
 * for the sampler's lag. Both only ever grow, so two reads taken around a
 * scenario subtract to that scenario's distribution, which a ring that other
 * spans keep filling cannot give.
 *
 * The 100 ms sampler misses a block that ends before its next tick, so a
 * `perf_hooks.monitorEventLoopDelay` histogram at 1 ms resolution runs beside
 * it. It is read and reset every `DELAY_WINDOW_MS`: each window's max, p99 and
 * mean go into `recentDelayWindows`, and `delayWindowMaxAtLeastMs` counts
 * windows by their max. Garbage-collection pauses arrive through a `gc`
 * `PerformanceObserver` and are counted like spans, as `gc:<kind>`.
 */

import {
  constants as perfConstants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type IntervalHistogram,
} from 'node:perf_hooks';

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

/** One `DELAY_WINDOW_MS` of the event-loop delay histogram. */
export interface DelayWindow {
  /** UTC ISO timestamp of when the window ended. */
  at: string;
  maxMs: number;
  p99Ms: number;
  meanMs: number;
  /** Set on a window a diagnostic tool closed around its own work (the stall
   *  profiler's restart), so a reader can leave it out of the app's numbers. */
  note?: string;
}

/**
 * The longest delay an idle main process shows at 1 ms resolution on Windows:
 * timers tick at about 15.6 ms there, so the histogram's per-window max sits at
 * 17 to 18.4 ms with nothing running (measured 2026-09-30). A block shorter
 * than this is invisible to the histogram; labelled spans and the stall
 * profiler's samples cover it instead.
 */
export const DELAY_FLOOR_MS = 18.4;
/** A delay window over this held a real block, not the timer floor. */
export const DELAY_BACKSTOP_MS = 25;

/** Every span one label has timed since the monitor started. */
export interface SyncWorkStats {
  count: number;
  totalMs: number;
  maxMs: number;
  /** Spans at or over each edge in `DURATION_EDGES_MS`, keyed by the edge. */
  atLeastMs: Record<string, number>;
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
  /** Every timed span since start, per label. */
  syncWorkByLabel: Record<string, SyncWorkStats>;
  /** Samples whose lag reached each edge in `DURATION_EDGES_MS`, keyed by the edge. */
  lagAtLeastMs: Record<string, number>;
  /** The delay histogram's resolution and window length, the measured idle
   *  floor, and the backstop a window must pass to count as a block. */
  delayResolutionMs: number;
  delayWindowMs: number;
  delayFloorMs: number;
  delayBackstopMs: number;
  /** The most recent delay windows (bounded ring, newest last). */
  recentDelayWindows: DelayWindow[];
  /** Windows whose max reached each edge in `DURATION_EDGES_MS`, keyed by the edge. */
  delayWindowMaxAtLeastMs: Record<string, number>;
}

const SAMPLE_INTERVAL_MS = 100;
const SPIKE_THRESHOLD_MS = 75;
const RING_SIZE = 120;
/** One frame at 60 Hz: a span this long already drops a frame's worth of input. */
const SLOW_SYNC_THRESHOLD_MS = 16;
const SLOW_SYNC_RING_SIZE = 200;
const DURATION_EDGES_MS = [4, 8, 16, 32, 64, 128, 256] as const;
export const DELAY_RESOLUTION_MS = 1;
const DELAY_WINDOW_MS = 10_000;
/** At least half an hour of windows; a stall-profiler restart closes one early. */
const DELAY_WINDOW_RING_SIZE = 1080;
export const NANOSECONDS_PER_MS = 1_000_000;

const GC_KIND_NAMES: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

function emptyEdgeCounts(): Record<string, number> {
  return Object.fromEntries(DURATION_EDGES_MS.map((edge) => [String(edge), 0]));
}

function countEdges(counts: Record<string, number>, valueMs: number): void {
  for (const edge of DURATION_EDGES_MS) {
    if (valueMs < edge) break;
    counts[String(edge)] += 1;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let startedAtMs: number | null = null;
let lastFire = 0;
let samples = 0;
let maxLagMs = 0;
let spikeCount = 0;
const recentSpikes: EventLoopLagSpike[] = [];
const recentSlowSyncWork: SlowSyncWork[] = [];
const syncWorkByLabel = new Map<string, SyncWorkStats>();
/** Where a process with no monitor of its own sends its slow spans (see `relaySlowSyncSpans`). */
let spanRelay: ((label: string, elapsedMs: number) => void) | null = null;
/** Told the label of the span now running, and null between spans (see `setSyncSpanLabelSink`). */
let spanLabelSink: ((label: string | null) => void) | null = null;
/** The innermost `timeSyncWork` label running now, kept only while a sink is set. */
let currentSpanLabel: string | null = null;
const lagAtLeastMs = emptyEdgeCounts();
let delayHistogram: IntervalHistogram | null = null;
let delayWindowTimer: ReturnType<typeof setInterval> | null = null;
let gcObserver: PerformanceObserver | null = null;
const recentDelayWindows: DelayWindow[] = [];
const delayWindowMaxAtLeastMs = emptyEdgeCounts();

/** Count one span under its label, and keep it in the ring when it is slow. */
function recordSpan(label: string, elapsed: number): void {
  let stats = syncWorkByLabel.get(label);
  if (!stats) {
    stats = { count: 0, totalMs: 0, maxMs: 0, atLeastMs: emptyEdgeCounts() };
    syncWorkByLabel.set(label, stats);
  }
  stats.count += 1;
  stats.totalMs += elapsed;
  if (elapsed > stats.maxMs) stats.maxMs = elapsed;
  countEdges(stats.atLeastMs, elapsed);
  if (elapsed >= SLOW_SYNC_THRESHOLD_MS) {
    recentSlowSyncWork.push({ at: new Date().toISOString(), label, ms: Math.round(elapsed) });
    while (recentSlowSyncWork.length > SLOW_SYNC_RING_SIZE) recentSlowSyncWork.shift();
  }
}

/**
 * Count a span that `timeSyncWork` cannot wrap, such as one inside an await,
 * measured by its caller.
 */
export function recordSyncSpan(label: string, elapsedMs: number): void {
  if (spanRelay !== null && elapsedMs >= SLOW_SYNC_THRESHOLD_MS) spanRelay(label, elapsedMs);
  if (timer === null && spanRelay === null) return;
  recordSpan(label, elapsedMs);
}

/** A note the next window to close will carry (see `markCurrentDelayWindow`). */
let currentWindowNote: string | null = null;

/**
 * Mark the delay window now open, so it closes with `note` and the app's counts
 * leave it out. The stall profiler marks the window holding its own restart:
 * the histogram records a block's delay whenever its timer next fires, which
 * is not reliably before any given callback, so the restart cannot be fenced
 * into a window of its own; the whole window is set aside instead.
 */
export function markCurrentDelayWindow(note: string): void {
  currentWindowNote = note;
}

/**
 * Close the current delay window now, so the window's numbers stop at this
 * moment. The stall profiler closes one before its restart, so the stall it
 * reacted to stays in an ordinary window.
 */
export function closeDelayWindow(): void {
  if (!delayHistogram) return;
  const note = currentWindowNote;
  currentWindowNote = null;
  if (delayHistogram.count > 0) {
    const maxMs = delayHistogram.max / NANOSECONDS_PER_MS;
    recentDelayWindows.push({
      at: new Date().toISOString(),
      maxMs: Math.round(maxMs * 10) / 10,
      p99Ms: Math.round((delayHistogram.percentile(99) / NANOSECONDS_PER_MS) * 10) / 10,
      meanMs: Math.round((delayHistogram.mean / NANOSECONDS_PER_MS) * 10) / 10,
      ...(note ? { note } : {}),
    });
    while (recentDelayWindows.length > DELAY_WINDOW_RING_SIZE) recentDelayWindows.shift();
    if (!note) countEdges(delayWindowMaxAtLeastMs, maxMs);
  }
  delayHistogram.reset();
}

/** Spans of `SLOW_SYNC_THRESHOLD_MS` or more that ended after `sinceMs` (epoch ms). */
export function slowSyncWorkSince(sinceMs: number): SlowSyncWork[] {
  return recentSlowSyncWork.filter((span) => Date.parse(span.at) >= sinceMs);
}

/**
 * Run a synchronous piece of main-process work and, while the monitor is
 * running, record it into `recentSlowSyncWork` if it took at least
 * `SLOW_SYNC_THRESHOLD_MS`. The work's return value and any throw pass through
 * unchanged; a throwing span is still recorded, since a slow failure blocks the
 * loop exactly as long as a slow success.
 */
export function timeSyncWork<T>(label: string, work: () => T): T {
  if (spanLabelSink === null) return measureSyncWork(label, work);
  const sink = spanLabelSink;
  const outerLabel = currentSpanLabel;
  currentSpanLabel = label;
  sink(label);
  try {
    return measureSyncWork(label, work);
  } finally {
    // Spans nest, so the enclosing span is current again, not "none".
    currentSpanLabel = outerLabel;
    sink(outerLabel);
  }
}

function measureSyncWork<T>(label: string, work: () => T): T {
  if (!isTimingSyncWork()) return work();
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    recordSyncSpan(label, performance.now() - startedAt);
  }
}

/**
 * Tell `sink` the label of each `timeSyncWork` span as it starts, and the
 * enclosing label (or null) as it ends, in production as well as dev. The
 * retrieval worker's event-loop watchdog uses it to name the step that held
 * the loop. Main never sets one, so its spans pay one null check.
 */
export function setSyncSpanLabelSink(sink: ((label: string | null) => void) | null): void {
  spanLabelSink = sink;
  currentSpanLabel = null;
}

/** True while spans are counted: the monitor runs here, or spans are relayed. */
export function isTimingSyncWork(): boolean {
  return timer !== null || spanRelay !== null;
}

/**
 * Hand every span `timeSyncWork` measures at `SLOW_SYNC_THRESHOLD_MS` or more
 * to `relay`, in a process that runs no monitor. The retrieval worker forwards
 * them to main (dev builds only), whose report counts them under a `worker:`
 * label, so work that left main stays visible in the one report. The process
 * also counts every span under its label, read with `getSyncWorkByLabel`.
 */
export function relaySlowSyncSpans(relay: ((label: string, elapsedMs: number) => void) | null): void {
  spanRelay = relay;
}

/** Every span counted so far, per label: count, total, worst, and how many
 *  reached each edge. */
export function getSyncWorkByLabel(): Record<string, SyncWorkStats> {
  return Object.fromEntries([...syncWorkByLabel].map(([label, stats]) => [label, {
    count: stats.count,
    totalMs: Math.round(stats.totalMs),
    maxMs: Math.round(stats.maxMs),
    atLeastMs: { ...stats.atLeastMs },
  }]));
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
    countEdges(lagAtLeastMs, lag);
    if (lag >= SPIKE_THRESHOLD_MS) {
      spikeCount += 1;
      recentSpikes.push({ at: new Date().toISOString(), lagMs: Math.round(lag) });
      while (recentSpikes.length > RING_SIZE) recentSpikes.shift();
    }
  }, SAMPLE_INTERVAL_MS);
  // Never keep the process alive on its own - mirrors the file-watcher poll.
  timer.unref();

  delayHistogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  delayHistogram.enable();
  delayWindowTimer = setInterval(closeDelayWindow, DELAY_WINDOW_MS);
  delayWindowTimer.unref();

  gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      // Node puts a gc entry's kind on `detail`, which the base entry type omits.
      const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind;
      recordSpan(`gc:${kind !== undefined ? GC_KIND_NAMES[kind] ?? kind : 'unknown'}`, entry.duration);
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });
}

export function stopEventLoopLagMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (delayWindowTimer) {
    clearInterval(delayWindowTimer);
    delayWindowTimer = null;
  }
  delayHistogram?.disable();
  delayHistogram = null;
  gcObserver?.disconnect();
  gcObserver = null;
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
    syncWorkByLabel: getSyncWorkByLabel(),
    lagAtLeastMs: { ...lagAtLeastMs },
    delayResolutionMs: DELAY_RESOLUTION_MS,
    delayWindowMs: DELAY_WINDOW_MS,
    delayFloorMs: DELAY_FLOOR_MS,
    delayBackstopMs: DELAY_BACKSTOP_MS,
    recentDelayWindows: [...recentDelayWindows],
    delayWindowMaxAtLeastMs: { ...delayWindowMaxAtLeastMs },
  };
}
