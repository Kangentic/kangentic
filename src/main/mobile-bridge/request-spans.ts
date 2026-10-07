/**
 * Timed spans a capability handler records about one phone request, collected
 * by the service when it sends that request's response and printed on the
 * slow-request line. It exists so a handler can say where its own time went
 * (the terminal seed's settle plus serialize, say) without every handler
 * signature growing a timing parameter: the request is keyed by device and
 * requestId, which both the handler and the service already hold.
 *
 * Bounded: a span recorded for a request whose response is never collected
 * (the session dropped mid-dispatch) is evicted oldest-first once
 * MAX_TRACKED_REQUESTS is reached, so a dead session cannot grow the map.
 */

const MAX_TRACKED_REQUESTS = 256;

const spansByRequest = new Map<string, string[]>();

function requestKey(deviceId: string, requestId: string): string {
  return `${deviceId}\u0000${requestId}`;
}

/** Records one span, e.g. `seed 412 ms, 183 kB`, against a request still in flight. */
export function noteRequestSpan(deviceId: string, requestId: string, span: string): void {
  const key = requestKey(deviceId, requestId);
  const existing = spansByRequest.get(key);
  if (existing) {
    existing.push(span);
    return;
  }
  if (spansByRequest.size >= MAX_TRACKED_REQUESTS) {
    const oldestKey = spansByRequest.keys().next().value;
    if (oldestKey !== undefined) spansByRequest.delete(oldestKey);
  }
  spansByRequest.set(key, [span]);
}

/** Returns and forgets every span recorded for a request. */
export function takeRequestSpans(deviceId: string, requestId: string): string[] {
  const key = requestKey(deviceId, requestId);
  const spans = spansByRequest.get(key) ?? [];
  spansByRequest.delete(key);
  return spans;
}

/**
 * How often the block probe ticks. Its own lateness is the measurement, so the
 * tick sets the floor: an idle Electron 44.5.1 main process read at most 12 ms
 * over ten 500 ms windows on Windows, whose timers fire on a ~15.6 ms grid.
 */
const BLOCK_PROBE_INTERVAL_MS = 20;

/** A handler that never answers stops its probe here rather than ticking forever. */
const BLOCK_PROBE_MAX_MS = 120_000;

/** One in-flight request's view of the shared probe. */
interface BlockProbeWatcher {
  startedAtMs: number;
  longestBlockMs: number;
}

/**
 * Every in-flight request reads the same event loop, so they share one
 * interval: a cold start that opens twenty sessions at once ticks once per
 * BLOCK_PROBE_INTERVAL_MS, not twenty times.
 */
const activeBlockWatchers = new Set<BlockProbeWatcher>();
let sharedProbeTimer: ReturnType<typeof setInterval> | null = null;
let expectedProbeTickAtMs = 0;

/** The part of a block ending now that fell inside this watcher's request. */
function blockSeenBy(watcher: BlockProbeWatcher, nowMs: number): number {
  return Math.min(nowMs - expectedProbeTickAtMs, nowMs - watcher.startedAtMs);
}

function stopSharedProbeTimer(): void {
  if (sharedProbeTimer === null) return;
  clearInterval(sharedProbeTimer);
  sharedProbeTimer = null;
}

function onSharedProbeTick(): void {
  const nowMs = performance.now();
  for (const watcher of activeBlockWatchers) {
    watcher.longestBlockMs = Math.max(watcher.longestBlockMs, blockSeenBy(watcher, nowMs));
    if (nowMs - watcher.startedAtMs >= BLOCK_PROBE_MAX_MS) activeBlockWatchers.delete(watcher);
  }
  expectedProbeTickAtMs = nowMs + BLOCK_PROBE_INTERVAL_MS;
  if (activeBlockWatchers.size === 0) stopSharedProbeTimer();
}

/**
 * Starts measuring the longest stretch main's event loop was blocked while one
 * request is in flight. The returned function stops the probe and returns that
 * stretch in ms, so a slow request says whether main was busy (a block close
 * to the handler time) or waiting on something else (a block near the floor).
 *
 * A timer that measures its own lateness, and not
 * `performance.eventLoopUtilization()`: in Electron's main process Electron
 * waits for events outside libuv's poll, and the utilization read 0 for a
 * 900 ms spin as well as for an idle second (Electron 44.5.1, Node 24.21).
 * This probe read 396 ms for a 400 ms spin in the same process. It ticks only
 * while a request is in flight. A block that began before the request arrived
 * counts only from the request's arrival.
 */
export function startMainLoopBlockProbe(): () => number {
  const watcher: BlockProbeWatcher = { startedAtMs: performance.now(), longestBlockMs: 0 };
  activeBlockWatchers.add(watcher);
  if (sharedProbeTimer === null) {
    expectedProbeTickAtMs = watcher.startedAtMs + BLOCK_PROBE_INTERVAL_MS;
    sharedProbeTimer = setInterval(onSharedProbeTick, BLOCK_PROBE_INTERVAL_MS);
    sharedProbeTimer.unref?.();
  }
  return () => {
    // A block still running when the response goes out (a synchronous
    // handler) has kept the next tick from firing, so it is counted here.
    if (activeBlockWatchers.delete(watcher)) {
      watcher.longestBlockMs = Math.max(watcher.longestBlockMs, blockSeenBy(watcher, performance.now()));
      if (activeBlockWatchers.size === 0) stopSharedProbeTimer();
    }
    return Math.max(0, Math.round(watcher.longestBlockMs));
  };
}

export function resetRequestSpansForTests(): void {
  spansByRequest.clear();
  activeBlockWatchers.clear();
  stopSharedProbeTimer();
}
