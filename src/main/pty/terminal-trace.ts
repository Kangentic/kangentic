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
 * Writes are gated on `__KANGENTIC_DEV__`. The ONLY readers are under
 * `src/devtools/`, which production dead-code-eliminates - so in a packaged
 * build this ring would fill forever with bytes nothing could ever read. If a
 * shipped reader is ever added (a "copy diagnostics" affordance for a bug
 * report), drop the guard; until then it is pure cost.
 *
 * The ring dies with the process, and a restart once erased the only record of
 * two terminals whose agents drew for the panel's grid inside a task window.
 * Listeners (`addTerminalTraceListener`) see every kept entry: the devtools
 * install persists them to disk and samples the child's composed width after
 * each resize.
 */

/** Why `waitForResizeRepaint` stopped waiting. The field that makes a stale-frame
 *  replay self-explanatory instead of something to reverse-engineer. */
export type RepaintSettleReason =
  | 'not-armed'
  | 'joined'
  | 'stale-stamp'
  | 'no-tui-marker'
  | 'no-marker-first-frame'
  | 'no-marker-quiesce'
  | 'no-marker-deadline'
  | 'marker'
  | 'marker-and-quiesce'
  | 'markerless-quiesce'
  | 'deadline';

/** Which process recorded an entry. The pty host's entries reach the ring
 *  through main's relay, so `source` alone cannot tell a resize main applied
 *  from one the host applied. After the host falls back into main (five
 *  crashes), its entries are recorded in main and read `main` too. */
export type TerminalTraceProcess = 'main' | 'pty-host';

export interface TerminalTraceEvent {
  ts: number;
  /** The ring the entry lives in, beside the renderer's ring. Always `main`,
   *  even for a relayed host entry; `process` names the recorder. */
  source: 'main';
  process: TerminalTraceProcess;
  sessionId: string;
  event: string;
  detail?: Record<string, unknown>;
}

export type TerminalTraceListener = (entry: TerminalTraceEvent) => void;

const RING_SIZE = 300;
// hmr-safe: main is not hot-reloaded; the ring is rebuilt on app restart.
const ring: TerminalTraceEvent[] = [];
// hmr-safe: main is not hot-reloaded; listeners are installed once at startup.
const listeners = new Set<TerminalTraceListener>();

/** Set in the pty host, whose buffer traces belong in main's ring. */
let traceRelay: ((sessionId: string, event: string, detail: Record<string, unknown> | undefined, ts: number) => void) | null = null;

/** Send this process's trace entries elsewhere instead of keeping them (the
 *  pty host relays its entries to main). */
export function setTerminalTraceRelay(
  relay: ((sessionId: string, event: string, detail: Record<string, unknown> | undefined, ts: number) => void) | null,
): void {
  traceRelay = relay;
}

export function traceTerminal(sessionId: string, event: string, detail?: Record<string, unknown>): void {
  if (!__KANGENTIC_DEV__) return;
  if (traceRelay) {
    traceRelay(sessionId, event, detail, Date.now());
    return;
  }
  recordTerminalTrace(sessionId, event, detail, Date.now());
}

/** Keep an entry, with the time it happened (a relayed one carries its own). */
export function recordTerminalTrace(
  sessionId: string,
  event: string,
  detail: Record<string, unknown> | undefined,
  ts: number,
  recordedBy: TerminalTraceProcess = 'main',
): void {
  if (!__KANGENTIC_DEV__) return;
  const entry: TerminalTraceEvent = { ts, source: 'main', process: recordedBy, sessionId, event, detail };
  ring.push(entry);
  while (ring.length > RING_SIZE) ring.shift();
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A diagnostic listener must never break the resize or replay that traced.
    }
  }
}

/** Observe every entry the ring keeps. Returns the unsubscribe. */
export function addTerminalTraceListener(listener: TerminalTraceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readTerminalTrace(sessionId?: string): TerminalTraceEvent[] {
  return sessionId ? ring.filter((entry) => entry.sessionId === sessionId) : ring.slice();
}
