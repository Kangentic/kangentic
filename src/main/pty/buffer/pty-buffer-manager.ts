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
 * Repaint-settle window for getScrollback (see waitForResizeRepaint).
 *
 * When the terminal width changes, a full-screen agent TUI (Claude, Codex)
 * repaints its frame asynchronously in response to SIGWINCH. A getScrollback
 * that samples the buffer in the gap between the resize and that repaint would
 * replay a frame laid out for the OLD width - the stale-frame bug this settle
 * closes. So getScrollback waits for the repaint bytes to land and quiesce
 * before sampling, bounded so a missing repaint can never hang the read.
 *
 *  - QUIESCE: no new data for this long counts as "the repaint has landed".
 *    ~3 flush ticks (16ms each), long enough to bridge a multi-chunk redraw.
 *  - MAX_WAIT: hard ceiling from wait entry. A width change with no repaint
 *    (or a genuinely slow one) adds at most this to a first paint.
 *  - STALE: a pending-repaint stamp older than this is treated as settled - the
 *    repaint has long since landed, so sample immediately.
 *  - POLL: settle poll cadence, matched to the flush tick.
 */
const REPAINT_QUIESCE_MS = 50;
const REPAINT_MAX_WAIT_MS = 400;
const REPAINT_STALE_MS = 2000;
const REPAINT_POLL_MS = 16;

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

// DEC private input/reporting modes to re-assert on a scrollback replay. These
// are invisible to restore: they change what xterm SENDS on later input, not
// what it draws, so the replayed frame is unchanged. Most display modes
// (origin 6, autowrap 7, cursor 25, ...) are excluded on purpose: re-asserting
// them for a NORMAL-buffer (classic-renderer) session could corrupt its
// restore. #313. Note: re-asserting 1004 (focus reporting) means the
// post-replay xterm.focus() in useTerminal's afterWrite now emits a benign
// \x1b[I (FocusIn) to the PTY, which Claude handles as a normal focus event.
//
// Alt-screen (1049/47/1047) is the one display mode re-asserted, but NOT via
// this set: it is tracked separately as BufferState.inAltScreen and emitted
// only when the session is CURRENTLY in the alt buffer (see getScrollback).
// That gate is what keeps it safe alongside the #313 exclusion above - a
// classic normal-buffer session never sets inAltScreen, so its replay is
// byte-for-byte unchanged; a fullscreen-TUI session's captured frame genuinely
// belongs in the alt buffer, so replaying it there (instead of the normal
// buffer, where it previously landed and desynced the cursor from the frame)
// is the correct restore, not a corruption risk.
const RESTORABLE_DEC_PRIVATE_MODES = new Set<number>([
  1,                 // DECCKM application cursor keys (the arrow-key bug)
  1000, 1002, 1003,  // mouse tracking
  1004,              // focus reporting
  1006, 1015, 1016,  // mouse encodings
  2004,              // bracketed paste
]);

// Alt-screen enter/exit variants, tracked into BufferState.inAltScreen (not
// RESTORABLE_DEC_PRIVATE_MODES - see the comment above). 1049 is the modern
// combined form (save cursor + switch + clear); 47/1047 are older variants
// without the cursor save. All three flip the same boolean.
const ALT_SCREEN_MODES = new Set<number>([47, 1047, 1049]);

// DEC synchronized-output framing (mode 2026). Tracked so getScrollback can
// close a frame left open by a mid-frame sample, which would otherwise stall
// xterm's renderer for its ~1s safety timeout.
const SYNCHRONIZED_OUTPUT_MODE = 2026;

// Upper bound on a partial mode sequence carried across a PTY chunk boundary.
// The carry must preserve a split of any tracked DECSET: the restorable input
// modes, the alt-screen modes (47/1047/1049), and synchronized output (2026).
// A single DECSET folding in every restorable mode alone is ~45 chars
// (`\x1b[?1;1000;1002;1003;1004;1006;1015;1016;2004`); one that also folded in
// 47/1047/1049/2026 would come to ~64, so a real split is always preserved
// while a lone trailing ESC cannot grow modeParseCarry without limit. Adding a
// mode to any of the three tracked sets that pushes a combined DECSET past this
// must bump the constant too.
const MODE_CARRY_MAX_LENGTH = 64;

/** Mutable mode-tracking fields of BufferState that updateModeState mutates. */
type ModeState = Pick<BufferState, 'decPrivateModes' | 'inAltScreen' | 'synchronizedOpen'>;

function updateModeState(state: ModeState, text: string): void {
  // One alternation matches a DECSET/DECRST set (\x1b[?<params>h|l) OR a full
  // reset (RIS \x1bc / DECSTR \x1b[!p) that returns every private mode to its
  // default. matchAll yields matches in stream order, so an interleaved
  // set-then-reset resolves correctly. A reset match has no capture groups.
  for (const match of text.matchAll(/\x1b\[\?([\d;]+)([hl])|\x1bc|\x1b\[!p/g)) {
    if (match[1] === undefined) {
      // RIS (\x1bc) returns to the normal buffer, so clear inAltScreen too;
      // DECSTR (\x1b[!p) does not switch buffers per spec, so it leaves
      // inAltScreen untouched. Both clear a dangling synchronized frame.
      for (const privateMode of RESTORABLE_DEC_PRIVATE_MODES) state.decPrivateModes.delete(privateMode);
      state.synchronizedOpen = false;
      if (match[0] === '\x1bc') state.inAltScreen = false;
      continue;
    }
    const isSet = match[2] === 'h';
    for (const parameter of match[1].split(';')) {
      const privateMode = Number(parameter);
      if (RESTORABLE_DEC_PRIVATE_MODES.has(privateMode)) {
        if (isSet) state.decPrivateModes.add(privateMode); else state.decPrivateModes.delete(privateMode);
      }
      if (ALT_SCREEN_MODES.has(privateMode)) state.inAltScreen = isSet;
      if (privateMode === SYNCHRONIZED_OUTPUT_MODE) state.synchronizedOpen = isSet;
    }
  }
}

function buildDecPrivateModePrefix(activeModes: Set<number>): string {
  if (activeModes.size === 0) return '';
  const sortedModes = Array.from(activeModes).sort((first, second) => first - second);
  return `\x1b[?${sortedModes.join(';')}h`;
}

interface PtyBufferManagerCallbacks {
  onFlush(sessionId: string, data: string): void;
}

interface BufferState {
  buffer: string;
  flushScheduled: boolean;
  scrollback: string;
  lastCols: number;
  /** Timestamp (Date.now()) of the most recent width-changing resize, or null
   *  when none is pending. Set by onResize when cols change; consumed and
   *  cleared by waitForResizeRepaint once the post-resize repaint has settled.
   *  Drives the repaint-settle in getScrollback. */
  pendingRepaintAt: number | null;
  /** Timestamp (Date.now()) of the most recent onData, or null before any data.
   *  Used by waitForResizeRepaint to detect that the SIGWINCH repaint has
   *  landed (data after the resize stamp) and then quiesced. */
  lastDataAt: number | null;
  /** Position of the first \x1b[2J (clear screen) in the scrollback, or -1
   *  if not found yet. Set once and cached. Used by getScrollback() to strip
   *  shell command noise that precedes the agent TUI's first draw. */
  tuiStartIndex: number;
  /** Sticky DEC private input/reporting modes (DECCKM etc.) currently active,
   *  tracked from the live stream so getScrollback() can re-assert them after
   *  xterm.reset() wipes them on replay. Survives scrollback trimming. #313. */
  decPrivateModes: Set<number>;
  /** Whether the session is currently in the alt screen buffer (DEC mode
   *  47/1047/1049), tracked so getScrollback() can re-assert it after
   *  xterm.reset() wipes it on replay - otherwise a fullscreen TUI's replayed
   *  frame paints into the wrong (normal) buffer. Survives scrollback
   *  trimming; reset on respawn like decPrivateModes. */
  inAltScreen: boolean;
  /** Whether a DEC synchronized-output frame (mode 2026) is currently open,
   *  tracked so getScrollback() can close a frame left dangling by a
   *  mid-frame sample - otherwise xterm stalls rendering for its ~1s safety
   *  timeout. */
  synchronizedOpen: boolean;
  /** Trailing partial escape sequence stitched onto the next chunk so a mode
   *  set split across two PTY chunks is parsed whole. Bounded in onData(). */
  modeParseCarry: string;
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
      pendingRepaintAt: null,
      lastDataAt: null,
      tuiStartIndex: previousScrollback ? 0 : -1,
      // Start empty/false even on carry-over: the new process re-emits its own modes.
      decPrivateModes: new Set<number>(),
      inAltScreen: false,
      synchronizedOpen: false,
      modeParseCarry: '',
    });
  }

  onData(sessionId: string, data: string): void {
    const state = this.buffers.get(sessionId);
    if (!state) return;

    // Track sticky DEC private input modes (DECCKM, mouse, paste), alt-screen,
    // and synchronized-output framing from the live stream so the scrollback
    // replay can re-assert/close them after xterm.reset() wipes them - the
    // original mode-set bytes usually scroll out of the 512KB window (#313).
    // modeParseCarry stitches a set split across two PTY chunks, bounded by
    // MODE_CARRY_MAX_LENGTH so a lone ESC cannot grow it. Skip the scan for
    // ESC-free bulk output unless a partial set is pending. Parse `combined`
    // only; append the original `data` below so the carry never duplicates
    // bytes into buffer/scrollback.
    if (state.modeParseCarry || data.includes('\x1b')) {
      const combined = state.modeParseCarry + data;
      updateModeState(state, combined);
      // A carry can only be a partial sequence at the very END of `combined`,
      // and it is bounded to MODE_CARRY_MAX_LENGTH, so scan just the trailing
      // window - a full-chunk scan here is redundant on the hot path. The `!?`
      // admits a partial DECSTR (\x1b[!) split at \x1b[! | p, matching the
      // DECSTR arm of updateModeState so the soft reset is not lost.
      const trailingWindow = combined.slice(-(MODE_CARRY_MAX_LENGTH + 1));
      const partialEscapeMatch = trailingWindow.match(/\x1b(?:\[[\d?;]*!?)?$/);
      state.modeParseCarry =
        partialEscapeMatch && partialEscapeMatch[0].length <= MODE_CARRY_MAX_LENGTH
          ? partialEscapeMatch[0]
          : '';
    }

    state.buffer += data;
    state.scrollback += data;
    // Stamp the arrival so a pending repaint-settle can tell that the
    // post-resize redraw has landed (data after the resize) and then quiesced.
    state.lastDataAt = Date.now();
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
   * Record a resize and report whether the column width changed from the last
   * known width. The session is seeded (initSession) with the actual spawn
   * cols, so the first renderer resize truthfully reports the 120-to-fitted
   * width change on a cold launch - the signal the repaint-settle keys on.
   *
   * A width change stamps pendingRepaintAt: a full-screen agent TUI repaints
   * asynchronously in response to the SIGWINCH this resize triggers, and
   * getScrollback must wait for that repaint before sampling (see
   * waitForResizeRepaint). onResize itself does not touch scrollback; a stale
   * "must not clear on the first resize" guard used to swallow this signal and
   * has been removed (nothing consumes it to clear anything).
   */
  onResize(sessionId: string, cols: number): boolean {
    const state = this.buffers.get(sessionId);
    if (!state) return false;

    const colsChanged = cols !== state.lastCols;
    state.lastCols = cols;
    if (colsChanged) {
      state.pendingRepaintAt = Date.now();
    }
    return colsChanged;
  }

  /**
   * Wait until the async repaint that follows a width-changing resize has
   * landed in the buffer and quiesced, so a getScrollback taken right after a
   * resize replays the frame at the NEW width instead of a stale one. Awaited
   * by SessionManager.getScrollback before it samples.
   *
   * No-op (resolves immediately) unless a fresh width change is pending AND the
   * session's scrollback shows a full-screen TUI (a \x1b[2J clear). Plain-shell
   * sessions and agents whose TUI never clears the screen have no SIGWINCH
   * repaint to wait for, so they keep sampling immediately - the pre-existing
   * behavior. Bounded by REPAINT_MAX_WAIT_MS from wait entry so a missing or
   * slow repaint can only delay a first paint, never hang the read.
   */
  async waitForResizeRepaint(sessionId: string): Promise<void> {
    const state = this.buffers.get(sessionId);
    if (!state || state.pendingRepaintAt === null) return;

    const stamp = state.pendingRepaintAt;
    const entryTime = Date.now();

    // A stamp older than STALE means the repaint has long since landed (or
    // never will) - clear it and sample now rather than wait pointlessly.
    if (entryTime - stamp > REPAINT_STALE_MS) {
      state.pendingRepaintAt = null;
      return;
    }

    // Gate on the TUI clear marker via a direct scan (NOT tuiStartIndex, which
    // cannot distinguish "marker absent" from "marker at index 0"). No marker
    // means no full-screen repaint to wait for.
    if (!state.scrollback.includes('\x1b[2J')) {
      state.pendingRepaintAt = null;
      return;
    }

    // Poll until repaint bytes have arrived after the resize stamp and then
    // gone quiet, or the deadline (measured from wait entry, so re-resizes
    // during a window drag cannot push it out indefinitely) is reached.
    const deadline = entryTime + REPAINT_MAX_WAIT_MS;
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        const current = this.buffers.get(sessionId);
        // Session torn down mid-wait (killed): stop waiting.
        if (!current) {
          resolve();
          return;
        }
        const now = Date.now();
        const settled =
          current.lastDataAt !== null &&
          current.lastDataAt > stamp &&
          now - current.lastDataAt >= REPAINT_QUIESCE_MS;
        if (settled || now >= deadline) {
          // Only clear the stamp this wait was anchored to. A second
          // width-changing resize during this wait re-stamps pendingRepaintAt
          // to a newer value for a not-yet-settled repaint; nulling it
          // unconditionally would let the next getScrollback skip the wait and
          // sample that newer repaint stale. Leave a newer stamp in place so it
          // gets its own settle.
          if (current.pendingRepaintAt === stamp) current.pendingRepaintAt = null;
          resolve();
          return;
        }
        setTimeout(poll, REPAINT_POLL_MS);
      };
      setTimeout(poll, REPAINT_POLL_MS);
    });
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

    // Alt-screen enter goes first: it (re-)clears the alt buffer and switches
    // into it, so the input-mode reassert and the replayed frame land where
    // the session actually is. Gated on inAltScreen so a classic normal-buffer
    // session's replay is byte-for-byte unchanged (see the #313 comment on
    // RESTORABLE_DEC_PRIVATE_MODES). A dangling synchronized-output frame is
    // closed at the very end so a mid-frame sample can't stall xterm's
    // renderer for its ~1s safety timeout.
    return (state.inAltScreen ? '\x1b[?1049h' : '')
      + buildDecPrivateModePrefix(state.decPrivateModes)
      + '\x1b[0m'
      + scrollback
      + (state.synchronizedOpen ? '\x1b[?2026l' : '');
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
