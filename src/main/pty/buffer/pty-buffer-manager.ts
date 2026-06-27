import { findSafeStartIndex } from './scrollback-utils';

const MAX_SCROLLBACK = 512 * 1024; // 512KB per session
/**
 * Trim scrollback only once it grows this far past the cap, then trim back to
 * the cap. Slicing a 512KB string is O(n); doing it on every chunk once the
 * buffer is full (the steady state for a heavily streaming session) burns the
 * main thread. The slack amortizes the slice to roughly once per
 * `SCROLLBACK_TRIM_SLACK` bytes of output instead of once per chunk.
 */
const SCROLLBACK_TRIM_SLACK = 256 * 1024;
const SCROLLBACK_TRIM_THRESHOLD = MAX_SCROLLBACK + SCROLLBACK_TRIM_SLACK;
/**
 * Max characters (UTF-16 code units, i.e. string `.length`, not raw bytes)
 * shipped to the renderer per 16ms flush. A multi-MB output burst accumulated
 * inside one flush window would otherwise ship as one giant IPC message and one
 * giant synchronous `xterm.write`, monopolizing the renderer thread. Capping
 * the flush bounds each message; the remainder stays buffered and the next
 * flush is rescheduled immediately so a backlog still drains quickly, just in
 * interruptible slices.
 */
const MAX_BYTES_PER_FLUSH = 256 * 1024;

/**
 * Largest slice end <= `max` that does not split a UTF-16 surrogate pair.
 * xterm's parser reassembles escape sequences across `write` calls, so the
 * only cross-slice hazard is a split surrogate pair (which would render as
 * U+FFFD). Escape-sequence boundaries do not need protecting here.
 */
function surrogateSafeFlushEnd(buffer: string, max: number): number {
  if (max >= buffer.length) return buffer.length;
  const code = buffer.charCodeAt(max - 1);
  if (code >= 0xd800 && code <= 0xdbff) return max - 1;
  return max;
}

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
    if (state.scrollback.length > SCROLLBACK_TRIM_THRESHOLD) {
      state.scrollback = state.scrollback.slice(-MAX_SCROLLBACK);
      const safeStart = findSafeStartIndex(state.scrollback);
      if (safeStart > 0) {
        state.scrollback = state.scrollback.slice(safeStart);
      }
      // Reset cached index after truncation
      state.tuiStartIndex = -1;
    }
    this.scheduleFlush(sessionId, state);
  }

  /**
   * Arm the 16ms flush timer if one is not already pending. The flush ships at
   * most `MAX_BYTES_PER_FLUSH` bytes; if a backlog remains it re-arms itself
   * for the next tick so a large burst drains in bounded, interruptible slices.
   */
  private scheduleFlush(sessionId: string, state: BufferState): void {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    setTimeout(() => {
      // Guard: session may have been removed during the 16ms window.
      const current = this.buffers.get(sessionId);
      if (!current) return;
      current.flushScheduled = false;
      if (!current.buffer) return;
      const end = current.buffer.length > MAX_BYTES_PER_FLUSH
        ? surrogateSafeFlushEnd(current.buffer, MAX_BYTES_PER_FLUSH)
        : current.buffer.length;
      const chunk = current.buffer.slice(0, end);
      current.buffer = current.buffer.slice(end);
      this.callbacks.onFlush(sessionId, chunk);
      // Drain any remainder on the next tick instead of waiting for new data.
      if (current.buffer) this.scheduleFlush(sessionId, current);
    }, 16);
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

    // The in-memory buffer is trimmed on hysteresis (onData lets it grow to
    // SCROLLBACK_TRIM_THRESHOLD before slicing, to amortize the O(n) trim off
    // the hot path), so it can transiently exceed MAX_SCROLLBACK. Bound the
    // replay here instead - reads happen only on a focus/tab switch, so the
    // slice cost is paid rarely rather than on every PTY chunk.
    if (scrollback.length > MAX_SCROLLBACK) {
      scrollback = scrollback.slice(-MAX_SCROLLBACK);
      const safeStart = findSafeStartIndex(scrollback);
      if (safeStart > 0) {
        scrollback = scrollback.slice(safeStart);
      }
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

  /**
   * Dev diagnostics: the pending (un-flushed) buffer size and accumulated
   * scrollback size for a session, in characters. Used by the inspection
   * server's terminal-pipeline route to spot a session whose buffer is
   * ballooning under a flood. Returns null for an unknown session.
   */
  getBufferStats(sessionId: string): { pendingBytes: number; scrollbackBytes: number } | null {
    const state = this.buffers.get(sessionId);
    if (!state) return null;
    return { pendingBytes: state.buffer.length, scrollbackBytes: state.scrollback.length };
  }
}
