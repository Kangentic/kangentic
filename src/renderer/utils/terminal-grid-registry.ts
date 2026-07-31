/**
 * Dev-only registry of the xterm instances currently mounted in this renderer,
 * so the devtools can report every layer's idea of a terminal's size at once.
 *
 * Why this exists: a terminal can end up with its PTY and its xterm grid at
 * DIFFERENT widths, and when that happens nothing recovers it - xterm only emits
 * a resize when its own size changes, so a mismatch has no path back and the
 * terminal stays wrapped or clipped until the window is resized by hand. That
 * state was effectively invisible: the renderer knows only its grid, main knows
 * only the PTY, and neither compares. Diagnosing it meant measuring `.xterm-screen`
 * pixel widths off screenshots and doing arithmetic, which is slow and easy to
 * get wrong.
 *
 * Registering the live `Terminal` objects here lets one devtools call put the
 * renderer's grid next to main's PTY dimensions and derive the invariants
 * directly.
 *
 * Lives in shipped `utils/` rather than `src/devtools/` deliberately: shipped code
 * must never import from the devtools tree, and `useTerminal` is the only place
 * that can know when a terminal mounts. Same shape as the neighbouring
 * `terminal-capture-registry` - a cheap registry here, with the dev-only READ
 * installed from `src/devtools/`.
 *
 * Every WRITE is gated on `__KANGENTIC_DEV__`, so production collapses them to
 * no-ops. The only readers (`readTerminalGrids`, `readTerminalRendererTrace`) are
 * called from `src/devtools/renderer/install.tsx`, which production
 * dead-code-eliminates - so without the guard this would maintain a registry and a
 * 300-entry ring that nothing in a packaged build could ever read. Drop the guard
 * only if a shipped reader is added.
 */

import type { Terminal } from '@xterm/xterm';

/** Which surface hosts a terminal. Derived from the DOM rather than threaded
 *  through props: every host portals to a known body-level root, so the mount
 *  point already answers this and no component needs to declare it. */
export type TerminalSurface = 'board-window' | 'monitor-window' | 'command-window' | 'bottom-panel' | 'detached' | 'unknown';

interface RegisteredTerminal {
  terminal: Terminal;
  sessionId: string | null;
}

// hmr-safe: a registry of live terminal instances, rebuilt by each terminal's own
// mount effect. A reset on Fast Refresh just empties a dev-only report until the
// terminals re-register.
const registered = new Map<string, RegisteredTerminal>();
// A monotonic counter that only mints display handles for the dev-only report.
// hmr-safe: a Fast Refresh reset can at worst reuse a handle string for an entry
let nextHandle = 0;

/**
 * Renderer half of the terminal lifecycle trace. The main-process half lives in
 * `src/main/pty/terminal-trace.ts`; the devtools route merges the two by
 * timestamp, which is what makes a cross-process ordering bug (a resize, an async
 * repaint, a sample, a replay write) legible without a new IPC channel.
 *
 * Low-frequency events only - mount, fit, resize-request, replay write - so this
 * stays always-on rather than needing a flag to be armed before the rare case.
 */
interface RendererTraceEvent {
  ts: number;
  source: 'renderer';
  sessionId: string | null;
  event: string;
  detail?: Record<string, unknown>;
}

const TRACE_RING_SIZE = 300;
// hmr-safe: a dev-only diagnostic ring; a reset on Fast Refresh just shortens the
// visible history.
const traceRing: RendererTraceEvent[] = [];

/**
 * `detail` may be a thunk, and MUST be one when building it costs anything.
 *
 * The dev gate below is inside the function, so a plain object argument is
 * constructed by the caller before the call - in production too, where this whole
 * function is a no-op. Two call sites in `useTerminal` were measuring the terminal
 * (`getBoundingClientRect`, `.xterm-viewport` `clientWidth`) immediately after
 * `fitAddon.fit()` wrote to the DOM, so every terminal mount in every build paid a
 * forced synchronous reflow to populate a ring buffer that production never keeps.
 * Passing a thunk defers that read behind the gate.
 */
export function traceTerminalRenderer(
  sessionId: string | null,
  event: string,
  detail?: Record<string, unknown> | (() => Record<string, unknown>),
): void {
  if (!__KANGENTIC_DEV__) return;
  traceRing.push({
    ts: Date.now(),
    source: 'renderer',
    sessionId,
    event,
    detail: typeof detail === 'function' ? detail() : detail,
  });
  while (traceRing.length > TRACE_RING_SIZE) traceRing.shift();
}

export function readTerminalRendererTrace(): RendererTraceEvent[] {
  return traceRing.slice();
}

/** Register a mounted terminal. Returns the unregister for the mount's cleanup. */
export function registerDevtoolsTerminal(terminal: Terminal, sessionId: string | null): () => void {
  if (!__KANGENTIC_DEV__) return () => { /* nothing registered */ };
  const handle = `term-${++nextHandle}`;
  registered.set(handle, { terminal, sessionId });
  traceTerminalRenderer(sessionId, 'mount', {
    handle,
    cols: terminal.cols,
    rows: terminal.rows,
    surface: resolveSurface(terminal.element ?? null),
  });
  return () => {
    traceTerminalRenderer(sessionId, 'dispose', { handle });
    registered.delete(handle);
  };
}

function resolveSurface(element: HTMLElement | null): TerminalSurface {
  if (!element) return 'unknown';
  if (element.closest('#monitor-detail-layer-root')) return 'monitor-window';
  if (element.closest('#command-terminal-layer-root')) return 'command-window';
  if (element.closest('#window-layer-root')) return 'board-window';
  if (element.closest('[data-testid="terminal-session-pane"]')) return 'bottom-panel';
  return 'unknown';
}

export interface TerminalGridReport {
  handle: string;
  sessionId: string | null;
  surface: TerminalSurface;
  /** xterm's grid, the authority on what the renderer is showing. */
  cols: number;
  rows: number;
  /** The box the fit is computed against. */
  hostWidth: number | null;
  hostHeight: number | null;
  /** `clientWidth` excludes the scrollbar; `offsetWidth` includes it. The gap is
   *  the gutter the fit has to account for. */
  viewportClientWidth: number | null;
  viewportOffsetWidth: number | null;
  /** The grid's rendered pixel size. */
  screenWidth: number | null;
  screenHeight: number | null;
  /**
   * How many pixels the grid overflows the box showing it. Non-zero means the fit
   * and the actual viewport disagree, which shows up as a clipped right-hand
   * column and a horizontal scrollbar.
   */
  gridOverflowPx: number | null;
  /** Wrapped continuation lines in the buffer. A frame drawn for a WIDER terminal
   *  than the current grid wraps heavily; it is the cheapest signal that content
   *  and grid disagree. */
  wrappedLines: number;
  nonEmptyLines: number;
}

/** Measure every mounted terminal. Installed on `window.__kangenticTerminalGrids`
 *  and read by the inspection server's terminal-state route. */
export function readTerminalGrids(): TerminalGridReport[] {
  const reports: TerminalGridReport[] = [];
  for (const [handle, entry] of registered) {
    const element = entry.terminal.element ?? null;
    const host = element?.parentElement ?? null;
    const viewport = element?.querySelector('.xterm-viewport') as HTMLElement | null;
    const screen = element?.querySelector('.xterm-screen') as HTMLElement | null;
    const screenWidth = screen ? screen.getBoundingClientRect().width : null;
    const viewportClientWidth = viewport ? viewport.clientWidth : null;

    let wrappedLines = 0;
    let nonEmptyLines = 0;
    try {
      const buffer = entry.terminal.buffer.active;
      for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index);
        if (!line) continue;
        if (line.isWrapped) wrappedLines += 1;
        if (line.translateToString(true).trim().length > 0) nonEmptyLines += 1;
      }
    } catch {
      // A terminal disposed between registration and this read: report geometry
      // only rather than failing the whole snapshot.
    }

    reports.push({
      handle,
      sessionId: entry.sessionId,
      surface: resolveSurface(element),
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      hostWidth: host ? Math.round(host.getBoundingClientRect().width) : null,
      hostHeight: host ? Math.round(host.getBoundingClientRect().height) : null,
      viewportClientWidth,
      viewportOffsetWidth: viewport ? viewport.offsetWidth : null,
      screenWidth: screenWidth === null ? null : Math.round(screenWidth),
      screenHeight: screen ? Math.round(screen.getBoundingClientRect().height) : null,
      gridOverflowPx:
        screenWidth === null || viewportClientWidth === null
          ? null
          : Math.round(screenWidth - viewportClientWidth),
      wrappedLines,
      nonEmptyLines,
    });
  }
  return reports;
}
