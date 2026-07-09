/**
 * Module-scope registry mapping a live session id to a reader that captures
 * ITS terminal's currently visible scrollback lines (not the full buffer).
 * Used only at the moment a conversation viewer opens, to find which
 * transcript turn the terminal was showing (see `tui-anchor.ts`) - this is
 * NOT a general-purpose terminal-content API.
 *
 * Preserved across HMR (Pattern A, mirroring `useTerminal.ts`'s
 * `savedScrollPositions`) so a Fast Refresh of `useTerminal.ts` does not drop
 * a capture reader for a session whose terminal instance survives the reload.
 */

export interface TerminalScrollbackCapture {
  /** The lines currently visible in the terminal's viewport, top to bottom. */
  visibleLines: string[];
  /** True when the viewport is scrolled to the live tail. Captured for
   *  completeness, but do NOT gate the anchor's scroll position on it: Claude
   *  Code's alt-screen TUI never moves real xterm scroll position, so this
   *  reads "at bottom" even when the user is looking at an earlier turn. The
   *  anchor match (`tui-anchor.ts`) is deliberately unconditional and degrades
   *  to the tail on no match; see the consuming note in `ConversationWindow`. */
  atBottom: boolean;
}

export type TerminalCaptureReader = () => TerminalScrollbackCapture;

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const readers: Map<string, TerminalCaptureReader> = import.meta.hot?.data?.terminalCaptureReaders ?? new Map();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.terminalCaptureReaders = readers;
  });
}

export function registerTerminalCapture(sessionId: string, reader: TerminalCaptureReader): void {
  readers.set(sessionId, reader);
}

/**
 * Unregisters a capture reader. When `reader` is passed, the entry is only
 * removed if it is STILL the same reader that registered it - a stale
 * unmount cleanup (e.g. the bottom-panel/task-dialog terminal ownership
 * handoff tearing down the LOSING side, or React StrictMode's dev-only
 * double-invoke cleanup) can otherwise fire after a newer mount has already
 * registered its own reader for the same session id, silently deleting the
 * live registration. Callers that don't have a reader reference (rare) fall
 * back to the unconditional delete.
 */
export function unregisterTerminalCapture(sessionId: string, reader?: TerminalCaptureReader): void {
  if (reader !== undefined && readers.get(sessionId) !== reader) return;
  readers.delete(sessionId);
}

/** Reads the given session's terminal, or null when no session id is given,
 *  no terminal is registered for it, or the read itself throws. */
export function captureTerminalScrollback(sessionId: string | null): TerminalScrollbackCapture | null {
  if (!sessionId) return null;
  const reader = readers.get(sessionId);
  if (!reader) return null;
  try {
    return reader();
  } catch {
    return null;
  }
}
