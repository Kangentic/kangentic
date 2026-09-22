/**
 * Host-level memory pressure sampling (Sentry DESKTOP-16).
 *
 * DESKTOP-16 was a renderer OOM where the crashing renderer held 179 MB
 * (smaller than a healthy long-running dogfood session) while the HOST had
 * 2.15 MB of Windows commit charge left out of an 89.8 GB limit, with 4.66 GB
 * of physical RAM still free. That is commit exhaustion, not a renderer leak
 * or physical RAM exhaustion: the OS refused an ordinary 6.9 MB allocation
 * because the machine's pagefile-backed commit charge was fully spent, and
 * Kangentic had no visibility into that dimension at all. An `os.freemem()`
 * style check would not have caught it, since physical memory was fine.
 *
 * `process.getSystemMemoryInfo()`'s `swapTotal` / `swapFree` map DIRECTLY onto
 * the Windows commit limit / commit remaining, confirmed empirically
 * (2026-09-16): reading it against `Win32_OperatingSystem`'s
 * `TotalVirtualMemorySize` / `FreeVirtualMemory` on the same machine at the
 * same moment matched (73.14 GB / ~15 GB on both sides). This holds despite
 * the "swap" naming: on Windows, Chromium passes `GlobalMemoryStatusEx`'s
 * `ullTotalPageFile` / `ullAvailPageFile` straight through, which ARE the
 * commit figures, not merely the pagefile's on-disk size. Linux reports real
 * swap through the same fields, a different resource with no equivalent hard
 * OOM cliff, so this module reports a commit reading on win32 only and stays
 * null everywhere else rather than asserting an unverified mapping.
 */

import type { HostMemorySample } from '../../shared/types';

export type { HostMemorySample };

const BYTES_PER_KB = 1024;

/** Only Windows' swapTotal/swapFree have been verified to mean commit
 *  limit/remaining (see the module header). Treat every other platform as
 *  having no commit reading rather than guessing. */
function hasVerifiedCommitReading(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

export function sampleHostMemory(): HostMemorySample {
  const info = process.getSystemMemoryInfo();
  const commitReading = hasVerifiedCommitReading(process.platform);
  return {
    ts: new Date().toISOString(),
    platform: process.platform,
    commitLimitBytes: commitReading && info.swapTotal != null ? info.swapTotal * BYTES_PER_KB : null,
    commitRemainingBytes: commitReading && info.swapFree != null ? info.swapFree * BYTES_PER_KB : null,
    physicalTotalBytes: info.total * BYTES_PER_KB,
    physicalFreeBytes: info.free * BYTES_PER_KB,
  };
}

let lastSample: HostMemorySample | null = null;

/**
 * Read synchronously (e.g. from `crash-capture.ts` at crash time). Never
 * re-samples: crash time is not the moment to call an OS API that may itself
 * need to allocate.
 */
export function getLastHostMemorySample(): HostMemorySample | null {
  return lastSample;
}

/** Absolute floor: DESKTOP-16's failed allocation was 6.9 MB against 2.15 MB
 *  remaining, so 2 GB gives roughly three orders of magnitude of runway. */
const ABSOLUTE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;
/** Relative floor: keeps a small machine (an 8 GB commit limit resolves to
 *  400 MB) from warning at a headroom that is actually normal for it. The
 *  smaller of the two arms wins. */
const RELATIVE_THRESHOLD_FRACTION = 0.05;
/** Re-arm only once remaining commit recovers past this multiple of the
 *  threshold, so a value oscillating around the line cannot re-fire on every
 *  tick (hysteresis). */
const HYSTERESIS_MULTIPLIER = 2;
/** Backstop even against a value oscillating exactly at the hysteresis
 *  boundary: no more than one warning per half hour regardless. */
const MIN_WARNING_INTERVAL_MS = 30 * 60_000;

/** Exported so the boundary tests measure against the real formula instead of
 *  a hand-copied one that would silently keep passing if a constant changed. */
export function pressureThreshold(commitLimitBytes: number): number {
  return Math.min(ABSOLUTE_THRESHOLD_BYTES, commitLimitBytes * RELATIVE_THRESHOLD_FRACTION);
}

export interface HostMemoryPressureState {
  /** False while latched below the threshold; re-arms only once recovered
   *  past the hysteresis line. */
  armed: boolean;
  lastWarnedAt: number | null;
}

export function createHostMemoryPressureState(): HostMemoryPressureState {
  return { armed: true, lastWarnedAt: null };
}

/** The outcome of one evaluation tick. `'pressure'` is the existing
 *  edge-triggered warning; `'recovered'` is the clear-side edge - headroom
 *  climbed back past the hysteresis line after a warning was latched (NOT
 *  fired on every healthy tick above the line, which is why this is not a
 *  plain boolean: `state.armed` starts `true`, so a fresh boot's first
 *  healthy tick must read `'none'`, not `'recovered'`). `'none'` covers
 *  every other case (still above the line and already armed, in the
 *  threshold-to-hysteresis grey zone, below the line but not yet re-armed or
 *  blocked by the minimum interval, or a degraded/unsupported sample). */
export type HostMemoryPressureDecision = 'pressure' | 'recovered' | 'none';

/**
 * Pure edge-triggered decision: does this sample warrant a NEW warning, or
 * does it mark the recovery from one, given the running state? Mutates
 * `state` in place. `now` is injectable for tests.
 *
 * Three guards on the warning side, all necessary against a condition that
 * can persist for hours at a 60s sampling cadence: edge-triggering (fire on
 * the downward crossing only), hysteresis (re-arm only well above the
 * line), and a hard minimum interval (a backstop against a value
 * oscillating across the line itself). The recovery side reuses the same
 * hysteresis line: it fires once, only when a warning was actually latched,
 * so a value sitting in the threshold-to-hysteresis grey zone (a "partial"
 * recovery) is deliberately not treated as recovered - it must clear the
 * same line the warning side requires headroom to clear before re-arming.
 */
export function evaluateHostMemoryPressure(
  sample: HostMemorySample,
  state: HostMemoryPressureState,
  now: number = Date.now()
): HostMemoryPressureDecision {
  const { commitLimitBytes, commitRemainingBytes } = sample;
  if (commitLimitBytes === null || commitRemainingBytes === null || commitLimitBytes <= 0) {
    return 'none';
  }

  const threshold = pressureThreshold(commitLimitBytes);
  if (commitRemainingBytes >= threshold * HYSTERESIS_MULTIPLIER) {
    const wasLatched = !state.armed;
    state.armed = true;
    return wasLatched ? 'recovered' : 'none';
  }
  if (commitRemainingBytes >= threshold) return 'none';
  if (!state.armed) return 'none';
  if (state.lastWarnedAt !== null && now - state.lastWarnedAt < MIN_WARNING_INTERVAL_MS) {
    return 'none';
  }

  state.armed = false;
  state.lastWarnedAt = now;
  return 'pressure';
}

export interface HostMemorySamplerOptions {
  /** How many agents are running, read live at warning time (not cached),
   *  so an idle app still reports a real number. */
  getActiveAgentCount: () => number;
  /** Called on the downward crossing only (see evaluateHostMemoryPressure). */
  onPressure: (sample: HostMemorySample, activeAgentCount: number) => void;
  /** Called on the upward crossing of the hysteresis line, and only when a
   *  warning was actually latched - the clear edge for `onPressure`. Not
   *  optional: an unpaired `onPressure` would silently ship a toast with no
   *  way to dismiss it, which is the bug this option exists to close. */
  onRecovery: (sample: HostMemorySample) => void;
  /** Called on every tick regardless of pressure - the attach point for a
   *  Sentry context, so whatever event fires next carries the freshest
   *  sample even when nothing ever crosses the threshold. */
  onSample?: (sample: HostMemorySample) => void;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Starts the periodic sampler. Returns a disposer. `clearInterval` is
 * synchronous, so this needs no drain on the quit path (see
 * .claude/rules/synchronous-shutdown.md) - just call the disposer from
 * `clearPendingTimers`, same as the other module-scope intervals in
 * `src/main/index.ts`.
 */
export function startHostMemorySampler(options: HostMemorySamplerOptions): () => void {
  const state = createHostMemoryPressureState();
  const tick = (): void => {
    // A diagnostics sampler must never be the thing that crashes the app it
    // is trying to protect - an uncaught throw here would surface every 60s
    // via the global uncaughtException handler for the life of the process.
    try {
      const sample = sampleHostMemory();
      lastSample = sample;
      options.onSample?.(sample);
      const decision = evaluateHostMemoryPressure(sample, state, Date.now());
      if (decision === 'pressure') {
        options.onPressure(sample, options.getActiveAgentCount());
      } else if (decision === 'recovered') {
        options.onRecovery(sample);
      }
    } catch (error) {
      console.error('[host-memory] Sampling tick failed:', error);
    }
  };
  const interval = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  interval.unref();
  return () => clearInterval(interval);
}
