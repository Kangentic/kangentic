/**
 * Bounded ring of terminal LIFECYCLE events in the main process, for the
 * devtools terminal-state route.
 *
 * The terminal failures worth debugging are ordering problems spread across two
 * processes: a resize, an async agent repaint, a scrollback sample, and a replay
 * write, where the bug is which one happened first. Neither side can see that
 * alone, and reconstructing it from screenshots or after-the-fact state is
 * guesswork - the settle's decision in particular (did it wait for the repaint,
 * or give up on a deadline?) left no trace at all and had to be deduced by
 * building a separate harness.
 *
 * Records only LOW-frequency lifecycle events, not per-chunk PTY data: a few
 * pushes per terminal mount. The renderer keeps its own ring
 * (terminal-grid-registry) and the route merges the two by timestamp, which avoids
 * a new IPC channel for a dev-only diagnostic.
 *
 * Writes are gated on `__KANGENTIC_DEV__`. The ONLY reader is the inspection
 * server under `src/devtools/`, which production dead-code-eliminates - so in a
 * packaged build this ring would fill forever with bytes nothing could ever read.
 * If a shipped reader is ever added (a "copy diagnostics" affordance for a bug
 * report), drop the guard; until then it is pure cost.
 */

/** Why `waitForResizeRepaint` stopped waiting. The field that makes a stale-frame
 *  replay self-explanatory instead of something to reverse-engineer. */
export type RepaintSettleReason =
  | 'not-armed'
  | 'joined'
  | 'stale-stamp'
  | 'no-tui-marker'
  | 'marker'
  | 'marker-and-quiesce'
  | 'deadline';

export interface TerminalTraceEvent {
  ts: number;
  source: 'main';
  sessionId: string;
  event: string;
  detail?: Record<string, unknown>;
}

const RING_SIZE = 300;
// hmr-safe: main is not hot-reloaded; the ring is rebuilt on app restart.
const ring: TerminalTraceEvent[] = [];

export function traceTerminal(sessionId: string, event: string, detail?: Record<string, unknown>): void {
  if (!__KANGENTIC_DEV__) return;
  ring.push({ ts: Date.now(), source: 'main', sessionId, event, detail });
  while (ring.length > RING_SIZE) ring.shift();
}

export function readTerminalTrace(sessionId?: string): TerminalTraceEvent[] {
  return sessionId ? ring.filter((entry) => entry.sessionId === sessionId) : ring.slice();
}
