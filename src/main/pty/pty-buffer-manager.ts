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
    });
  }

  onData(sessionId: string, data: string): void {
    const state = this.buffers.get(sessionId);
    if (!state) return;

    state.buffer += data;
    // Accumulate scrollback for late-connecting terminals
    state.scrollback += data;
    if (state.scrollback.length > MAX_SCROLLBACK) {
      state.scrollback = state.scrollback.slice(-MAX_SCROLLBACK);
      const safeStart = findSafeStartIndex(state.scrollback);
      if (safeStart > 0) {
        state.scrollback = state.scrollback.slice(safeStart);
      }
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
   * When column width changes, clear scrollback. TUI escape sequences
   * (absolute cursor positioning, colored bars) garble when replayed
   * at a different width. Claude Code redraws via SIGWINCH within ~50-100ms.
   *
   * The FIRST resize after initSession is special: it establishes the real
   * terminal dimensions (the renderer fits to its container). We must NOT
   * clear scrollback on this initial resize because it may contain
   * carried-over history from a suspended session that hasn't been replayed
   * to the xterm instance yet. Clearing it would lose all terminal history.
   */
  onResize(sessionId: string, cols: number): boolean {
    const state = this.buffers.get(sessionId);
    if (!state) return false;

    // First resize: establish real dimensions without clearing scrollback.
    // The renderer calls resize immediately after creating the xterm, before
    // fetching scrollback. If we cleared here, the scrollback would be gone
    // before the renderer ever reads it.
    if (!state.initialized) {
      state.initialized = true;
      state.lastCols = cols;
      return false;
    }

    const colsChanged = cols !== state.lastCols;
    if (colsChanged) {
      state.scrollback = '';
      state.buffer = '';
    }
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
    return '\x1b[0m' + state.scrollback;
  }

  /** Return raw scrollback for carry-over on respawn. */
  getRawScrollback(sessionId: string): string {
    return this.buffers.get(sessionId)?.scrollback || '';
  }

  removeSession(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}
