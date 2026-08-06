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
  /** `true` while a fullscreen TUI owns the grid. Main reports its own
   *  `inAltScreen` from the byte stream; disagreement between the two means the
   *  renderer and the parser are on different screens. */
  altScreen: boolean | null;
  /**
   * The DECSTBM margins, 0-based and inclusive, or null when unreadable.
   *
   * Load-bearing because nothing round-trips them: a serialized replay frame
   * carries mode FLAGS only, and both `xterm.reset()` and a grid resize reset
   * the region outright. An agent that drives a scroll region (Claude Code does)
   * therefore ends up believing in margins the terminal no longer has, and every
   * region-relative op afterwards lands on the wrong rows. Comparing this
   * against `rows` is the only way to see that from outside.
   */
  scrollRegionTop: number | null;
  scrollRegionBottom: number | null;
}

/**
 * The scroll region has no public read path - `IModes` holds mode flags and
 * DECSTBM is buffer state - so this goes through `_core`, the same private door
 * `src/renderer/addons/fit-addon.ts` uses. Narrowly typed rather than `any`, and
 * every caller already runs inside a try/catch that degrades to geometry only.
 */
interface TerminalWithScrollRegion {
  _core?: { buffers?: { active?: { scrollTop?: number; scrollBottom?: number } } };
}

function readScrollRegion(terminal: Terminal): { top: number | null; bottom: number | null } {
  const activeBuffer = (terminal as unknown as TerminalWithScrollRegion)._core?.buffers?.active;
  const top = activeBuffer?.scrollTop;
  const bottom = activeBuffer?.scrollBottom;
  return {
    top: typeof top === 'number' ? top : null,
    bottom: typeof bottom === 'number' ? bottom : null,
  };
}

/** Viewport rows top to bottom, trailing whitespace trimmed, so a blank row is
 *  an empty string and a contiguous run of them is directly visible. */
function collectViewportRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let offset = 0; offset < terminal.rows; offset++) {
    const line = buffer.getLine(buffer.viewportY + offset);
    rows.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
  }
  return rows;
}

/** One session's viewport rows, or null when no terminal is mounted for it (or
 *  it is mid-teardown). Used for the repaint nudge's before/after comparison. */
export function readSessionViewportRows(sessionId: string): string[] | null {
  for (const entry of registered.values()) {
    if (entry.sessionId !== sessionId) continue;
    try {
      return collectViewportRows(entry.terminal);
    } catch {
      return null;
    }
  }
  return null;
}

/** The live scroll region of one session's terminal, for a trace detail thunk.
 *  Returns nulls rather than throwing when the terminal is mid-teardown. */
export function readSessionScrollRegion(sessionId: string): {
  top: number | null;
  bottom: number | null;
  rows: number | null;
} {
  for (const entry of registered.values()) {
    if (entry.sessionId !== sessionId) continue;
    try {
      return { ...readScrollRegion(entry.terminal), rows: entry.terminal.rows };
    } catch {
      return { top: null, bottom: null, rows: null };
    }
  }
  return { top: null, bottom: null, rows: null };
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
    let altScreen: boolean | null = null;
    let scrollRegion: { top: number | null; bottom: number | null } = { top: null, bottom: null };
    try {
      const buffer = entry.terminal.buffer.active;
      for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index);
        if (!line) continue;
        if (line.isWrapped) wrappedLines += 1;
        if (line.translateToString(true).trim().length > 0) nonEmptyLines += 1;
      }
      altScreen = buffer.type === 'alternate';
      scrollRegion = readScrollRegion(entry.terminal);
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
      altScreen,
      scrollRegionTop: scrollRegion.top,
      scrollRegionBottom: scrollRegion.bottom,
    });
  }
  return reports;
}

export interface TerminalGridRows {
  handle: string;
  sessionId: string | null;
  surface: TerminalSurface;
  cols: number;
  rows: number;
  altScreen: boolean | null;
  scrollRegionTop: number | null;
  scrollRegionBottom: number | null;
  cursorRow: number | null;
  cursorColumn: number | null;
  /** Every viewport row top to bottom, trailing whitespace trimmed. A blank row
   *  is an empty string, so a contiguous run of them is directly visible. */
  viewportRows: string[];
}

/**
 * Dump one session's viewport row by row.
 *
 * This is the renderer's leg of the three-way forensics split. `nonEmptyLines`
 * answers "how many rows have content" but not "WHICH rows", and a band of
 * blank rows in the middle of a frame is only diagnosable if you can line the
 * renderer's grid up against the parsed grid main holds and the raw bytes that
 * fed both. Separate from `readTerminalGrids` because it is opt-in and
 * session-scoped: the always-on report is already large enough that adding
 * per-row text to it would blow the payload for every caller.
 */
export function readTerminalGridRows(sessionId: string): TerminalGridRows[] {
  const dumps: TerminalGridRows[] = [];
  for (const [handle, entry] of registered) {
    if (entry.sessionId !== sessionId) continue;
    let viewportRows: string[] = [];
    let altScreen: boolean | null = null;
    let cursorRow: number | null = null;
    let cursorColumn: number | null = null;
    let scrollRegion: { top: number | null; bottom: number | null } = { top: null, bottom: null };
    try {
      const buffer = entry.terminal.buffer.active;
      altScreen = buffer.type === 'alternate';
      cursorRow = buffer.cursorY;
      cursorColumn = buffer.cursorX;
      scrollRegion = readScrollRegion(entry.terminal);
      viewportRows = collectViewportRows(entry.terminal);
    } catch {
      // Same degrade-not-fail contract as readTerminalGrids.
    }
    dumps.push({
      handle,
      sessionId: entry.sessionId,
      surface: resolveSurface(entry.terminal.element ?? null),
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      altScreen,
      scrollRegionTop: scrollRegion.top,
      scrollRegionBottom: scrollRegion.bottom,
      cursorRow,
      cursorColumn,
      viewportRows,
    });
  }
  return dumps;
}
