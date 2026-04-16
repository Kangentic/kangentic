import { findSafeStartIndex } from './scrollback-utils';

const MAX_SCROLLBACK = 512 * 1024; // 512KB per session

interface PtyBufferManagerCallbacks {
  onFlush(sessionId: string, data: string): void;
}

interface BufferState {
  buffer: string;
  flushScheduled: boolean;
  scrollback: string;
  lastCols: number;
  /** Whether the first resize has established the real terminal dimensions.
   *  The initial resize must NOT clear scrollback - it contains carried-over
   *  history from a previous session that hasn't been replayed yet. */
  initialized: boolean;
  /** Position of the first \x1b[2J (clear screen) in the scrollback, or -1
   *  if not found yet. Set once and cached. Used by getScrollback() to strip
   *  shell command noise that precedes the agent TUI's first draw. */
  tuiStartIndex: number;
}

/**
 * Manages per-session PTY output buffering and scrollback accumulation.
 *
 * Batches raw PTY data at ~60fps (16ms) before forwarding to the renderer,
 * and maintains a scrollback buffer for late-connecting terminals.
 */
export class PtyBufferManager {
  private buffers = new Map<string, BufferState>();
  private callbacks: PtyBufferManagerCallbacks;

  constructor(callbacks: PtyBufferManagerCallbacks) {
    this.callbacks = callbacks;
  }

  initSession(sessionId: string, previousScrollback: string, initialCols: number): void {
    this.buffers.set(sessionId, {
      buffer: '',
      flushScheduled: false,
      scrollback: previousScrollback,
      lastCols: initialCols,
      initialized: false,
      tuiStartIndex: previousScrollback ? 0 : -1,
    });
  }

  onData(sessionId: string, data: string): void {
    const state = this.buffers.get(sessionId);
    if (!state) return;

    state.buffer += data;
    state.scrollback += data;
    if (state.scrollback.length > MAX_SCROLLBACK) {
      state.scrollback = state.scrollback.slice(-MAX_SCROLLBACK);
      const safeStart = findSafeStartIndex(state.scrollback);
      if (safeStart > 0) {
        state.scrollback = state.scrollback.slice(safeStart);
      }
      // Reset cached index after truncation
      state.tuiStartIndex = -1;
    }
    if (!state.flushScheduled) {
      state.flushScheduled = true;
      setTimeout(() => {
        // Guard: session may have been removed during the 16ms window
        const current = this.buffers.get(sessionId);
        if (current && current.buffer) {
          this.callbacks.onFlush(sessionId, current.buffer);
          current.buffer = '';
        }
        if (current) current.flushScheduled = false;
      }, 16);
    }
  }

  /**
   * When column width changes, report it so the renderer can decide whether
   * to skip scrollback replay (TUI escape sequences garble at wrong width).
   *
   * The FIRST resize after initSession is special: it establishes the real
   * terminal dimensions (the renderer fits to its container). We must NOT
   * report cols changed on this initial resize because it may contain
   * carried-over history from a suspended session that hasn't been replayed
   * to the xterm instance yet.
   */
  onResize(sessionId: string, cols: number): boolean {
    const state = this.buffers.get(sessionId);
    if (!state) return false;

    if (!state.initialized) {
      state.initialized = true;
      state.lastCols = cols;
      return false;
    }

    const colsChanged = cols !== state.lastCols;
    state.lastCols = cols;
    return colsChanged;
  }

  getScrollback(sessionId: string): string {
    const state = this.buffers.get(sessionId);
    if (!state?.scrollback) return '';
    // Drain the pending buffer so the next 16ms flush fires harmlessly
    // (empty buffer -> onFlush skipped). Without this, data appended to
    // both buffer and scrollback by onData() would be delivered twice:
    // once via the scrollback replay and again by the stale flush.
    state.buffer = '';

    let scrollback = state.scrollback;

    // Strip pre-TUI noise (shell command line) on first read.
    // The \x1b[2J (clear screen) marks where the agent TUI took over.
    // Best-effort heuristic: agents without a TUI (e.g. Aider) don't emit
    // [2J, so their shell command stays in scrollback.
    // Cache the index so subsequent reads don't re-scan.
    if (state.tuiStartIndex === -1) {
      const clearIdx = scrollback.indexOf('\x1b[2J');
      state.tuiStartIndex = clearIdx > 0 ? clearIdx : 0;
    }
    if (state.tuiStartIndex > 0) {
      scrollback = scrollback.slice(state.tuiStartIndex);
    }

    return '\x1b[0m' + scrollback;
  }

  /**
   * Return raw unsliced scrollback, preserving pre-TUI content.
   *
   * Two callers:
   * 1. Carry-over on respawn - feeds the new PTY's scrollback buffer.
   * 2. Session-ID scrollback-scan fallback in session-manager.suspend() -
   *    unlike getScrollback() (which strips everything before the first
   *    \x1b[2J for clean terminal replay), this preserves agent startup
   *    headers. Codex prints "session id: <uuid>" BEFORE entering its
   *    TUI alt-screen, so the header would otherwise be sliced away.
   */
  getRawScrollback(sessionId: string): string {
    return this.buffers.get(sessionId)?.scrollback || '';
  }

  removeSession(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}
