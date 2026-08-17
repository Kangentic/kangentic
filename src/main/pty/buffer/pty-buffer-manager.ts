import { findSafeStartIndex } from './scrollback-utils';
import { HeadlessFrameBuffer } from './headless-frame';
import { collectPeekLines, PEEK_LINE_COUNT } from './output-peek';
import { traceTerminal, type RepaintSettleReason } from '../terminal-trace';

const MAX_SCROLLBACK = 512 * 1024; // 512KB per session
/**
 * Already-scrolled rows the output peek reads above the viewport. Covers the
 * case where the cursor sits near the top of a freshly-scrolled viewport and the
 * lines worth showing have just passed above it. Small on purpose: the peek
 * scans upward only until it has collected its handful of lines.
 */
const PEEK_SCROLLBACK_LOOKBACK_ROWS = 12;
/**
 * Fallback grid rows for the headless parser when a caller omits the geometry.
 * The spawn path (session-spawn-flow) and resize path (session-manager) supply
 * real dimensions; the spawn-FAILURE path (spawn-failure-handler) omits rows,
 * which is safe only because a failed session has no PTY, so
 * SessionManager.resize early-returns before onResize could read the stale
 * default (matching DEFAULT_PTY_ROWS). Rows feed the repaint-settle's
 * row-change detection (see onResize), so an omitted-rows call after a
 * real-rows call reads as a spurious row change - onResize's sole production
 * caller (SessionManager.resize) always passes real rows, and tests that
 * exercise the settle must pass rows explicitly on every call.
 */
const DEFAULT_HEADLESS_ROWS = 30;
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
 * When the terminal geometry changes (cols OR rows), a full-screen agent TUI
 * (Claude, Codex) repaints its frame asynchronously in response to SIGWINCH. A
 * getScrollback that samples the buffer in the gap between the resize and that
 * repaint would replay a frame laid out for the OLD geometry - the stale-frame
 * bug this settle closes. So getScrollback waits for the repaint bytes to land
 * and quiesce before sampling, bounded so a missing repaint can never hang the
 * read. Width armed this settle first; rows-only changes (a bottom-panel height
 * drag, a vertical-only window resize) arm it too, since measured live
 * (2026-07-31, real Claude CLI in a preview, 12/12 trials idle and streaming):
 * the unarmed sample beat the SIGWINCH repaint every time and replayed the
 * old-row-count frame, and the rows repaint landed 21-122ms after the resize
 * ALWAYS carrying a full \x1b[2J erase, so the marker below settles it early
 * instead of riding the MAX_WAIT deadline.
 *
 * An actively streaming session never quiesces, so the wait also settles EARLY
 * the moment a full-frame repaint marker lands in the bytes appended AFTER the
 * resize. The marker is the \x1b[2J erase ONLY. \x1b[H cursor-home was tried and
 * removed: TUIs emit it for ordinary partial updates (a live session showed 169
 * cursor-homes to 56 erases), so it settled on a spinner tick and sampled the
 * pre-resize frame. The scan is offset-tracked via
 * pendingRepaintScrollbackLength, and the marker only counts while no
 * synchronized-output frame (DEC 2026) is open - that flag aligns the sample to
 * a frame boundary. Without the early settle, a streaming session always burned
 * the full MAX_WAIT and then sampled mid/pre-repaint anyway.
 *
 * STACKED resizes (a second geometry change while the previous repaint is still
 * pending - e.g. rapidly closing and reopening a task detail ping-pongs the
 * PTY between the dialog and bottom-panel widths) disable the marker-only
 * early settle: the first post-resize marker can be the PREVIOUS geometry's
 * repaint arriving late, and sampling on it replays a stale frame that
 * the real repaint then visibly corrects. When pendingRepaintStacked is set,
 * settling requires the marker AND a quiesce (both repaints landed and
 * stopped), falling back to the MAX_WAIT deadline while streaming. An arm
 * older than MAX_WAIT does not stack the next one: its repaint has landed or
 * never will (this settle itself stops waiting at MAX_WAIT), so an unconsumed
 * old arm - a height drag nothing sampled after - must not slow the next open.
 *
 *  - QUIESCE: no new data for this long counts as "the repaint has landed".
 *    ~3 flush ticks (16ms each), long enough to bridge a multi-chunk redraw.
 *    Required IN ADDITION to the marker on a stacked resize; it is NOT a
 *    standalone fallback, because "some bytes, then quiet" is satisfied by a
 *    spinner tick. A marker-less repaint rides the MAX_WAIT deadline instead.
 *  - MAX_WAIT: hard ceiling from wait entry. A geometry change with no repaint
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
 * The no-marker wait's own bounds (see the branch in waitForResizeRepaint).
 * A ring with no full-screen erase is usually a plain shell, whose answer to
 * SIGWINCH is little or nothing - so the silent grace is small and the
 * deadline sits far below the TUI's REPAINT_MAX_WAIT_MS. But "no marker" at
 * MOUNT time also describes a fullscreen TUI that has not drawn its first
 * frame yet, which is why this is a short wait and not the old instant
 * sample.
 */
const NO_MARKER_SILENT_GRACE_MS = 50;
const NO_MARKER_MAX_WAIT_MS = 150;

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

/**
 * Full-screen erase. The marker a fullscreen TUI emits when it redraws its whole
 * frame, which is therefore both "where the TUI took over" (first occurrence) and
 * "where the current frame begins" (last occurrence).
 */
const FULL_FRAME_CLEAR = '\x1b[2J';

/**
 * Hard ceiling on getReplaySnapshot's wait for the headless serialize. The
 * barrier normally resolves in a few milliseconds; it can only hang when the
 * headless terminal is disposed mid-sample (removeSession racing a replay) or
 * wedged behind a pathological parse backlog. Mirrors waitForResizeRepaint's
 * REPAINT_MAX_WAIT_MS discipline: every await on the replay path carries a
 * teardown check and a deadline, so an IPC reply can never hang on a disposed
 * parser (the renderer's replay watchdog stays a last resort, not the primary
 * bound). On deadline the sample degrades to the byte replay.
 */
const REPLAY_SERIALIZE_MAX_WAIT_MS = 1000;

function buildDecPrivateModePrefix(activeModes: Set<number>): string {
  if (activeModes.size === 0) return '';
  const sortedModes = Array.from(activeModes).sort((first, second) => first - second);
  return `\x1b[?${sortedModes.join(';')}h`;
}

interface PtyBufferManagerCallbacks {
  onFlush(sessionId: string, data: string): void;
  /** Replay-drain report: fired synchronously at the moment a replay sample
   *  (getScrollback / getReplaySnapshot) empties the pending buffer as its
   *  double-delivery guard, carrying exactly the drained bytes (never an
   *  empty string). The requesting renderer receives those bytes inside the
   *  replay payload, but focus-independent consumers (SessionManager's
   *  'data-tap') never see a replay - this callback is their only source for
   *  them, so dropping it silently starves a streaming phone of whatever was
   *  pending when a desktop terminal mounted the same session. Listeners
   *  must not call back into the buffer manager synchronously, and must not
   *  throw - a throw is caught and logged at the reportDrain chokepoint so
   *  it can never unwind a replay whose pending buffer is already emptied. */
  onDrain(sessionId: string, data: string): void;
}

interface BufferState {
  buffer: string;
  flushScheduled: boolean;
  /** Count of getReplaySnapshot samples currently awaiting their serialize.
   *  While > 0, scheduleFlush's tick re-arms instead of emitting, so no flush
   *  can slip between a sample's drain and its IPC reply - the renderer drops
   *  held bytes it believes the reply already contains, so an early flush here
   *  would get those bytes silently discarded. A counter (not a boolean)
   *  because staggered samplers can overlap; bounded by the sample's serialize
   *  deadline and decremented in its finally, so a tick is deferred at most
   *  one sample's duration. */
  replaySamplesInFlight: number;
  scrollback: string;
  lastCols: number;
  /** The row count the bytes currently in the scrollback were drawn for,
   *  mirroring lastCols. Feeds onResize's row-change detection, which arms the
   *  repaint settle exactly like a width change (see the constants doc above). */
  lastRows: number;
  /** Timestamp (Date.now()) of the most recent geometry-changing resize, or
   *  null when none is pending. Set by onResize when cols or rows change;
   *  consumed and cleared by waitForResizeRepaint once the post-resize repaint
   *  has settled. Drives the repaint-settle in getScrollback. */
  pendingRepaintAt: number | null;
  /** scrollback.length at the moment of the pending geometry-changing resize,
   *  or null when none is pending. Lets waitForResizeRepaint scan only the
   *  bytes appended AFTER the resize for a full-frame repaint marker (early
   *  settle while the session streams). Adjusted downward when the scrollback
   *  is trimmed mid-wait; cleared together with pendingRepaintAt. */
  pendingRepaintScrollbackLength: number | null;
  /** True when the pending geometry change landed while a PREVIOUS repaint was
   *  still unconsumed (rapid resize ping-pong). Disables the marker-only
   *  early settle for this wait: the next marker may be the previous
   *  geometry's repaint, so settling requires marker AND quiesce (see the
   *  constants doc above). Cleared together with pendingRepaintAt. */
  pendingRepaintStacked: boolean;
  /** The settle already in flight for `pendingRepaintAt`, so concurrent
   *  samplers of the SAME resize share one wait instead of racing two.
   *  Stamped with the resize it is anchored to; a newer resize gets its own.
   *  Cleared by whichever wait created it, once that wait resolves. */
  repaintSettle: { stamp: number; promise: Promise<void> } | null;
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
  /** Per-session headless xterm parser, fed the SAME bytes as `scrollback`.
   *  Its serialized frame is a snapshot of the PARSED grid, served instead of
   *  the raw byte replay so write-once static TUI cells (whose drawing bytes
   *  have aged out of the 512KB window) survive a cold replay. Two consumers:
   *  the mobile seed (getSerializedFrame) and the desktop alt-screen replay
   *  (getReplaySnapshot); desktop non-alt sessions still read the raw
   *  `scrollback`. Disposed in removeSession. */
  headless: HeadlessFrameBuffer;
}

/** Clear the pending-repaint tracking as one unit. The three fields are set
 *  together in onResize and must never be cleared piecemeal - a survivor
 *  would make the NEXT wait settle in the wrong mode. */
function clearPendingRepaint(state: BufferState): void {
  state.pendingRepaintAt = null;
  state.pendingRepaintScrollbackLength = null;
  state.pendingRepaintStacked = false;
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

  initSession(sessionId: string, previousScrollback: string, initialCols: number, initialRows: number = DEFAULT_HEADLESS_ROWS): void {
    // Sized to the initial PTY geometry so the very first serialized frame is
    // laid out at the right width; onResize keeps it in step thereafter.
    const headless = new HeadlessFrameBuffer(initialCols, initialRows);
    // Seed the parser with carried-over scrollback (empty on a fresh spawn) so a
    // respawn's first frame reconstructs the prior grid, mirroring how the raw
    // scrollback path replays previousScrollback.
    if (previousScrollback) headless.write(previousScrollback);
    this.buffers.set(sessionId, {
      buffer: '',
      flushScheduled: false,
      replaySamplesInFlight: 0,
      scrollback: previousScrollback,
      lastCols: initialCols,
      lastRows: initialRows,
      pendingRepaintAt: null,
      pendingRepaintScrollbackLength: null,
      pendingRepaintStacked: false,
      repaintSettle: null,
      lastDataAt: null,
      tuiStartIndex: previousScrollback ? 0 : -1,
      // Start empty/false even on carry-over: the new process re-emits its own modes.
      decPrivateModes: new Set<number>(),
      inAltScreen: false,
      synchronizedOpen: false,
      modeParseCarry: '',
      headless,
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
    // Feed the headless parser the SAME bytes so its parsed grid (the mobile
    // seed source) stays in lockstep with the raw scrollback ring.
    state.headless.write(data);
    // Stamp the arrival so a pending repaint-settle can tell that the
    // post-resize redraw has landed (data after the resize) and then quiesced.
    state.lastDataAt = Date.now();
    if (state.scrollback.length > SCROLLBACK_TRIM_THRESHOLD) {
      const lengthBeforeTrim = state.scrollback.length;
      state.scrollback = state.scrollback.slice(-MAX_SCROLLBACK);
      const safeStart = findSafeStartIndex(state.scrollback);
      if (safeStart > 0) {
        state.scrollback = state.scrollback.slice(safeStart);
      }
      // Shift the post-resize scan offset by the trimmed prefix so a
      // repaint-settle wait in flight keeps scanning the right region.
      if (state.pendingRepaintScrollbackLength !== null) {
        const removedCharacters = lengthBeforeTrim - state.scrollback.length;
        state.pendingRepaintScrollbackLength = Math.max(0, state.pendingRepaintScrollbackLength - removedCharacters);
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
      // A replay snapshot is mid-sample: hold this tick (re-arm, do not emit)
      // so no flush lands between the sample's drain and its reply. The
      // sample's tail fold delivers whatever is buffered; anything left on its
      // degraded paths rides the re-armed tick once the counter drops.
      if (current.replaySamplesInFlight > 0) {
        this.scheduleFlush(sessionId, current);
        return;
      }
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
   * geometry, so the first renderer resize truthfully reports the
   * 120x30-to-fitted change on a cold launch - the signal the repaint-settle
   * keys on.
   *
   * A geometry change (cols OR rows) stamps pendingRepaintAt: a full-screen
   * agent TUI repaints asynchronously in response to the SIGWINCH this resize
   * triggers, and getScrollback must wait for that repaint before sampling (see
   * waitForResizeRepaint). Rows arm the settle since the 2026-07-31 live
   * measurement (see the constants doc above): a rows-only resize's unarmed
   * sample replayed the old-row-count frame 12/12 times, and the repaint always
   * carried the \x1b[2J marker, so arming costs ~25-125ms, not the deadline.
   * onResize itself does not touch scrollback; a stale "must not clear on the
   * first resize" guard used to swallow this signal and has been removed.
   *
   * The RETURN VALUE stays colsChanged: it is reporting, not arming. It crosses
   * the IPC boundary (where the renderer deliberately ignores it) and the
   * mobile wire (InteractiveTerminalResponsePayload in @kangentic/protocol,
   * a separately released shape), and nothing consumes a rows flag - so arming
   * widened without widening the report.
   *
   * `rows` defaults for callers that do not track rows, which makes an
   * omitted-rows call after a real-rows call read as a spurious row change.
   * Production always passes real rows (SessionManager.resize clamps and
   * forwards both dims), so that is reachable only from tests - which must
   * pass rows explicitly on every call when exercising the settle.
   */
  onResize(sessionId: string, cols: number, rows: number = DEFAULT_HEADLESS_ROWS): boolean {
    const state = this.buffers.get(sessionId);
    if (!state) return false;

    // Keep the headless parser's grid matched to the PTY on EVERY resize, so a
    // serialized frame always reflows to the current geometry.
    state.headless.resize(cols, rows);

    const colsChanged = cols !== state.lastCols;
    const rowsChanged = rows !== state.lastRows;
    if (colsChanged || rowsChanged) {
      traceTerminal(sessionId, 'pty-resize', {
        fromCols: state.lastCols,
        toCols: cols,
        fromRows: state.lastRows,
        toRows: rows,
      });
    }
    state.lastCols = cols;
    state.lastRows = rows;
    if (colsChanged || rowsChanged) {
      const now = Date.now();
      // A geometry change on top of a still-pending RECENT repaint means two
      // repaints are (or may be) in flight; mark the wait so it cannot
      // early-settle on the first (possibly previous-geometry) marker. Recency
      // matters: past REPAINT_MAX_WAIT_MS the previous repaint has landed or
      // never will (the settle itself stops waiting for it then), so an older
      // arm is just one nothing sampled - e.g. a bottom-panel height drag with
      // no replay after it. Counting it as "in flight" upgraded the NEXT
      // settle to marker-and-quiesce, and a streaming session never quiesces,
      // so an ordinary drag-then-open rode the full deadline instead of
      // settling on the marker.
      state.pendingRepaintStacked =
        state.pendingRepaintAt !== null && now - state.pendingRepaintAt < REPAINT_MAX_WAIT_MS;
      state.pendingRepaintAt = now;
      state.pendingRepaintScrollbackLength = state.scrollback.length;
    }
    return colsChanged;
  }

  /**
   * Wait until the async repaint that follows a geometry-changing resize has
   * landed in the buffer and quiesced, so a getScrollback taken right after a
   * resize replays the frame at the NEW geometry instead of a stale one.
   * Awaited by SessionManager.getScrollback before it samples.
   *
   * No-op (resolves immediately) unless a fresh geometry change is pending AND
   * the session's scrollback shows a full-screen TUI (a \x1b[2J clear).
   * Plain-shell sessions and agents whose TUI never clears the screen have no
   * SIGWINCH repaint to wait for, so they keep sampling immediately - the
   * pre-existing behavior. Bounded by REPAINT_MAX_WAIT_MS from wait entry so a
   * missing or slow repaint can only delay a first paint, never hang the read.
   */
  async waitForResizeRepaint(sessionId: string): Promise<void> {
    const state = this.buffers.get(sessionId);
    if (!state || state.pendingRepaintAt === null) {
      traceTerminal(sessionId, 'settle', { reason: 'not-armed' satisfies RepaintSettleReason });
      return;
    }

    const stamp = state.pendingRepaintAt;

    // A second sampler for the SAME resize JOINS the wait already in flight
    // rather than starting its own. Two independent waits cannot both work:
    // whichever settles first calls clearPendingRepaint, which nulls
    // pendingRepaintScrollbackLength - and that field is the early-settle
    // predicate's scan offset, re-read on every poll. The loser's
    // markerSampleSafe is then false forever, so it cannot early-settle at all
    // and rides REPAINT_MAX_WAIT_MS out, turning a ~20ms open into a ~420ms
    // one. Not a rare race: measured live, 24 of 24 deadline settles in one
    // trace ring were this, each preceded by a marker settle for the same
    // resize. Concurrent samplers are ordinary - a bottom-panel tab and a
    // detail window both mount for one session during a handover, and dev
    // StrictMode double-mounts every terminal.
    //
    // Joining is also the CORRECT semantic, not just the fast one: "the
    // repaint following resize S" is one event, so every sampler waiting on S
    // should see the same answer. A newer resize does not join - it re-stamps
    // pendingRepaintAt, so its waiter takes a fresh wait for its own repaint.
    const settleInFlight = state.repaintSettle;
    if (settleInFlight !== null && settleInFlight.stamp === stamp) {
      traceTerminal(sessionId, 'settle', { reason: 'joined' satisfies RepaintSettleReason });
      return settleInFlight.promise;
    }

    const entryTime = Date.now();

    // A stamp older than STALE means the repaint has long since landed (or
    // never will) - clear it and sample now rather than wait pointlessly.
    if (entryTime - stamp > REPAINT_STALE_MS) {
      clearPendingRepaint(state);
      traceTerminal(sessionId, 'settle', {
        reason: 'stale-stamp' satisfies RepaintSettleReason,
        ageMs: entryTime - stamp,
        lastCols: state.lastCols,
        lastRows: state.lastRows,
      });
      return;
    }

    // Gate on the TUI clear marker via a direct scan (NOT tuiStartIndex, which
    // cannot distinguish "marker absent" from "marker at index 0"). No marker
    // anywhere in the ring does NOT mean nothing is coming: at MOUNT time a
    // fullscreen TUI that has not drawn its first frame yet has no marker
    // either, and the old instant sample here replayed a near-empty ring
    // (observed live: 237 bytes where a settled mount replays hundreds of KB)
    // - with the resting park live, every reopen is a geometry-changing mount
    // that crosses exactly this path. It USUALLY means a plain shell though,
    // and a shell answers SIGWINCH with little or nothing, so this wait is
    // shaped differently from the TUI path below:
    //  - a post-resize erase marker upgrades to a frame-boundary sample (the
    //    TUI's first frame just landed);
    //  - marker-less bytes that arrived and went quiet sample on the lull;
    //  - a session that stays silent samples after a small grace, never the
    //    TUI's 400ms deadline (that would slow every Command Terminal open).
    if (!state.scrollback.includes(FULL_FRAME_CLEAR)) {
      const noMarkerDeadline = entryTime + NO_MARKER_MAX_WAIT_MS;
      const noMarkerPromise = new Promise<void>((resolve) => {
        const poll = (): void => {
          const current = this.buffers.get(sessionId);
          // Session torn down mid-wait (killed): stop waiting.
          if (!current) {
            resolve();
            return;
          }
          const now = Date.now();
          const scanOffset = current.pendingRepaintScrollbackLength;
          const firstFrameLanded =
            scanOffset !== null &&
            !current.synchronizedOpen &&
            current.scrollback.indexOf(FULL_FRAME_CLEAR, scanOffset) !== -1;
          const quiesced =
            current.lastDataAt !== null &&
            current.lastDataAt >= stamp &&
            now - current.lastDataAt >= REPAINT_QUIESCE_MS;
          const stayedSilent =
            (current.lastDataAt === null || current.lastDataAt < stamp) &&
            now - entryTime >= NO_MARKER_SILENT_GRACE_MS;
          if (firstFrameLanded || quiesced || stayedSilent || now >= noMarkerDeadline) {
            traceTerminal(sessionId, 'settle', {
              reason: (firstFrameLanded
                ? 'no-marker-first-frame'
                : quiesced
                  ? 'no-marker-quiesce'
                  : stayedSilent
                    ? 'no-tui-marker'
                    : 'no-marker-deadline') satisfies RepaintSettleReason,
              waitedMs: now - entryTime,
              lastCols: current.lastCols,
              lastRows: current.lastRows,
            });
            // Only clear the stamp this wait was anchored to (same rule as
            // the marker path below).
            if (current.pendingRepaintAt === stamp) {
              clearPendingRepaint(current);
            }
            resolve();
            return;
          }
          setTimeout(poll, REPAINT_POLL_MS);
        };
        setTimeout(poll, REPAINT_POLL_MS);
      });
      // Publish so a concurrent sampler for the same resize JOINS this wait
      // (the same two-surfaces/StrictMode reality as the marker path).
      state.repaintSettle = { stamp, promise: noMarkerPromise };
      try {
        await noMarkerPromise;
      } finally {
        const current = this.buffers.get(sessionId);
        if (current?.repaintSettle?.stamp === stamp) current.repaintSettle = null;
      }
      return;
    }

    // Poll until repaint bytes have arrived after the resize stamp and then
    // gone quiet, or the deadline (measured from wait entry, so re-resizes
    // during a window drag cannot push it out indefinitely) is reached.
    const deadline = entryTime + REPAINT_MAX_WAIT_MS;
    const settlePromise = new Promise<void>((resolve) => {
      const poll = (): void => {
        const current = this.buffers.get(sessionId);
        // Session torn down mid-wait (killed): stop waiting.
        if (!current) {
          resolve();
          return;
        }
        const now = Date.now();
        // Early settle for a STREAMING session (which never quiesces): the
        // bytes appended after the resize contain the full-frame repaint
        // marker and no synchronized-output frame is open, so the sample lands
        // on a frame boundary at the NEW geometry. Marker-less repaints fall
        // through to the deadline below.
        const scanOffset = current.pendingRepaintScrollbackLength;
        // The marker must mean "the whole frame was redrawn". Only a full-screen
        // ERASE means that. A bare cursor-home used to count here and it is the
        // reason opening a task detail flickered: a fullscreen TUI emits
        // cursor-home for ordinary partial updates (a spinner tick, redrawing one
        // line), so the first routine byte after the resize satisfied the settle
        // and getScrollback sampled the PRE-resize frame. The user then saw that
        // stale frame - drawn wide, wrapped into the narrower window - before the
        // held live bytes replaced it with the real repaint. Measured on a live
        // Claude session: 169 cursor-homes to 56 full-screen clears in one 512KB
        // ring, so the false marker outnumbered the true one 3:1.
        //
        // A TUI that repaints without erasing has no marker to key on, so it rides
        // the full REPAINT_MAX_WAIT_MS deadline below rather than settling early.
        // That is deliberate, not an oversight: as the note on `settled` explains,
        // a quiesce alone cannot stand in for the erase marker here (a spinner tick
        // plus an ordinary lull satisfies it), and settling early on that was the
        // other half of the flicker. Correct if slower - the previous behavior
        // traded correctness for that latency on EVERY session.
        const markerSampleSafe =
          scanOffset !== null &&
          !current.synchronizedOpen &&
          current.scrollback.indexOf(FULL_FRAME_CLEAR, scanOffset) !== -1;
        // `>=`, not `>`: a repaint that lands in the SAME millisecond as the
        // resize is still a post-resize repaint. With `>` it was invisible to the
        // quiesce path, so a marker-less agent fell through to the full deadline.
        const quiesced =
          current.lastDataAt !== null &&
          current.lastDataAt >= stamp &&
          now - current.lastDataAt >= REPAINT_QUIESCE_MS;
        // A quiesce ALONE cannot stand in for the repaint on a session we already
        // know is a fullscreen TUI (this wait only arms when the scrollback shows
        // a full-screen clear). "Some bytes arrived, then it went quiet for 50ms"
        // is satisfied by a spinner tick followed by an ordinary lull, and that is
        // the other half of the flicker: with the false cursor-home marker removed,
        // the quiesce path still settled on the tick and sampled the pre-resize
        // frame. The erase marker is the only byte sequence that actually means
        // "the frame was redrawn", so for a TUI it is required, bounded by the
        // deadline below so a genuinely missing repaint can still never hang.
        //
        // Stacked resizes additionally require quiesce: the first post-resize
        // erase can be the PREVIOUS geometry's repaint arriving late, so both
        // must have landed and stopped.
        const settled = current.pendingRepaintStacked
          ? markerSampleSafe && quiesced
          : markerSampleSafe;
        if (settled || now >= deadline) {
          traceTerminal(sessionId, 'settle', {
            reason: (settled
              ? (current.pendingRepaintStacked ? 'marker-and-quiesce' : 'marker')
              : 'deadline') satisfies RepaintSettleReason,
            waitedMs: now - entryTime,
            // The geometry the bytes about to be sampled were DRAWN at. If it
            // is not the geometry the renderer just fitted to, the replay is a
            // stale frame and the user will see it corrected.
            lastColsAtSample: current.lastCols,
            lastRowsAtSample: current.lastRows,
            stacked: current.pendingRepaintStacked,
          });
          // Only clear the stamp this wait was anchored to. A second
          // geometry-changing resize during this wait re-stamps pendingRepaintAt
          // to a newer value for a not-yet-settled repaint; nulling it
          // unconditionally would let the next getScrollback skip the wait and
          // sample that newer repaint stale. Leave a newer stamp in place so it
          // gets its own settle.
          if (current.pendingRepaintAt === stamp) {
            clearPendingRepaint(current);
          }
          resolve();
          return;
        }
        setTimeout(poll, REPAINT_POLL_MS);
      };
      setTimeout(poll, REPAINT_POLL_MS);
    });

    // Publish before awaiting, so a sampler that arrives mid-wait can join.
    state.repaintSettle = { stamp, promise: settlePromise };
    try {
      await settlePromise;
    } finally {
      // Only retract our own entry. A newer resize during this wait installs
      // its own settle; clearing unconditionally would strand that one's
      // joiners into the private wait this fix exists to remove.
      const current = this.buffers.get(sessionId);
      if (current?.repaintSettle?.stamp === stamp) current.repaintSettle = null;
    }
  }

  /**
   * The geometry this session's PTY was last resized to, as the buffer manager
   * saw it, plus whether a post-resize repaint is still outstanding.
   *
   * Dev diagnostics only. `lastCols`/`lastRows` are the geometry the bytes
   * currently in the scrollback were DRAWN at, which is the number you need to
   * explain a terminal whose content does not match its grid - the divergence
   * is invisible from the renderer, which only knows its own xterm's size.
   */
  getDimensionState(sessionId: string): {
    lastCols: number;
    lastRows: number;
    pendingRepaintAt: number | null;
    pendingRepaintStacked: boolean;
    inAltScreen: boolean;
  } | null {
    const state = this.buffers.get(sessionId);
    if (!state) return null;
    return {
      lastCols: state.lastCols,
      lastRows: state.lastRows,
      pendingRepaintAt: state.pendingRepaintAt,
      pendingRepaintStacked: state.pendingRepaintStacked,
      inAltScreen: state.inAltScreen,
    };
  }

  /** Report bytes a replay sample drained out of the pending buffer (see
   *  PtyBufferManagerCallbacks.onDrain). One chokepoint for every drain site
   *  so the non-empty guard, the trace, and the throw guard cannot diverge.
   *
   *  ORDERING RULE for every call site: clear `state.buffer` BEFORE calling
   *  this. The emptied buffer plus the non-empty guard below is what makes a
   *  re-entrant listener (one that synchronously calls getScrollback /
   *  getReplaySnapshot back into this manager) a harmless no-op instead of
   *  unbounded recursion with duplicate tap delivery - and at the serialize
   *  site it is also the counter's exception-safety. Report-before-clear
   *  breaks both silently. */
  private reportDrain(sessionId: string, drained: string): void {
    if (!drained) return;
    traceTerminal(sessionId, 'replay-drain', { bytes: drained.length });
    try {
      this.callbacks.onDrain(sessionId, drained);
    } catch (error) {
      // Two of the three drain sites run after the pending buffer is already
      // emptied; a listener throw propagating from there would reject the
      // replay IPC with the drained bytes gone. The report is best-effort by
      // contract, so contain the throw here.
      console.error('[pty-buffer] onDrain listener threw:', error);
    }
  }

  getScrollback(sessionId: string): string {
    const state = this.buffers.get(sessionId);
    if (!state?.scrollback) return '';
    // Drain the pending buffer so the next 16ms flush fires harmlessly
    // (empty buffer -> onFlush skipped). Without this, data appended to
    // both buffer and scrollback by onData() would be delivered twice:
    // once via the scrollback replay and again by the stale flush. The
    // requesting renderer gets the drained bytes inside this replay, but
    // focus-independent data-tap consumers never see a replay, so the drain
    // reports them through onDrain instead of dropping them.
    const drained = state.buffer;
    state.buffer = '';
    this.reportDrain(sessionId, drained);

    let scrollback = state.scrollback;

    // Strip pre-TUI noise (shell command line) on first read.
    // The \x1b[2J (clear screen) marks where the agent TUI took over.
    // Best-effort heuristic: agents without a TUI (e.g. Aider) don't emit
    // [2J, so their shell command stays in scrollback.
    // Cache the index so subsequent reads don't re-scan.
    if (state.tuiStartIndex === -1) {
      const clearIdx = scrollback.indexOf(FULL_FRAME_CLEAR);
      state.tuiStartIndex = clearIdx > 0 ? clearIdx : 0;
    }
    if (state.tuiStartIndex > 0) {
      scrollback = scrollback.slice(state.tuiStartIndex);
    }

    // DO NOT trim the replay to the last full-screen clear.
    //
    // It is tempting: in the alt buffer there is no user-visible scrollback, so a
    // clear-screen looks like a safe replay boundary, and slicing there cuts a
    // 512KB ring to ~1.5KB. It was tried and REVERTED - it produced a
    // permanently black terminal on a fast open/close/reopen.
    //
    // A raw byte replay is not a frame snapshot. A fullscreen TUI does not redraw
    // every cell after every clear: write-once static cells keep their content
    // from earlier bytes, which is exactly why the mobile seed path uses the
    // headless PARSED grid (`getSerializedFrame`) instead of this byte replay -
    // see the note on BufferState.headless. Slicing at the last clear discards
    // those cells, and when the sample lands at or just after a clear (likely on a
    // rapid reopen, where the settle rides its deadline mid-repaint) the replay is
    // a clear with nothing after it: black, until something happens to force a
    // full redraw.
    //
    // The alt-screen replay path now does take the safe shape: getReplaySnapshot
    // serves the PARSED-grid frame (which reconstructs the screen rather than
    // betting that the bytes after some marker are sufficient to draw it) when
    // the session is in the alt buffer, so a ring capped past a write-once
    // region no longer loses those cells on remount. This byte path remains the
    // replay for non-alt sessions, where the warning above still stands.
    //
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
    // RESTORABLE_DEC_PRIVATE_MODES). Through the app's replay path this branch
    // now fires only rarely: getReplaySnapshot routes an alt-screen session to
    // the parsed-grid frame and reaches here alt-gated only via its
    // serialize-deadline fallback, so in normal operation this method serves
    // non-alt sessions (plus direct callers and unit tests). A dangling
    // synchronized-output frame is closed at the very end so a mid-frame
    // sample can't stall xterm's renderer for its ~1s safety timeout.
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

  /**
   * Snapshot of the PARSED grid as a self-contained escape-sequence frame, for
   * the mobile seed (getReplaySnapshot serves the desktop equivalent). Unlike
   * getScrollback (a raw 512KB byte replay), this reconstructs every
   * currently-visible cell whatever its draw age, so a fullscreen TUI's
   * write-once static regions are never dropped. The frame carries its own
   * alt-screen switch and mode re-asserts (emitted by the serialize addon
   * mid-stream, after the serialized normal buffer - not a leading prefix), so
   * the phone lands in the correct screen with the correct input modes.
   * Known gap, accepted for mobile: the addon cannot emit the mouse ENCODING
   * modes (1005/1006/1015/1016), which cost the desktop wheel scroll and is
   * folded back on in getReplaySnapshot; the phone's terminal is touch-driven
   * and sends no mouse reports, so this frame stays bare until a phone-side
   * need appears. Returns '' for an unknown session.
   */
  async getSerializedFrame(sessionId: string): Promise<string> {
    const state = this.buffers.get(sessionId);
    if (!state) return '';
    return state.headless.serialize();
  }

  /**
   * The desktop replay payload: the parsed-grid serialized frame when the
   * session is in the alt screen, the raw byte replay (getScrollback)
   * otherwise.
   *
   * A fullscreen TUI does not redraw every cell after every clear, so once the
   * ring outgrows MAX_SCROLLBACK the bytes that drew its write-once static
   * regions are gone and no byte replay can reconstruct them - a remount at
   * unchanged geometry (no SIGWINCH, so no fresh repaint to wait for) paints a
   * permanently holed frame until a cols-changing resize. The parsed grid
   * reconstructs every visible cell whatever its draw age, and the alt buffer
   * has no user-reachable scrollback, so serving the frame there loses nothing
   * the user could scroll to. Non-alt sessions (plain shells, agents without a
   * TUI) keep the byte replay: their scrollback IS the bytes, and truncation
   * there only loses old history.
   *
   * The frame carries the addon's own alt-screen switch and mode re-asserts
   * (mid-stream, after the serialized normal buffer, not a leading prefix),
   * followed by two appendices of ours: the folded DEC private mode prefix
   * (the addon cannot emit the mouse ENCODING modes 1005/1006/1015/1016, so
   * without it wheel scroll died after every same-grid remount - see the tail
   * fold below) and any bytes that raced the sample.
   */
  async getReplaySnapshot(sessionId: string): Promise<string> {
    const state = this.buffers.get(sessionId);
    if (!state?.scrollback) return '';
    if (!state.inAltScreen) {
      const scrollback = this.getScrollback(sessionId);
      traceTerminal(sessionId, 'scrollback-sample', { source: 'byte-replay', bytes: scrollback.length });
      return scrollback;
    }
    // Exactly-once accounting for bytes that race the sample. The drain and
    // the serialize() call are back-to-back synchronous statements, so the
    // drained set is exactly the bytes fed to the headless parser before the
    // barrier - and the serialize (atomic with its barrier, see
    // HeadlessFrameBuffer.serialize) bakes all of them into the frame and none
    // that arrive later. Bytes arriving DURING the await land in the emptied
    // pending buffer; the tick hold (replaySamplesInFlight, see scheduleFlush)
    // keeps them from being flushed ahead of the reply (the renderer drops
    // held bytes as already-replayed), and the tail fold below ships them with
    // the frame instead. The deadline and the post-await teardown check mirror
    // waitForResizeRepaint's discipline: this await must never leave the IPC
    // reply hanging on a disposed parser.
    // Report the drain before the in-flight increment. reportDrain contains
    // a listener throw (see the chokepoint), so the increment/decrement
    // pairing below is unconditional either way; the ordering keeps the
    // report outside the sampling critical section on principle. All of
    // this is synchronous, so no flush tick can interleave.
    const drainedBeforeSerialize = state.buffer;
    state.buffer = '';
    this.reportDrain(sessionId, drainedBeforeSerialize);
    state.replaySamplesInFlight += 1;
    try {
      let deadlineTimer: NodeJS.Timeout | undefined;
      let frame: string | null;
      try {
        frame = await Promise.race([
          state.headless.serialize(),
          new Promise<null>((resolve) => {
            deadlineTimer = setTimeout(() => resolve(null), REPLAY_SERIALIZE_MAX_WAIT_MS);
          }),
        ]);
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
      if (this.buffers.get(sessionId) !== state) {
        // Torn down mid-sample (removeSession disposed the parser): nothing to
        // replay; the renderer's empty-scrollback path flushes its held bytes.
        // IDENTITY comparison, not presence: if the id were ever re-initialized
        // while this sample was in flight, a presence check would pass on the
        // NEW state while the tail fold below read - and reported to data-tap -
        // the dead generation's buffer under a live session id.
        traceTerminal(sessionId, 'scrollback-sample', { source: 'parsed-grid-torn-down', bytes: 0 });
        return '';
      }
      if (frame === null) {
        // Deadline: the parser is wedged or was disposed without settling its
        // barrier. Degrade to the byte replay (whose alt-screen branch
        // hand-builds the \x1b[?1049h + mode prefix for exactly this case)
        // rather than replying with a black frame.
        const scrollback = this.getScrollback(sessionId);
        traceTerminal(sessionId, 'scrollback-sample', { source: 'byte-replay-deadline', bytes: scrollback.length });
        return scrollback;
      }
      // Tail fold: bytes that arrived during the await postdate the frame, so
      // appending them replays them exactly once, in order. Draining them here
      // keeps the held flush tick silent once it re-fires.
      const tail = state.buffer;
      state.buffer = '';
      this.reportDrain(sessionId, tail);
      // Re-assert the tracked DEC private modes after the frame. The serialize
      // addon emits mouse TRACKING from terminal.modes (?1000h etc.) but has no
      // API for the mouse ENCODING modes (1005/1006/1015/1016), so a bare frame
      // left xterm reporting legacy X10 bytes that an SGR-expecting TUI
      // ignores: wheel scroll went dead after every same-grid remount until the
      // TUI happened to re-assert its own modes in the live stream. The folded
      // prefix covers every mode in RESTORABLE_DEC_PRIVATE_MODES, and
      // re-asserting one the addon already emitted is a no-op.
      const payload = frame + buildDecPrivateModePrefix(state.decPrivateModes) + tail;
      traceTerminal(sessionId, 'scrollback-sample', { source: 'parsed-grid', bytes: payload.length, tailBytes: tail.length });
      return payload;
    } finally {
      state.replaySamplesInFlight -= 1;
    }
  }

  /**
   * The last few meaningful rendered lines, for the Agent Monitor's output peek.
   * Empty array for an unknown session.
   *
   * SYNCHRONOUS, and reads the PARSED grid rather than the byte ring. Both
   * matter. Sync keeps it callable from a sampling timer without the 400ms
   * repaint-settle wait that `SessionManager.getSerializedFrame` takes; parsed
   * keeps it correct for a fullscreen TUI, whose raw byte tail is repaint
   * sequences rather than readable text (see the reverted slice-at-last-clear
   * note on getScrollback above).
   *
   * The line-selection rule lives in `output-peek.ts`, designed against captured
   * real grids; this method only supplies the rows.
   */
  getOutputPeek(sessionId: string, count: number = PEEK_LINE_COUNT): string[] {
    const state = this.buffers.get(sessionId);
    if (!state) return [];
    const headless = state.headless;
    // Reads row by row rather than snapshotting the viewport, so the walk can
    // stop as soon as it has enough lines instead of always reading to the
    // floor. On a dense TUI grid that still touches most rows above the cursor
    // (see the count pinned in tests/unit/output-peek.test.ts); the win is
    // largest on a mostly-blank grid.
    return collectPeekLines(
      (row) => headless.lineAt(row),
      headless.cursorRow(),
      count,
      headless.peekFloorRow(PEEK_SCROLLBACK_LOOKBACK_ROWS),
    );
  }

  removeSession(sessionId: string): void {
    const state = this.buffers.get(sessionId);
    if (state) state.headless.dispose();
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
