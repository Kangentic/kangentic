import { describe, it, expect, vi } from 'vitest';
import { PtyBufferManager } from '../../src/main/pty/buffer/pty-buffer-manager';

describe('PtyBufferManager', () => {
  const SESSION = 'test-session';

  function createManager() {
    const onFlush = vi.fn();
    const manager = new PtyBufferManager({ onFlush });
    manager.initSession(SESSION, '', 80);
    // Simulate the initial resize that establishes real terminal dimensions.
    // This mirrors what the renderer does on first connection (fit + resize).
    manager.onResize(SESSION, 80);
    return { manager, onFlush };
  }

  describe('getScrollback drains pending buffer', () => {
    it('prevents stale flush after scrollback is consumed', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      // Simulate PTY data arriving (queues a 16ms flush)
      manager.onData(SESSION, 'hello world');

      // Renderer calls getScrollback before the flush fires
      const scrollback = manager.getScrollback(SESSION);
      expect(scrollback).toContain('hello world');

      // Advance past the 16ms timer - flush should find empty buffer
      vi.advanceTimersByTime(20);
      expect(onFlush).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('onResize tracks col changes', () => {
    it('reports colsChanged when width changes', () => {
      const { manager } = createManager();

      // Resize to different cols
      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(true);
    });

    it('preserves scrollback when cols change (read-time strip, no write-time clear)', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      manager.onData(SESSION, 'content at old width');
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalled();

      // Resize to different cols - scrollback preserved
      manager.onResize(SESSION, 120);
      expect(manager.getScrollback(SESSION)).toContain('content at old width');

      vi.useRealTimers();
    });

    it('keeps buffer when cols stay the same', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      manager.onData(SESSION, 'some data');

      // Resize with same cols (e.g. rows-only change)
      const colsChanged = manager.onResize(SESSION, 80);
      expect(colsChanged).toBe(false);

      // Buffer should still flush
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledWith(SESSION, 'some data');

      vi.useRealTimers();
    });

    it('returns false for unknown session', () => {
      const { manager } = createManager();
      expect(manager.onResize('nonexistent', 100)).toBe(false);
    });
  });

  describe('post-drain data flows normally', () => {
    it('flushes new data arriving after getScrollback drained the buffer', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      manager.onData(SESSION, 'first chunk');
      manager.getScrollback(SESSION);

      // Advance to clear the old timer
      vi.advanceTimersByTime(20);
      expect(onFlush).not.toHaveBeenCalled();

      // New data should schedule a new flush and deliver normally
      manager.onData(SESSION, 'second chunk');
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledWith(SESSION, 'second chunk');

      vi.useRealTimers();
    });
  });

  describe('resize reports width changes truthfully and preserves scrollback', () => {
    it('reports colsChanged=true on the first resize to a new width (no initial-resize swallow)', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      // Cold-launch shape: the PTY was spawned at 120, the buffer is seeded with
      // that real width, and the renderer fits to ~190 on mount. The first
      // resize must report the change truthfully so getScrollback's
      // repaint-settle arms. A stale first-resize swallow used to hide this.
      manager.initSession(SESSION, 'previous session output', 120);

      const colsChanged = manager.onResize(SESSION, 190);
      expect(colsChanged).toBe(true);
      // onResize never clears scrollback; carried-over history is preserved.
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
    });

    it('reports colsChanged=false when the first resize matches the seeded spawn width', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      // Pre-spawn-resize shape: the PTY was spawned AT the fitted width, so the
      // renderer's follow-up resize is a no-op and must not arm a needless wait.
      manager.initSession(SESSION, 'previous session output', 190);

      const colsChanged = manager.onResize(SESSION, 190);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
    });

    it('preserves scrollback across a later width change', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      manager.initSession(SESSION, 'previous session output', 120);
      manager.onResize(SESSION, 190);
      manager.onData(SESSION, 'live data');

      const colsChanged = manager.onResize(SESSION, 200);
      expect(colsChanged).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
      expect(manager.getScrollback(SESSION)).toContain('live data');
    });

    it('reports colsChanged=false on a same-width resize (rows-only change)', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      manager.initSession(SESSION, 'previous session output', 120);
      manager.onResize(SESSION, 120);
      manager.onData(SESSION, ' plus new data');

      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
      expect(manager.getScrollback(SESSION)).toContain('plus new data');
    });

    it('fresh session seeded at spawn width reports no change on a matching resize', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush });
      manager.initSession(SESSION, '', 120);

      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toBe('');
    });
  });

  describe('waitForResizeRepaint (repaint-settle before sampling)', () => {
    // Build the precondition the settle keys on: a full-screen TUI frame (with a
    // \x1b[2J clear) in the buffer, then a width change that stamps the pending
    // repaint. Returns the manager so each test drives the settle from there.
    function armWidthChange(tui = true): PtyBufferManager {
      const manager = new PtyBufferManager({ onFlush: vi.fn() });
      manager.initSession(SESSION, '', 120);
      manager.onData(SESSION, tui ? '\x1b[2Jold frame at 120 cols' : 'plain shell output');
      expect(manager.onResize(SESSION, 190)).toBe(true);
      return manager;
    }

    it('defers sampling until the post-resize repaint lands and quiesces', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // No repaint yet: the settle is still pending.
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The SIGWINCH repaint lands.
      manager.onData(SESSION, '\x1b[2Jrepaint at 190 cols');

      // Data just arrived: not yet quiesced.
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // Quiesce window elapses -> the settle resolves.
      await vi.advanceTimersByTimeAsync(80);
      await waitPromise;
      expect(settled).toBe(true);

      // The sample now includes the fitted-width repaint, not just the stale frame.
      expect(manager.getScrollback(SESSION)).toContain('repaint at 190 cols');

      vi.useRealTimers();
    });

    it('resolves at the max-wait ceiling when no repaint ever arrives', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // Well past a few polls but short of the ceiling: still waiting.
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(false);

      // Ceiling (400ms from entry) reached: resolves without a repaint.
      await vi.advanceTimersByTimeAsync(200);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('samples immediately when the pending resize is stale', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange();

      // Time passes beyond the stale window with no sample taken.
      await vi.advanceTimersByTimeAsync(2001);

      // No timers need to fire for the wait: it short-circuits.
      await manager.waitForResizeRepaint(SESSION);

      vi.useRealTimers();
    });

    it('samples immediately when the session has no full-screen TUI (no clear marker)', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange(false);

      await manager.waitForResizeRepaint(SESSION);

      vi.useRealTimers();
    });

    it('resolves if the session is torn down mid-wait', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // Killed: the session's buffer state is removed.
      manager.removeSession(SESSION);

      await vi.advanceTimersByTimeAsync(16);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('does not arm a wait when the width did not change', async () => {
      vi.useFakeTimers();
      const manager = new PtyBufferManager({ onFlush: vi.fn() });
      manager.initSession(SESSION, '', 120);
      manager.onData(SESSION, '\x1b[2Jframe at 120 cols');
      // Same-width resize: colsChanged false, no pending repaint stamped.
      expect(manager.onResize(SESSION, 120)).toBe(false);

      // No pending repaint -> short-circuits with no timers.
      await manager.waitForResizeRepaint(SESSION);

      vi.useRealTimers();
    });

    it('does not clobber a newer pending repaint stamped by a second resize mid-wait', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange(); // onResize(190) stamps the first repaint; TUI marker present

      // A first getScrollback wait anchors to the first resize's stamp.
      const firstWait = manager.waitForResizeRepaint(SESSION);

      // A second width-changing resize lands before the first wait resolves,
      // re-stamping pendingRepaintAt for a fresh, not-yet-settled repaint.
      await vi.advanceTimersByTimeAsync(50);
      expect(manager.onResize(SESSION, 200)).toBe(true);

      // The first wait reaches its ceiling (400ms from entry) and resolves. It
      // must NOT null out the newer stamp it was never anchored to.
      await vi.advanceTimersByTimeAsync(400);
      await firstWait;

      // A subsequent getScrollback must still defer for the second repaint,
      // which never landed. If the first wait had clobbered the stamp, this
      // read would short-circuit and sample the frame stale.
      let secondSettled = false;
      const secondWait = manager.waitForResizeRepaint(SESSION).then(() => {
        secondSettled = true;
      });
      await vi.advanceTimersByTimeAsync(16);
      expect(secondSettled).toBe(false);

      // Let it resolve at its own ceiling so no timer leaks into the next test.
      await vi.advanceTimersByTimeAsync(400);
      await secondWait;

      vi.useRealTimers();
    });
  });

  describe('per-flush byte cap', () => {
    const MAX_BYTES_PER_FLUSH = 256 * 1024;

    it('ships at most the cap per flush and reschedules the remainder', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      const total = MAX_BYTES_PER_FLUSH + 50_000;
      manager.onData(SESSION, 'x'.repeat(total));

      // First flush ships exactly the cap; the remainder stays buffered.
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0][1].length).toBe(MAX_BYTES_PER_FLUSH);

      // The rescheduled flush drains the remainder on the next tick.
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush.mock.calls[1][1].length).toBe(50_000);

      // No third flush once drained.
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('ships a sub-cap buffer in a single flush', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      manager.onData(SESSION, 'x'.repeat(MAX_BYTES_PER_FLUSH));
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0][1].length).toBe(MAX_BYTES_PER_FLUSH);
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('does not split a UTF-16 surrogate pair at the cap boundary', () => {
      vi.useFakeTimers();
      const { manager, onFlush } = createManager();

      // Fill exactly to the cap, then a surrogate pair straddling the boundary.
      const filler = 'a'.repeat(MAX_BYTES_PER_FLUSH - 1);
      manager.onData(SESSION, filler + '\u{1F600}'); // emoji = high+low surrogate
      vi.advanceTimersByTime(20);
      // The cap would land between the surrogate halves; the flush backs off one
      // so the first chunk ends before the pair.
      const firstChunk = onFlush.mock.calls[0][1] as string;
      expect(firstChunk.length).toBe(MAX_BYTES_PER_FLUSH - 1);
      const lastCode = firstChunk.charCodeAt(firstChunk.length - 1);
      expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);

      vi.advanceTimersByTime(20);
      const secondChunk = onFlush.mock.calls[1][1] as string;
      expect(secondChunk).toBe('\u{1F600}');

      vi.useRealTimers();
    });
  });

  describe('getScrollback with no pending buffer', () => {
    it('returns scrollback when buffer is already empty', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, 'data');
      // Let the flush fire normally
      vi.advanceTimersByTime(20);

      // Buffer is now empty, but scrollback still has the data
      const scrollback = manager.getScrollback(SESSION);
      expect(scrollback).toContain('data');

      vi.useRealTimers();
    });

    it('returns empty string for session with no data', () => {
      const { manager } = createManager();
      expect(manager.getScrollback(SESSION)).toBe('');
    });
  });

  describe('getScrollback read-time trim', () => {
    it('clips to MAX_SCROLLBACK when in-memory scrollback is above MAX_SCROLLBACK but below the write-path trim threshold', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // 640KB: above MAX_SCROLLBACK (512KB) but below SCROLLBACK_TRIM_THRESHOLD (768KB),
      // so onData's write-path trim does NOT fire - scrollback stays at 640KB in memory.
      // Use newline chars (0x0A): findSafeStartIndex returns 0 for them (not parameter,
      // intermediate, or final bytes in CSI terms), so the post-clip length is predictable.
      const MAX_SCROLLBACK = 512 * 1024;
      const DATA_SIZE = 640 * 1024;
      manager.onData(SESSION, '\n'.repeat(DATA_SIZE));

      // getScrollback applies the read-time clip so the renderer never receives the
      // oversized in-memory buffer.
      const scrollback = manager.getScrollback(SESSION);

      // '\x1b[0m' prefix adds 4 chars; findSafeStartIndex returns 0 for newlines,
      // so the clipped length is MAX_SCROLLBACK + 4. Allow 5 chars of headroom for
      // any minor alignment adjustments from findSafeStartIndex.
      expect(scrollback.length).toBeLessThanOrEqual(MAX_SCROLLBACK + 5);
      // Confirm the result is close to the cap (not near-zero - trim fired, not cleared).
      expect(scrollback.length).toBeGreaterThan(MAX_SCROLLBACK - 100);

      // Advance past the 16ms flush: getScrollback already drained the buffer, so
      // the timer fires and finds nothing to deliver.
      vi.advanceTimersByTime(20);

      vi.useRealTimers();
    });
  });

  describe('DEC private mode restoration (#313)', () => {
    // The mode prefix getScrollback() prepends ends at the \x1b[0m reset, which
    // buildDecPrivateModePrefix() never emits, so the first \x1b[0m is the
    // boundary between the re-asserted modes and the (raw) scrollback body.
    function modePrefixOf(scrollback: string): string {
      return scrollback.slice(0, scrollback.indexOf('\x1b[0m'));
    }

    it('re-asserts application cursor keys mode after the original set is trimmed out', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // DECCKM on, then enough plain output to push past the 768KB write-path
      // trim threshold so the original \x1b[?1h is sliced out of the body -
      // the empirically-confirmed root cause for a long-running session.
      const SCROLLBACK_TRIM_THRESHOLD = (512 + 256) * 1024;
      manager.onData(SESSION, '\x1b[?1h');
      manager.onData(SESSION, '\n'.repeat(SCROLLBACK_TRIM_THRESHOLD + 32 * 1024));

      const scrollback = manager.getScrollback(SESSION);
      const prefix = '\x1b[?1h\x1b[0m';
      // The mode is re-asserted up front...
      expect(scrollback.startsWith(prefix)).toBe(true);
      // ...and the trimmed body no longer carries it, so the prefix is load-bearing.
      expect(scrollback.slice(prefix.length).includes('\x1b[?1h')).toBe(false);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('drops a mode that was later reset (DECRST 1l)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1h');
      manager.onData(SESSION, 'some output');
      manager.onData(SESSION, '\x1b[?1l');

      // Set then reset -> no mode re-asserted in the prefix.
      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('restores a mode set split across two PTY chunks', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // \x1b[?2004h (bracketed paste) arriving as two chunks across a boundary.
      manager.onData(SESSION, '\x1b[?20');
      manager.onData(SESSION, '04h');

      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('\x1b[?2004h');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('does not re-assert display modes as INPUT modes (alt-screen 1049 is not in the input-mode prefix)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1049h');
      manager.onData(SESSION, 'tui frame');

      // 1049 is excluded from RESTORABLE_DEC_PRIVATE_MODES (the #313 input-mode
      // set), so it never appears merged into the coalesced input-mode DECSET.
      // It is re-asserted separately as alt-screen - see the "alt-screen
      // re-assert" block below.
      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('\x1b[?1049h');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('honors a full reset (RIS) by dropping tracked modes', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1h');
      manager.onData(SESSION, '\x1bc');

      // RIS resets every private mode -> no mode re-asserted in the prefix.
      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('adds no mode prefix when no input modes were set', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, 'plain output with no mode sequences');

      // No DEC private mode prefix: the result starts directly with the \x1b[0m reset.
      expect(manager.getScrollback(SESSION).startsWith('\x1b[0m')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('coalesces multiple modes set individually (in non-sorted order) into one sorted DECSET', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // Send three restorable modes in a deliberately non-ascending insertion order.
      manager.onData(SESSION, '\x1b[?2004h');
      manager.onData(SESSION, '\x1b[?1h');
      manager.onData(SESSION, '\x1b[?1000h');

      // buildDecPrivateModePrefix must sort numerically and emit ONE combined DECSET.
      // Would fail if modes came out in insertion order (\x1b[?2004;1;1000h) or as
      // three separate sequences (\x1b[?2004h\x1b[?1h\x1b[?1000h).
      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('\x1b[?1;1000;2004h');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('parses a single multi-param DECSET chunk into all modes and re-asserts them sorted', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // One combined DECSET with params in non-sorted order (1, 2004, 1000).
      manager.onData(SESSION, '\x1b[?1;2004;1000h');

      // updateModeState splits on ';' and registers each param; the prefix
      // must contain all three, sorted. Would fail if multi-param splitting was broken.
      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('\x1b[?1;1000;2004h');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('honors a soft reset (DECSTR \\x1b[!p) by dropping tracked modes', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1h');
      manager.onData(SESSION, '\x1b[!p');

      // DECSTR resets every private mode -> no mode re-asserted in the prefix.
      // Mirrors the RIS (\x1bc) test; independently red-greens the |\x1b\[!p
      // arm of the updateModeState regex.
      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('detects a DECSTR soft reset split across two PTY chunks (\\x1b[! | p)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1h');
      // DECSTR arriving in two pieces: first chunk ends with \x1b[! (partial),
      // second chunk is p. The carry regex /\x1b(?:\[[\d?;]*!?)?$/ must carry
      // the \x1b[! partial so the two pieces are stitched into \x1b[!p and the
      // soft reset fires. Without the !? in the carry regex, \x1b[! is not
      // carried, combined on chunk 2 is just 'p', no reset fires, and mode 1
      // persists - this test would assert '' but see '\x1b[?1h'.
      manager.onData(SESSION, '\x1b[!');
      manager.onData(SESSION, 'p');

      expect(modePrefixOf(manager.getScrollback(SESSION))).toBe('');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('does not duplicate carry bytes into the scrollback body', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // Bracketed paste mode (\x1b[?2004h) split across two chunks: \x1b[?20 then 04h.
      // onData carries \x1b[?20 and appends only the original `data` to scrollback,
      // so the body accumulates \x1b[?20 + 04h = \x1b[?2004h (clean).
      // If onData used `combined` instead of `data` for scrollback, the body would
      // become \x1b[?20 + \x1b[?2004h = '\x1b[?20\x1b[?2004h' (duplicated carry).
      manager.onData(SESSION, '\x1b[?20');
      manager.onData(SESSION, '04h');

      const scrollback = manager.getScrollback(SESSION);

      // Prefix is \x1b[?2004h, then \x1b[0m, then the body which must be clean.
      expect(scrollback).toContain('\x1b[0m\x1b[?2004h');
      // Carry prefix must NOT appear duplicated in the body.
      expect(scrollback).not.toContain('\x1b[?20\x1b[?2004h');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('filters out non-restorable params from a combined DECSET, tracking 1049 separately as alt-screen', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // One DECSET with restorable mouse-tracking modes 1000, 1002 and the
      // alt-screen mode 1049 mixed in between them. The per-param guard inside
      // updateModeState must keep 1049 OUT of the coalesced input-mode DECSET
      // (it tracks inAltScreen separately instead) while still tracking 1000/1002.
      manager.onData(SESSION, '\x1b[?1000;1049;1002h');

      const scrollback = manager.getScrollback(SESSION);
      // Alt-screen leads, then the coalesced (sorted, 1049-free) input-mode
      // DECSET, then the reset.
      expect(scrollback.startsWith('\x1b[?1049h\x1b[?1000;1002h\x1b[0m')).toBe(true);
      expect(modePrefixOf(scrollback)).toBe('\x1b[?1049h\x1b[?1000;1002h');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('re-asserts the same mode prefix on repeated getScrollback() calls (idempotent)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1h');
      manager.onData(SESSION, 'some output');

      // First call establishes the prefix.
      const firstPrefix = modePrefixOf(manager.getScrollback(SESSION));
      expect(firstPrefix).toBe('\x1b[?1h');

      // Second call must produce the same prefix. Would fail if getScrollback
      // mutated decPrivateModes after reading (e.g. cleared it as a "reset on
      // read" refactor), which would make the second call return an empty prefix.
      const secondPrefix = modePrefixOf(manager.getScrollback(SESSION));
      expect(secondPrefix).toBe('\x1b[?1h');

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });
  });

  describe('alt-screen re-assert and synchronized-output safety (fullscreen TUI freeze fix)', () => {
    it('re-asserts alt-screen (1049) when the session is currently in the alt buffer', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1049h');
      manager.onData(SESSION, '\x1b[2Jtui frame');

      const scrollback = manager.getScrollback(SESSION);
      // Alt-screen enter goes first (re-clearing/switching into the alt
      // buffer), then the (empty here) input-mode prefix, then the reset,
      // then the replayed frame.
      expect(scrollback.startsWith('\x1b[?1049h\x1b[0m')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('leaves a classic (normal-buffer) session byte-for-byte unchanged (#313 safety guard)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // Input modes only, no alt-screen - a classic-renderer session.
      manager.onData(SESSION, '\x1b[?1h\x1b[?2004h');
      manager.onData(SESSION, 'plain scrollback');

      const scrollback = manager.getScrollback(SESSION);
      expect(scrollback).not.toContain('\x1b[?1049h');
      expect(scrollback.startsWith('\x1b[?1;2004h\x1b[0m')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('drops the re-assert after leaving alt-screen (1049l)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1049h');
      manager.onData(SESSION, 'tui frame');
      manager.onData(SESSION, '\x1b[?1049l');
      manager.onData(SESSION, 'back in the shell');

      // The raw body still legitimately contains the original 1049h/1049l
      // bytes (recorded content); what must NOT happen is a re-assert PREFIX
      // in front of it, since the session is no longer in the alt buffer.
      expect(manager.getScrollback(SESSION).startsWith('\x1b[?1049h')).toBe(false);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('restores an alt-screen enter split across two PTY chunks', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?104');
      manager.onData(SESSION, '9h');

      expect(manager.getScrollback(SESSION).startsWith('\x1b[?1049h')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('a full reset (RIS) exits alt-screen', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1049h');
      manager.onData(SESSION, '\x1bc');

      // The raw body still legitimately contains the original 1049h bytes;
      // what must NOT happen is a re-assert prefix, since RIS returned the
      // session to the normal buffer.
      expect(manager.getScrollback(SESSION).startsWith('\x1b[?1049h')).toBe(false);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('a soft reset (DECSTR) does not exit alt-screen (DECSTR does not switch buffers per spec)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1049h');
      manager.onData(SESSION, '\x1b[!p');

      expect(manager.getScrollback(SESSION).startsWith('\x1b[?1049h')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('orders alt-screen before the input-mode prefix, and the replay frame after the reset', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[?1049h\x1b[?1h');
      manager.onData(SESSION, '\x1b[2Jthe frame');

      const scrollback = manager.getScrollback(SESSION);
      expect(scrollback.startsWith('\x1b[?1049h\x1b[?1h\x1b[0m')).toBe(true);
      expect(scrollback.indexOf('\x1b[2J')).toBeGreaterThan(scrollback.indexOf('\x1b[0m'));

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('closes a synchronized-output frame left dangling by the sample (2026h with no matching 2026l)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[2Jframe');
      manager.onData(SESSION, '\x1b[?2026hpartial diff, no closing 2026l');

      expect(manager.getScrollback(SESSION).endsWith('\x1b[?2026l')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('does not append a spurious 2026l when the synchronized-output frame is already balanced', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      manager.onData(SESSION, '\x1b[2Jframe');
      manager.onData(SESSION, '\x1b[?2026hdiff\x1b[?2026l');

      // The raw body already ends with a balanced 2026l; getScrollback must
      // not append a second one on top of it.
      const scrollback = manager.getScrollback(SESSION);
      const occurrences = scrollback.split('\x1b[?2026l').length - 1;
      expect(occurrences).toBe(1);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('tracks alt-screen via the older 47 and 1047 variants, not just 1049', () => {
      vi.useFakeTimers();

      // 47 (oldest variant, no cursor save) must flip inAltScreen the same
      // way 1049 does. Would fail if ALT_SCREEN_MODES were narrowed to {1049}.
      const managerFor47 = createManager().manager;
      managerFor47.onData(SESSION, '\x1b[?47h');
      managerFor47.onData(SESSION, '\x1b[2Jtui frame');
      expect(managerFor47.getScrollback(SESSION).startsWith('\x1b[?1049h')).toBe(true);

      // 1047 (intermediate variant) must do the same.
      const managerFor1047 = createManager().manager;
      managerFor1047.onData(SESSION, '\x1b[?1047h');
      managerFor1047.onData(SESSION, '\x1b[2Jtui frame');
      expect(managerFor1047.getScrollback(SESSION).startsWith('\x1b[?1049h')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('routes a single combined DECSET spanning all three trackers (input-mode + alt-screen + synchronized-output)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // One DECSET carrying a restorable input mode (1000), the alt-screen
      // mode (1049), and synchronized-output (2026) together. Each param must
      // route independently to its own tracker.
      manager.onData(SESSION, '\x1b[?1000;1049;2026h');
      manager.onData(SESSION, '\x1b[2Jframe');

      const scrollback = manager.getScrollback(SESSION);
      // Alt-screen prefix leads (inAltScreen tracked separately from 1000).
      expect(scrollback.startsWith('\x1b[?1049h')).toBe(true);
      // 1000 lands in the coalesced input-mode DECSET, not the alt-screen or
      // synchronized-output trackers.
      const modePrefix = scrollback.slice(0, scrollback.indexOf('\x1b[0m'));
      expect(modePrefix).toBe('\x1b[?1049h\x1b[?1000h');
      // 2026 stayed open (never closed in this stream), so getScrollback
      // closes the dangling frame at the very end.
      expect(scrollback.endsWith('\x1b[?2026l')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('closes a synchronized-output frame whose 2026h open is split across two PTY chunks', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // \x1b[?2026h split at the chunk boundary: '\x1b[?202' then '6h...'.
      // modeParseCarry must stitch the two pieces so the open is not missed.
      manager.onData(SESSION, '\x1b[?202');
      manager.onData(SESSION, '6hframe');

      expect(manager.getScrollback(SESSION).endsWith('\x1b[?2026l')).toBe(true);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('a full reset (RIS) clears a dangling synchronized-output frame (no spurious 2026l after the reset)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // 2026h opens with no matching 2026l, then RIS resets everything. RIS
      // itself wipes terminal state, so getScrollback must not append a
      // trailing 2026l on top of it - state.synchronizedOpen has to be
      // cleared by the reset arm of updateModeState, same as decPrivateModes.
      manager.onData(SESSION, '\x1b[?2026hpartial diff, no closing 2026l');
      manager.onData(SESSION, '\x1bc');

      expect(manager.getScrollback(SESSION).endsWith('\x1b[?2026l')).toBe(false);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });

    it('a soft reset (DECSTR) clears a dangling synchronized-output frame (no spurious 2026l after the reset)', () => {
      vi.useFakeTimers();
      const { manager } = createManager();

      // Mirrors the RIS case above for the DECSTR reset arm: DECSTR does not
      // switch buffers, but it still returns private modes to default, which
      // must include closing a dangling synchronized-output frame.
      manager.onData(SESSION, '\x1b[?2026hpartial diff, no closing 2026l');
      manager.onData(SESSION, '\x1b[!p');

      expect(manager.getScrollback(SESSION).endsWith('\x1b[?2026l')).toBe(false);

      vi.advanceTimersByTime(20);
      vi.useRealTimers();
    });
  });
});
