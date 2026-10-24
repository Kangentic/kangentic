/**
 * Dev-only timer for the renderer's half of a terminal round trip: a wheel
 * tick over a terminal, the mouse report xterm makes of it, the paced write
 * that sends it (or a typed character's write), the output that comes back,
 * xterm's parse of it, and the frame that paints it.
 *
 * A fullscreen agent (Claude Code under `CLAUDE_CODE_NO_FLICKER`) owns
 * scrolling: xterm has no scrollback of its own there, so the view moves only
 * when the agent repaints in answer to the report. The pty host times its own
 * legs (`src/main/diagnostics/pty-round-trip-probe.ts`), and the inspection
 * server's `/scroll-latency` route arms both, joins them, and says how much of
 * the round trip is the agent's and how much is Kangentic's. Every interval is
 * measured on this process's clock, so no clock has to agree with another.
 *
 * Lives in shipped `utils/` because `useTerminal` and the write queues are the
 * only places that see these moments, and shipped code never imports from
 * `src/devtools/` (the `terminal-grid-registry` pattern). Every write is gated
 * on `__KANGENTIC_DEV__`, so a production build records nothing; the dev-only
 * read is installed from `src/devtools/renderer/install.tsx`.
 */

import type { RoundTripInput } from '../../shared/round-trip-input';
import { sessionIdOfTerminalTarget } from './terminal-grid-registry';

/** `wheel`: a DOM wheel event over a session's terminal. `report`: the mouse
 *  report xterm made of input. `send`: a paced report leaving for main.
 *  `arrive`: output for the session reaching the renderer. `parsed`: xterm
 *  finished parsing a slice of it. `painted`: the next animation frame after a
 *  parse, the frame xterm's own render was scheduled into. */
export type RendererRoundTripStage = 'wheel' | 'report' | 'send' | 'arrive' | 'parsed' | 'painted';

export interface RendererRoundTripEvent {
  /** `performance.now()` in the renderer. */
  at: number;
  sessionId: string;
  stage: RendererRoundTripStage;
  chars?: number;
  /** `send` only: how long the report waited in the paced queue. */
  queuedMs?: number;
  /** `send` only: a paced mouse report, or one typed character or Backspace. */
  input?: RoundTripInput;
}

export interface RendererRoundTripReading {
  armedAt: number | null;
  armedUntil: number;
  now: number;
  events: RendererRoundTripEvent[];
  droppedEvents: number;
}

const EVENT_RING_SIZE = 50_000;
const MAX_ARM_MS = 120_000;

// hmr-safe: a dev-only probe window. A Fast Refresh reset ends an open window
// early, and the wheel listener below removes itself when its window closes.
let armedAt: number | null = null;
// hmr-safe: see armedAt.
let armedUntil = 0;
// hmr-safe: see armedAt.
let events: RendererRoundTripEvent[] = [];
// hmr-safe: see armedAt.
let droppedEvents = 0;
// hmr-safe: see armedAt.
let detachWheelListener: (() => void) | null = null;

function record(event: RendererRoundTripEvent): void {
  if (events.length >= EVENT_RING_SIZE) {
    droppedEvents += 1;
    return;
  }
  events.push(event);
}

/** Open a probe window of `durationMs`, clearing the last one's events. */
export function armScrollLatencyProbe(durationMs: number): { armedAt: number; armedUntil: number } {
  if (!__KANGENTIC_DEV__) return { armedAt: 0, armedUntil: 0 };
  const boundedMs = Math.max(100, Math.min(MAX_ARM_MS, Math.round(durationMs)));
  armedAt = performance.now();
  armedUntil = armedAt + boundedMs;
  events = [];
  droppedEvents = 0;
  detachWheelListener?.();
  // Capture phase, passive: it observes the wheel before xterm handles it and
  // can never change what the wheel does.
  const onWheel = (event: WheelEvent): void => {
    const at = performance.now();
    if (at >= armedUntil) return;
    const sessionId = sessionIdOfTerminalTarget(event.target);
    if (sessionId) record({ at, sessionId, stage: 'wheel' });
  };
  document.addEventListener('wheel', onWheel, { capture: true, passive: true });
  const timer = setTimeout(() => detach(), boundedMs);
  const detach = (): void => {
    clearTimeout(timer);
    document.removeEventListener('wheel', onWheel, { capture: true });
    if (detachWheelListener === detach) detachWheelListener = null;
  };
  detachWheelListener = detach;
  return { armedAt, armedUntil };
}

/** Record one stage for a session while a window is open. */
export function noteScrollLatencyStage(
  sessionId: string,
  stage: Exclude<RendererRoundTripStage, 'wheel' | 'parsed' | 'painted'>,
  detail?: { chars?: number; queuedMs?: number; input?: RoundTripInput },
): void {
  if (!__KANGENTIC_DEV__) return;
  const at = performance.now();
  if (at >= armedUntil) return;
  record({ at, sessionId, stage, ...detail });
}

/** Record a finished parse of `chars` of a session's output, and the next
 *  animation frame after it. */
export function noteScrollLatencyParsed(sessionId: string, chars: number): void {
  if (!__KANGENTIC_DEV__) return;
  const at = performance.now();
  if (at >= armedUntil) return;
  record({ at, sessionId, stage: 'parsed', chars });
  // Registered after the parse, so it runs after the frame callback xterm's
  // renderer asked for during that parse: this stamp is that frame.
  requestAnimationFrame(() => record({ at: performance.now(), sessionId, stage: 'painted' }));
}

export function readScrollLatencyProbe(): RendererRoundTripReading {
  return { armedAt, armedUntil, now: performance.now(), events: events.slice(), droppedEvents };
}
