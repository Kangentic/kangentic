/**
 * Dev-only timer for the pty host's half of a terminal round trip: a mouse
 * report or a keystroke written to a session's PTY, the first output the agent
 * sends back, and the flush that carries it toward the renderer.
 *
 * A wheel tick in a fullscreen agent (Claude Code under
 * `CLAUDE_CODE_NO_FLICKER`) is a round trip. xterm turns it into an SGR mouse
 * report, the report reaches the PTY, the agent repaints, and the frame comes
 * back. Nothing else in the app says how long each leg takes, so a laggy
 * scroll could not be split between the agent and Kangentic. This module
 * records the host's legs while armed; the renderer records its own
 * (`src/renderer/utils/scroll-latency-probe.ts`), and the inspection server's
 * `/scroll-latency` route joins the two. Each interval is measured inside one
 * process, so the two clocks never need to agree.
 *
 * Lives in `src/main/diagnostics/` rather than `src/devtools/` because the
 * pty host must not import the dev tooling tree
 * (`tests/unit/pty-host-boundary.test.ts`). Every write is gated on
 * `__KANGENTIC_DEV__`, so a production build records nothing and keeps no
 * ring. Unarmed, a write costs one comparison.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { isSingleKeystroke, isSingleMouseReport } from '../../shared/round-trip-input';

/** `write`: bytes main sent to a session's PTY. `data`: a chunk the PTY
 *  produced. `flush`: a chunk the host posted to main for a focused session.
 *  `pause`: backpressure paused the session's PTY. */
export type HostRoundTripStage = 'write' | 'data' | 'flush' | 'pause';

export interface HostRoundTripEvent {
  /** `performance.now()` in the pty host. */
  at: number;
  sessionId: string;
  stage: HostRoundTripStage;
  /** UTF-16 code units, the unit every buffer here counts in. */
  chars: number;
  /** A `write` that is exactly one mouse report (SGR or X10). */
  mouse?: true;
  /** A `write` that is exactly one typed character or Backspace. */
  key?: true;
}

/** One firing of the 16 ms output flush timer. */
export interface FlushTimerSample {
  at: number;
  sessionId: string;
  requestedMs: number;
  /** From the timer being armed to its callback running. */
  actualMs: number;
}

export interface EventLoopDelaySummary {
  samples: number;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface HostRoundTripReading {
  armedAt: number | null;
  armedUntil: number;
  now: number;
  events: HostRoundTripEvent[];
  flushTimers: FlushTimerSample[];
  /** The host's event-loop delay over the armed window, at 1 ms resolution. */
  eventLoopDelay: EventLoopDelaySummary | null;
  /** Events past the ring's cap were not kept. */
  droppedEvents: number;
}

/** About a minute of a busy terminal's chunks across every session. */
const EVENT_RING_SIZE = 50_000;
const FLUSH_TIMER_RING_SIZE = 20_000;
/** An arm longer than this is shortened to it. */
const MAX_ARM_MS = 120_000;
const NANOSECONDS_PER_MS = 1_000_000;

let armedAt: number | null = null;
let armedUntil = 0;
let events: HostRoundTripEvent[] = [];
let flushTimers: FlushTimerSample[] = [];
let droppedEvents = 0;
let delayHistogram: IntervalHistogram | null = null;
let disarmTimer: ReturnType<typeof setTimeout> | null = null;

/** True while a probe window is open. */
export function isRoundTripProbeArmed(): boolean {
  return __KANGENTIC_DEV__ && performance.now() < armedUntil;
}

/** Open a probe window of `durationMs`, clearing the last one's events. */
export function armRoundTripProbe(durationMs: number): { armedAt: number; armedUntil: number } {
  if (!__KANGENTIC_DEV__) return { armedAt: 0, armedUntil: 0 };
  const boundedMs = Math.max(100, Math.min(MAX_ARM_MS, Math.round(durationMs)));
  armedAt = performance.now();
  armedUntil = armedAt + boundedMs;
  events = [];
  flushTimers = [];
  droppedEvents = 0;
  delayHistogram?.disable();
  delayHistogram = monitorEventLoopDelay({ resolution: 1 });
  delayHistogram.enable();
  if (disarmTimer) clearTimeout(disarmTimer);
  // The histogram stops with the window, so a late read still describes it.
  disarmTimer = setTimeout(() => {
    disarmTimer = null;
    delayHistogram?.disable();
  }, boundedMs);
  disarmTimer.unref();
  return { armedAt, armedUntil };
}

/** Record one stage for a session. `data` is only measured, never kept. */
export function noteRoundTripStage(sessionId: string, stage: HostRoundTripStage, data: string): void {
  if (!__KANGENTIC_DEV__) return;
  const at = performance.now();
  if (at >= armedUntil) return;
  if (events.length >= EVENT_RING_SIZE) {
    droppedEvents += 1;
    return;
  }
  const event: HostRoundTripEvent = { at, sessionId, stage, chars: data.length };
  if (stage === 'write' && isSingleMouseReport(data)) event.mouse = true;
  else if (stage === 'write' && isSingleKeystroke(data)) event.key = true;
  events.push(event);
}

/** Record how late a flush timer fired. `armedAtMs` is `performance.now()` when it was set. */
export function noteFlushTimer(sessionId: string, requestedMs: number, armedAtMs: number): void {
  if (!__KANGENTIC_DEV__) return;
  const at = performance.now();
  if (at >= armedUntil || flushTimers.length >= FLUSH_TIMER_RING_SIZE) return;
  flushTimers.push({ at, sessionId, requestedMs, actualMs: Math.round((at - armedAtMs) * 100) / 100 });
}

export function readRoundTripProbe(): HostRoundTripReading {
  const histogram = delayHistogram;
  const eventLoopDelay = histogram && histogram.count > 0
    ? {
      samples: histogram.count,
      meanMs: roundTenth(histogram.mean / NANOSECONDS_PER_MS),
      p50Ms: roundTenth(histogram.percentile(50) / NANOSECONDS_PER_MS),
      p99Ms: roundTenth(histogram.percentile(99) / NANOSECONDS_PER_MS),
      maxMs: roundTenth(histogram.max / NANOSECONDS_PER_MS),
    }
    : null;
  return {
    armedAt,
    armedUntil,
    now: performance.now(),
    events: events.slice(),
    flushTimers: flushTimers.slice(),
    eventLoopDelay,
    droppedEvents,
  };
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
