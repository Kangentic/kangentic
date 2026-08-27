import { describe, it, expect, vi, afterEach } from 'vitest';
import { Terminal } from '@xterm/headless';
import { PtyBufferManager } from '../../src/main/pty/buffer/pty-buffer-manager';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';

/**
 * Cold-replay a snapshot payload into a fresh parser, exactly as the renderer
 * does (a freshly constructed xterm, then write) - including the renderer's
 * Unicode 11 width table, so assertions exercise the real replay pair. Awaits
 * xterm's own write callback so the parse has landed before the assertions
 * read the buffer. (Duplicated from headless-frame.test.ts: test files here
 * never import from sibling test files.)
 */
async function replayIntoFreshTerminal(payload: string, cols = 80, rows = 24): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  activateUnicode11(terminal);
  await new Promise<void>((resolve) => {
    terminal.write(payload, () => resolve());
  });
  return terminal;
}

describe('PtyBufferManager', () => {
  const SESSION = 'test-session';

  function createManager() {
    const onFlush = vi.fn();
    const onDrain = vi.fn();
    const manager = new PtyBufferManager({ onFlush, onDrain });
    manager.initSession(SESSION, '', 80);
    // Simulate the initial resize that establishes real terminal dimensions.
    // This mirrors what the renderer does on first connection (fit + resize).
    manager.onResize(SESSION, 80);
    return { manager, onFlush, onDrain };
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

      // Same-geometry resize (cols and rows both unchanged)
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
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
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
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      // Pre-spawn-resize shape: the PTY was spawned AT the fitted width, so the
      // renderer's follow-up resize is a no-op and must not arm a needless wait.
      manager.initSession(SESSION, 'previous session output', 190);

      const colsChanged = manager.onResize(SESSION, 190);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
    });

    it('preserves scrollback across a later width change', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, 'previous session output', 120);
      manager.onResize(SESSION, 190);
      manager.onData(SESSION, 'live data');

      const colsChanged = manager.onResize(SESSION, 200);
      expect(colsChanged).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
      expect(manager.getScrollback(SESSION)).toContain('live data');
    });

    it('reports colsChanged=false on a genuine rows-only resize (return is reporting, arming is separate)', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, 'previous session output', 120, 30);
      manager.onResize(SESSION, 120, 30);
      manager.onData(SESSION, ' plus new data');

      // A rows-only change arms the repaint settle but the RETURN VALUE stays
      // colsChanged: it crosses the IPC boundary and the mobile wire, where
      // nothing consumes a rows flag.
      const colsChanged = manager.onResize(SESSION, 120, 50);
      expect(colsChanged).toBe(false);
      expect(manager.getDimensionState(SESSION)?.pendingRepaintAt).not.toBeNull();
      expect(manager.getScrollback(SESSION)).toContain('previous session output');
      expect(manager.getScrollback(SESSION)).toContain('plus new data');
    });

    it('tracks lastRows through init and resize (dev diagnostics)', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120, 24);
      expect(manager.getDimensionState(SESSION)?.lastRows).toBe(24);

      manager.onResize(SESSION, 120, 40);
      expect(manager.getDimensionState(SESSION)?.lastRows).toBe(40);
    });

    it('fresh session seeded at spawn width reports no change on a matching resize', () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120);

      const colsChanged = manager.onResize(SESSION, 120);
      expect(colsChanged).toBe(false);
      expect(manager.getScrollback(SESSION)).toBe('');
    });
  });

  describe('waitForResizeRepaint (repaint-settle before sampling)', () => {
    // Build the precondition the settle keys on: a full-screen TUI frame (with a
    // \x1b[2J clear) in the buffer, then a geometry change that stamps the
    // pending repaint. Rows are passed explicitly on every call (the defaulted
    // rows param would otherwise read as a spurious row change - see the
    // onResize doc). Returns the manager so each test drives the settle.
    function armWidthChange(tui = true): PtyBufferManager {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120, 30);
      manager.onData(SESSION, tui ? '\x1b[2Jold frame at 120 cols' : 'plain shell output');
      // The old frame must be measurably OLDER than the resize: the settle's
      // `>=` stamp comparison deliberately counts same-millisecond bytes as
      // post-resize, and under fake timers everything above lands in one
      // frozen millisecond. Every test in this block runs fake timers before
      // calling this helper.
      vi.advanceTimersByTime(10);
      expect(manager.onResize(SESSION, 190, 30)).toBe(true);
      return manager;
    }

    // Same shape armed by a ROWS-ONLY change: cols stay 120, rows 30 -> 50.
    // onResize returns false (the report stays colsChanged) while arming.
    function armRowsChange(tui = true): PtyBufferManager {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120, 30);
      manager.onData(SESSION, tui ? '\x1b[2Jold frame at 30 rows' : 'plain shell output');
      // Same clock separation as armWidthChange, same reason.
      vi.advanceTimersByTime(10);
      expect(manager.onResize(SESSION, 120, 50)).toBe(false);
      return manager;
    }

    it('does NOT settle on a marker-less update plus a lull (it is not a repaint)', async () => {
      // REVERSED expectation, deliberately. This used to assert that any bytes
      // after the resize plus a 50ms lull counted as "the repaint landed", and
      // that heuristic is the open-a-task-detail flicker: a fullscreen TUI emits
      // ordinary partial updates (a spinner tick, one redrawn line) and then goes
      // quiet, which is indistinguishable from a redraw under that rule. The
      // sample was therefore taken BEFORE the real repaint, so the first thing
      // painted was the pre-resize frame - drawn wide, wrapped into the narrower
      // window - and the held live bytes then replaced it. See
      // tests/unit/repaint-settle-marker.test.ts for the harness that isolates it.
      //
      // For a session this wait has already identified as a fullscreen TUI, only a
      // full-screen ERASE means the frame was redrawn. Inside the marker-arrival
      // window nothing else may settle it; past MARKERLESS_REPAINT_MIN_WAIT_MS a
      // markerless quiesce may (the idle default renderer repaints without an
      // erase - see repaint-settle-marker.test.ts), and true silence rides the
      // deadline. This test's assertions all sit inside the marker window.
      vi.useFakeTimers();
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // A partial update with no erase, then silence well past the old 50ms
      // quiesce window. Previously this settled; now it must not.
      manager.onData(SESSION, 'partial update, no erase');
      await vi.advanceTimersByTimeAsync(96);
      expect(settled).toBe(false);

      // The genuine repaint erases the screen, and that settles it.
      manager.onData(SESSION, '\x1b[2Jrepaint at 190 cols');
      await vi.advanceTimersByTimeAsync(16);
      await waitPromise;
      expect(settled).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('repaint at 190 cols');

      vi.useRealTimers();
    });

    it('settles early when a streaming session lands a post-resize full-frame marker (never quiesces)', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // Marker-free streaming: bytes keep arriving so the quiesce heuristic
      // can never fire.
      manager.onData(SESSION, 'streaming output without a marker');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);
      manager.onData(SESSION, 'more streaming output');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The SIGWINCH repaint lands mid-stream WITH the full-frame marker: the
      // wait settles on the next poll, ~48ms in - far before the 50ms quiesce
      // could ever be satisfied (data never stops) and far before the 400ms
      // deadline it used to burn.
      manager.onData(SESSION, '\x1b[2Jrepaint at 190 cols');
      await vi.advanceTimersByTimeAsync(16);
      await waitPromise;
      expect(settled).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('repaint at 190 cols');

      vi.useRealTimers();
    });

    it('does NOT settle on a BARE cursor-home (\\x1b[H is a partial update, not a repaint)', async () => {
      // REVERSED expectation, deliberately - this test previously asserted the
      // behavior that caused the flicker. A bare \x1b[H was accepted as proof of a
      // full-frame repaint, but a fullscreen TUI emits cursor-home constantly for
      // partial updates: measured on a live Claude session, 169 cursor-homes to 56
      // full-screen clears in one 512KB ring. So the FIRST routine byte after the
      // resize satisfied the settle, getScrollback sampled the pre-resize frame,
      // and the user saw that stale wide frame before the held live bytes replaced
      // it with the real repaint.
      //
      // The accelerator survives for the marker that actually means it (\x1b[2J,
      // covered above); only this false positive is removed.
      vi.useFakeTimers();
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      manager.onData(SESSION, 'streaming output without a marker');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // A bare cursor-home mid-stream. Previously this settled the wait here.
      manager.onData(SESSION, '\x1b[Hpartial update at the old width');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The genuine repaint erases first, and only that settles it.
      manager.onData(SESSION, '\x1b[2Jrepaint at 190 cols');
      await vi.advanceTimersByTimeAsync(16);
      await waitPromise;
      expect(settled).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('repaint at 190 cols');

      vi.useRealTimers();
    });

    it('does not early-settle on a parameterized cursor-home (\\x1b[1;1H is not the bare \\x1b[H marker)', async () => {
      vi.useFakeTimers();
      // armWidthChange already put the entry-gate \x1b[2J in the buffer
      // BEFORE the resize; the post-resize bytes below intentionally carry
      // no \x1b[2J so only the \x1b[H arm is under test.
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // Streaming every 32ms with a PARAMETERIZED cursor-home (\x1b[1;1H) in
      // every chunk: quiesce never fires, and a parameterized home must not
      // satisfy the bare \x1b[H marker check (indexOf('\x1b[H', ...) cannot
      // substring-match \x1b[1;1H - a broader regex-style matcher would
      // false-positive here and settle early).
      for (let feedIndex = 0; feedIndex < 12; feedIndex += 1) {
        manager.onData(SESSION, '\x1b[1;1Hparameterized home, not a full-frame marker');
        await vi.advanceTimersByTimeAsync(32);
        expect(settled).toBe(false);
      }

      // Only the 400ms deadline resolves it - the parameterized home never
      // triggers the early settle.
      await vi.advanceTimersByTimeAsync(32);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('defers the early settle while a synchronized-output frame is open, settling once it closes', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // The repaint marker arrives INSIDE an open DEC 2026 frame: sampling now
      // would tear the frame, so the early settle must hold off.
      manager.onData(SESSION, '\x1b[?2026h\x1b[2Jrepaint at 190 cols');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // Streaming continues (quiesce can never fire) with the frame still open.
      manager.onData(SESSION, 'more diff bytes inside the frame');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The frame closes: the very next poll settles on the frame boundary.
      manager.onData(SESSION, '\x1b[?2026l');
      await vi.advanceTimersByTimeAsync(16);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('ignores a marker that predates the resize: marker-free streaming runs to the deadline', async () => {
      vi.useFakeTimers();
      // armWidthChange put a \x1b[2J in the buffer BEFORE the resize; only
      // bytes appended AFTER the resize may satisfy the early settle.
      const manager = armWidthChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // Marker-free streaming every 32ms: quiesce never fires, and the
      // pre-resize marker must not early-settle the wait (an offset bug -
      // scanning from index 0 - would settle on the very first poll).
      for (let feedIndex = 0; feedIndex < 12; feedIndex += 1) {
        manager.onData(SESSION, 'marker-free diff bytes');
        await vi.advanceTimersByTimeAsync(32);
        expect(settled).toBe(false);
      }

      // Only the 400ms deadline resolves it.
      await vi.advanceTimersByTimeAsync(32);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('survives a mid-wait scrollback trim: the scan offset shifts with the trimmed prefix', async () => {
      vi.useFakeTimers();
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120);
      // A large pre-resize TUI buffer, just below the 768KB write-path trim
      // threshold, so the resize stamps a large scan offset (~717KB).
      manager.onData(SESSION, '\x1b[2J' + 'x'.repeat(700 * 1024));
      expect(manager.onResize(SESSION, 190)).toBe(true);

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // A flood pushes the buffer past the trim threshold mid-wait: onData
      // slices the scrollback down to 512KB, so every retained character
      // shifts left. Without the offset adjustment the stamped offset (~717KB)
      // would now point PAST where new bytes land (~512KB) and the marker
      // below would be invisible to the scan.
      manager.onData(SESSION, 'y'.repeat(100 * 1024));
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The repaint marker lands after the trim and must still be detected
      // (early settle well before quiesce or the deadline).
      manager.onData(SESSION, '\x1b[2Jrepaint after trim');
      await vi.advanceTimersByTimeAsync(16);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('a stacked resize (second width change before the first repaint is consumed) requires marker AND quiesce', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange(); // 120 -> 190 stamps the first pending repaint
      // Rapid ping-pong (close/reopen): a second width change lands before any
      // repaint for the first one arrived.
      expect(manager.onResize(SESSION, 260)).toBe(true);

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // The PREVIOUS width's repaint arrives late (a post-resize marker):
      // marker alone must NOT settle a stacked wait - sampling here would
      // replay the 190-col frame into the 260-col terminal.
      manager.onData(SESSION, '\x1b[2Jrepaint at 190 cols (stale width)');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The correct-width repaint lands too; data has not quiesced yet.
      manager.onData(SESSION, '\x1b[2Jrepaint at 260 cols');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // Data goes quiet: marker AND quiesce now hold -> settles before the
      // deadline, with BOTH repaints in the sample (tail = correct width).
      await vi.advanceTimersByTimeAsync(80);
      await waitPromise;
      expect(settled).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('repaint at 260 cols');

      vi.useRealTimers();
    });

    it('a stacked resize with continuous streaming falls back to the deadline (no marker-only early settle)', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange();
      expect(manager.onResize(SESSION, 260)).toBe(true);

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // Marker-bearing frames keep arriving every 32ms (never quiet): a
      // stacked wait must not settle on them - it runs to the 400ms ceiling,
      // by which point the final-width repaint is in the sample.
      for (let feedIndex = 0; feedIndex < 12; feedIndex += 1) {
        manager.onData(SESSION, '\x1b[2Jrepaint frame while streaming continues');
        await vi.advanceTimersByTimeAsync(32);
        expect(settled).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(32);
      await waitPromise;
      expect(settled).toBe(true);

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

    it('settles a no-marker session within the short grace, far below the TUI ceiling', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange(false);

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // Not instant anymore: a fullscreen TUI that has not drawn its FIRST
      // frame yet also has no marker, so the wait gives in-flight bytes a
      // short window instead of sampling a near-empty ring.
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // A silent session (a shell answering SIGWINCH with nothing) settles at
      // the grace - never the TUI's 400ms ceiling.
      await vi.advanceTimersByTimeAsync(64);
      await waitPromise;
      expect(settled).toBe(true);

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

    it('does not arm a wait when the geometry did not change', async () => {
      vi.useFakeTimers();
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120, 30);
      manager.onData(SESSION, '\x1b[2Jframe at 120x30');
      // Same cols AND rows: nothing changed, no pending repaint stamped.
      expect(manager.onResize(SESSION, 120, 30)).toBe(false);

      // No pending repaint -> short-circuits with no timers.
      await manager.waitForResizeRepaint(SESSION);

      vi.useRealTimers();
    });

    it('a rows-only resize arms the settle: the old-row-count frame is not sampled early', async () => {
      // The bug this pins (measured live 2026-07-31, 12/12 trials): a rows-only
      // resize left the settle unarmed, so getScrollback sampled ~1ms after the
      // resize and replayed the frame laid out for the OLD row count. The
      // repaint always arrived 21-122ms later carrying a full \x1b[2J erase, so
      // arming lets the marker settle the wait early.
      vi.useFakeTimers();
      const manager = armRowsChange();

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // Unarmed, this would have resolved immediately; armed, it waits.
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The rows repaint lands with the erase marker: early settle.
      manager.onData(SESSION, '\x1b[2Jrepaint at 50 rows');
      await vi.advanceTimersByTimeAsync(16);
      await waitPromise;
      expect(settled).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('repaint at 50 rows');

      vi.useRealTimers();
    });

    it('a rows-only arm on a plain-shell session settles at the short grace (no TUI marker)', async () => {
      vi.useFakeTimers();
      const manager = armRowsChange(false);

      // Discriminating precondition: the rows-only change actually armed the
      // settle. Without this, a reverted arming path would pass this test
      // vacuously (nothing to clear means "resolves quickly" either way).
      expect(manager.getDimensionState(SESSION)?.pendingRepaintAt).not.toBeNull();

      // No \x1b[2J anywhere in the scrollback and nothing arriving: the
      // no-marker wait settles at its short grace and clears the arm.
      const waitPromise = manager.waitForResizeRepaint(SESSION);
      await vi.advanceTimersByTimeAsync(80);
      await waitPromise;

      // The no-tui-marker path must have cleared the arm.
      expect(manager.getDimensionState(SESSION)?.pendingRepaintAt).toBeNull();

      vi.useRealTimers();
    });

    it('a rows-only arm with no post-resize marker rides the max-wait ceiling, not an early sample', async () => {
      // Mirrors "resolves at the max-wait ceiling when no repaint ever
      // arrives" (armWidthChange), but for a ROWS-ONLY arm: proves the
      // deadline path is reachable from a rows change too, not just the
      // early-settle-on-marker path already covered above.
      vi.useFakeTimers();
      const manager = armRowsChange(); // TUI session, rows-only 30 -> 50

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // No marker ever follows the resize. Just short of the 400ms ceiling:
      // still unsettled.
      await vi.advanceTimersByTimeAsync(399);
      expect(settled).toBe(false);

      // The ceiling (400ms from entry) is reached: resolves without a repaint.
      await vi.advanceTimersByTimeAsync(1);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('a rows change stacked on a pending cols repaint requires marker AND quiesce', async () => {
      vi.useFakeTimers();
      const manager = armWidthChange(); // 120x30 -> 190x30 stamps the first pending repaint
      // A rows-only change lands before the width repaint arrived: two
      // repaints are now (or may be) in flight, so the wait is stacked.
      expect(manager.onResize(SESSION, 190, 50)).toBe(false);

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      // The FIRST geometry's repaint arrives late: marker alone must not
      // settle a stacked wait.
      manager.onData(SESSION, '\x1b[2Jrepaint at 190x30 (stale rows)');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      // The correct-geometry repaint lands and data quiesces: settles.
      manager.onData(SESSION, '\x1b[2Jrepaint at 190x50');
      await vi.advanceTimersByTimeAsync(96);
      await waitPromise;
      expect(settled).toBe(true);
      expect(manager.getScrollback(SESSION)).toContain('repaint at 190x50');

      vi.useRealTimers();
    });

    it('a cols change stacked on a pending rows repaint requires marker AND quiesce', async () => {
      vi.useFakeTimers();
      const manager = armRowsChange(); // 120x30 -> 120x50 stamps the first pending repaint
      expect(manager.onResize(SESSION, 190, 50)).toBe(true);

      let settled = false;
      const waitPromise = manager.waitForResizeRepaint(SESSION).then(() => {
        settled = true;
      });

      manager.onData(SESSION, '\x1b[2Jrepaint at 120x50 (stale cols)');
      await vi.advanceTimersByTimeAsync(16);
      expect(settled).toBe(false);

      manager.onData(SESSION, '\x1b[2Jrepaint at 190x50');
      await vi.advanceTimersByTimeAsync(96);
      await waitPromise;
      expect(settled).toBe(true);

      vi.useRealTimers();
    });

    it('an omitted rows argument after a real-rows resize reads as a row change (test-only trap)', () => {
      // rows defaults to DEFAULT_HEADLESS_ROWS (30). Production always passes
      // real rows (SessionManager.resize), so this path is reachable only from
      // tests - pinned here so the behavior is documented rather than
      // rediscovered: an omitted rows after rows=50 reads 50 -> 30 and arms.
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120, 30);
      manager.onData(SESSION, '\x1b[2Jframe');
      expect(manager.onResize(SESSION, 120, 50)).toBe(false);
      expect(manager.getDimensionState(SESSION)?.pendingRepaintAt).not.toBeNull();

      // Omitting rows now reads as 50 -> 30: it re-arms, stacked on the first.
      expect(manager.onResize(SESSION, 120)).toBe(false);
      expect(manager.getDimensionState(SESSION)?.pendingRepaintStacked).toBe(true);
      expect(manager.getDimensionState(SESSION)?.lastRows).toBe(30);
    });

    it('an unconsumed arm older than REPAINT_MAX_WAIT_MS does not stack the next resize', () => {
      // Age-gates the stacked flag: an arm nothing ever sampled (a bottom-panel
      // height drag with no replay after it) must not slow the NEXT unrelated
      // resize down to marker-and-quiesce. The sibling "fresh arm still
      // stacks" case is pinned above (immediate re-resize -> stacked true);
      // this test is the complementary stale case.
      vi.useFakeTimers();
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120, 30);
      manager.onData(SESSION, '\x1b[2Jframe');

      // First geometry change stamps pendingRepaintAt. Nothing ever consumes
      // it (no waitForResizeRepaint call).
      expect(manager.onResize(SESSION, 120, 50)).toBe(false);
      expect(manager.getDimensionState(SESSION)?.pendingRepaintAt).not.toBeNull();

      // Advance well past REPAINT_MAX_WAIT_MS (400ms) with the arm still
      // unconsumed: its repaint has landed or never will by now.
      vi.advanceTimersByTime(500);

      // A second, unrelated geometry change lands. The stale arm must NOT
      // mark it stacked.
      expect(manager.onResize(SESSION, 190, 50)).toBe(true);
      expect(manager.getDimensionState(SESSION)?.pendingRepaintStacked).toBe(false);

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

  describe('initSession geometry-gate carry-over', () => {
    it('marks a carried ring geometry-suspect when the prior drawn-at geometry is unknown', () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, 'carried', 80, 24);
      // Without evidence the carried bytes match the spawn geometry, the whole
      // carried ring is suspect: gate at its end so the replay takes the
      // parsed grid until the carried bytes trim out.
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBe('carried'.length);
      manager.removeSession(SESSION);
    });

    it('carries the prior gate through a same-geometry respawn (the common resume)', () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, 'carried', 80, 24, { cols: 80, rows: 24, geometryChangedAtRingIndex: null });
      // Prior geometry known and unchanged, prior ring single-geometry: the
      // full raw history stays replayable across the respawn.
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBeNull();
      manager.removeSession(SESSION);

      manager.initSession(SESSION, 'carried', 80, 24, { cols: 80, rows: 24, geometryChangedAtRingIndex: 3 });
      // A carried ring can internally span geometries even when the respawn
      // keeps the last one: the old gate rides along index-for-index (the
      // carried string IS the old ring).
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBe(3);
      manager.removeSession(SESSION);
    });

    it('marks the carried ring suspect when the respawn geometry differs from the prior one', () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, 'carried', 80, 24, { cols: 210, rows: 48, geometryChangedAtRingIndex: null });
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBe('carried'.length);
      manager.removeSession(SESSION);
    });

    it('a fresh spawn with no carried scrollback starts ungated', () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24, { cols: 210, rows: 48, geometryChangedAtRingIndex: 5 });
      // No carried bytes means nothing was drawn at any prior geometry,
      // whatever the previous session's state said.
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBeNull();
      manager.removeSession(SESSION);
    });
  });

  describe('getSerializedFrame (parsed-grid mobile seed)', () => {
    // Real timers: the headless parser drains its write buffer on a macrotask,
    // and getSerializedFrame awaits that flush before serializing.
    it('reconstructs a fullscreen-TUI static cell that the raw 512KB byte-window replay drops', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // A fullscreen TUI: enter the alt screen, clear, then draw a WRITE-ONCE
      // static left status segment at the top-left. In the alt buffer this cell
      // is positioned absolutely and is never rewritten (mirrors Claude Code's
      // "[icon] auto mode on" segment).
      const STATIC_SEGMENT = 'auto mode on';
      manager.onData(SESSION, `\x1b[?1049h\x1b[2J\x1b[1;1H${STATIC_SEGMENT}`);

      // Flood the dynamic bottom segment with well over 512KB of updates that
      // reposition to row 24 and never touch the static cell, so the bytes that
      // originally drew STATIC_SEGMENT age out of the raw 512KB byte window.
      const MAX_SCROLLBACK = 512 * 1024;
      const dynamicUnit = '\x1b[24;1H' + 'x'.repeat(20); // stays on row 24, 20 cols < 80: no wrap, no scroll
      const dynamicChunk = dynamicUnit.repeat(80); // ~2.1KB per onData
      let floodedBytes = 0;
      while (floodedBytes < MAX_SCROLLBACK + 400 * 1024) {
        manager.onData(SESSION, dynamicChunk);
        floodedBytes += dynamicChunk.length;
      }

      // The raw byte-window replay has lost the static segment: its drawing
      // bytes were trimmed off the front of the 512KB ring.
      const rawReplay = manager.getScrollback(SESSION);
      expect(rawReplay).not.toContain(STATIC_SEGMENT);

      // The parsed-grid serialized frame still carries every visible cell,
      // static segment included - this is the fix.
      const serializedFrame = await manager.getSerializedFrame(SESSION);
      expect(serializedFrame).toContain(STATIC_SEGMENT);
      // And it lands the phone in the alt screen (the serialize addon emits the
      // 1049h switch when the session is in the alt buffer), so the frame
      // renders in the right screen.
      expect(serializedFrame).toContain('\x1b[?1049h');

      manager.removeSession(SESSION);
    });

    it('returns empty string for an unknown session', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      expect(await manager.getSerializedFrame('nonexistent')).toBe('');
    });
  });

  describe('getReplaySnapshot (desktop replay payload)', () => {
    // Real timers, like the getSerializedFrame block above: the frame branch
    // awaits the headless parser's macrotask flush barrier.
    it('serves a parsed-grid frame that keeps static cells a capped byte replay drops', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // Same fixture as the getSerializedFrame regression above: a write-once
      // static cell, then a >512KB dynamic flood that never redraws it.
      const STATIC_SEGMENT = 'auto mode on';
      manager.onData(SESSION, `\x1b[?1049h\x1b[2J\x1b[1;1H${STATIC_SEGMENT}`);
      const MAX_SCROLLBACK = 512 * 1024;
      const dynamicUnit = '\x1b[24;1H' + 'x'.repeat(20); // stays on row 24, 20 cols < 80: no wrap, no scroll
      const dynamicChunk = dynamicUnit.repeat(80);
      let floodedBytes = 0;
      while (floodedBytes < MAX_SCROLLBACK + 400 * 1024) {
        manager.onData(SESSION, dynamicChunk);
        floodedBytes += dynamicChunk.length;
      }

      // Precondition: the ring is genuinely truncated past the write-once
      // region, so the raw byte replay has lost the static cell.
      expect(manager.getScrollback(SESSION)).not.toContain(STATIC_SEGMENT);

      // The replay payload the desktop mount receives reconstructs it.
      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toContain(STATIC_SEGMENT);
      // The frame carries its own alt-screen switch, and exactly one: the
      // snapshot path must not prepend the byte path's hand-built preamble on
      // top of the one the serialize addon emits.
      expect(snapshot.split('\x1b[?1049h').length - 1).toBe(1);
      // And the switch precedes the alt-grid content: the addon serializes the
      // normal buffer first, then switches, so a frame emitting alt rows ahead
      // of the switch would paint them into the wrong buffer.
      expect(snapshot.indexOf('\x1b[?1049h')).toBeLessThan(snapshot.indexOf(STATIC_SEGMENT));

      manager.removeSession(SESSION);
    });

    it('re-asserts mouse-encoding modes the serialize addon cannot emit', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      // A fullscreen TUI with wheel-scroll support: mouse tracking (1000) in
      // SGR encoding (1006), like Claude Code. The serialize addon re-asserts
      // TRACKING from terminal.modes (?1000h) but has no API for the ENCODING
      // modes (1005/1006/1015/1016), so a bare frame leaves xterm reporting
      // legacy X10 bytes that an SGR-expecting TUI ignores: wheel scroll went
      // dead after every same-grid remount until the TUI happened to re-assert
      // its own modes in the live stream.
      manager.onData(SESSION, '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[1;1HTUI frame');

      const snapshot = await manager.getReplaySnapshot(SESSION);
      // The folded DEC prefix (buildDecPrivateModePrefix) re-asserts every
      // tracked input/reporting mode after the frame; 1006 must be a member
      // (terminated by ';' or the trailing 'h', never a substring of a longer
      // parameter).
      expect(snapshot).toMatch(/\x1b\[\?(?:[0-9]+;)*1006[;h]/);

      manager.removeSession(SESSION);
    });

    it('the geometry-gated (non-alt) frame also folds the DEC private mode prefix, not just the alt route', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      // Mouse-encoding mode (1006, SGR) plus printable content, never
      // entering the alt screen - only the effective resize below arms the
      // frame route.
      manager.onData(SESSION, '\x1b[?1006hnormal-buffer TUI output');
      manager.onResize(SESSION, 120, 30);
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).not.toBeNull();

      const snapshot = await manager.getReplaySnapshot(SESSION);
      // The addon's serialize cannot emit the mouse ENCODING modes; the
      // folded DEC prefix must re-assert 1006 on the geometry-gated route
      // too, not only the alt-screen route.
      expect(snapshot).toMatch(/\x1b\[\?(?:[0-9]+;)*1006[;h]/);

      manager.removeSession(SESSION);
    });

    it('passes a non-alt-screen session with no effective geometry change through to the raw byte replay', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, 'plain shell output\r\nsecond line');

      const snapshot = await manager.getReplaySnapshot(SESSION);
      // The raw route is gated on geometryChangedAtRingIndex === null: this
      // fixture never resizes after content, so the full byte history is
      // preserved (not the parsed grid's 500-row window) - the property this
      // test pins. Byte-for-byte the getScrollback value (stable across reads
      // with no new data), preamble and all.
      expect(snapshot).toBe(manager.getScrollback(SESSION));
      expect(snapshot).toContain('plain shell output');

      manager.removeSession(SESSION);
    });

    it('rows-only geometry changes arm the gate too, not just width changes', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, 'drawn at 24 rows');

      // Same cols, different rows: onResize RETURNS false (its report is
      // cols-only by contract) but must still arm the gate - the reported
      // corruption included 48-vs-15-row mismatches.
      expect(manager.onResize(SESSION, 80, 48)).toBe(false);
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBe('drawn at 24 rows'.length);

      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).not.toBe(manager.getScrollback(SESSION));
      expect(snapshot).toContain('drawn at 24 rows');

      manager.removeSession(SESSION);
    });

    it('a second effective resize OVERWRITES the gate to the later ring index, not the first', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, 'A'.repeat(10));
      manager.onResize(SESSION, 120, 30);
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBe(10);

      // A LATER effective geometry change must overwrite the gate to the
      // NEW ring index, not preserve the first one - the trim-shift
      // self-heal in onData only clears the gate once the trim passes the
      // MOST RECENT change, so a preserved-at-first gate would self-heal too
      // early and route a still-suspect ring back to the raw byte replay.
      manager.onData(SESSION, 'B'.repeat(5));
      manager.onResize(SESSION, 200, 40);
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBe(15);

      manager.removeSession(SESSION);
    });

    it('the geometry-gated frame strips pre-TUI shell noise like the byte replay does', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // The shell echoes the spawn command before the agent TUI takes over -
      // the exact noise getScrollback's tuiStartIndex strip hides on the byte
      // route. The frame route must not resurrect it. The echo must be IN the
      // parser's scrollback when the first clear lands (a bare \x1b[2J erases
      // viewport cells in place), so scroll it off with banner-like output
      // first - the real repro's shape.
      manager.onData(SESSION, 'PS C:\\Users\\dev> node agent.js --permission-mode acceptEdits\r\n');
      let bannerLines = '';
      for (let line = 1; line <= 40; line += 1) {
        bannerLines += `banner and task text line ${line}\r\n`;
      }
      manager.onData(SESSION, bannerLines);
      manager.onResize(SESSION, 120, 30);
      manager.onData(SESSION, '\x1b[2J\x1b[1;1HTUI FRAME ROW');

      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toContain('TUI FRAME ROW');
      expect(snapshot).not.toContain('PS C:');
      expect(snapshot).not.toContain('acceptEdits');
      // The mobile seed reads the same parser, so it is cleaned too.
      const mobileFrame = await manager.getSerializedFrame(SESSION);
      expect(mobileFrame).not.toContain('PS C:');
      // The ring stays raw: getScrollback's read-time tuiStartIndex strip is
      // the byte route's own mechanism, never an injected byte.
      expect(manager.getRawScrollback(SESSION)).not.toContain('\x1b[3J');

      manager.removeSession(SESSION);
    });

    it('ConPTY\'s startup clear does not consume the pre-TUI strip', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // Captured verbatim from a live pwsh spawn: ConPTY opens the stream
      // with its OWN \x1b[2J before any printable output. The strip must not
      // fire there (nothing to strip yet) - the TUI-takeover clear is the
      // first one PRECEDED by printable output (the prompt/echo).
      manager.onData(SESSION, '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H');
      manager.onData(SESSION, 'PS C:\\Users\\dev> node agent.js --permission-mode acceptEdits\r\n');
      let scrolledOutput = '';
      for (let line = 1; line <= 40; line += 1) {
        scrolledOutput += `banner and task text line ${line}\r\n`;
      }
      manager.onData(SESSION, scrolledOutput);
      manager.onResize(SESSION, 120, 30);
      manager.onData(SESSION, '\x1b[2J\x1b[1;1HTUI FRAME ROW');

      // The geometry-gated frame route is stripped ...
      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toContain('TUI FRAME ROW');
      expect(snapshot).not.toContain('PS C:');
      // ... and so is the raw byte route: tuiStartIndex is stamped at the
      // SAME takeover clear, not ConPTY's startup clear, so the two routes
      // agree on where the session's replayable history begins.
      const rawReplay = manager.getScrollback(SESSION);
      expect(rawReplay).toContain('TUI FRAME ROW');
      expect(rawReplay).not.toContain('PS C:');

      manager.removeSession(SESSION);
    });

    it('printable characters INSIDE escape payloads (an OSC window title) do not arm the takeover predicate', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // The one false-positive that would re-create the ConPTY bug: an OSC
      // window title carries a full filesystem path, and if its payload
      // counted as printable output, a startup clear arriving AFTER the title
      // would consume the one-shot strip with nothing to strip. Order matters
      // on real machines (the captured pwsh preamble happens to title AFTER
      // its clear), so pin the title-first order explicitly.
      manager.onData(SESSION, '\x1b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\x07\x1b[?25l\x1b[2J\x1b[m\x1b[H');
      manager.onData(SESSION, 'PS C:\\Users\\dev> node agent.js\r\n');
      let scrolledOutput = '';
      for (let line = 1; line <= 40; line += 1) {
        scrolledOutput += `banner text line ${line}\r\n`;
      }
      manager.onData(SESSION, scrolledOutput);
      manager.onResize(SESSION, 120, 30);
      manager.onData(SESSION, '\x1b[2J\x1b[1;1HTUI FRAME ROW');

      // The strip stayed armed through the title+clear preamble and fired on
      // the REAL takeover clear: the echo is gone from the gated frame.
      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toContain('TUI FRAME ROW');
      expect(snapshot).not.toContain('PS C:');

      manager.removeSession(SESSION);
    });

    it('a single chunk coalescing the ConPTY startup clear, the shell echo, and the takeover clear strips on the qualifying clear only', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      let bannerLines = '';
      for (let line = 1; line <= 40; line += 1) {
        bannerLines += `banner and task text line ${line}\r\n`;
      }
      // ConPTY's escape-only startup clear, the shell echo, AND the real
      // takeover clear, all coalesced into ONE PTY chunk - the shape a fast
      // spawn can deliver in a single read. The scan must walk FORWARD past
      // the disqualified first \x1b[2J and fire on the second.
      manager.onData(
        SESSION,
        '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H'
        + 'PS C:\\Users\\dev> node agent.js\r\n'
        + bannerLines
        + '\x1b[2J\x1b[1;1HTUI FRAME ROW',
      );

      await expect
        .poll(() => onFlush.mock.calls.length > 0, { timeout: 2000, interval: 10 })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const flushed = onFlush.mock.calls.map((call) => call[1] as string).join('');
      expect(flushed.split('\x1b[3J').length - 1).toBe(1);

      const replay = manager.getScrollback(SESSION);
      expect(replay).not.toContain('PS C:');
      expect(replay).toContain('TUI FRAME ROW');

      manager.removeSession(SESSION);
    });

    it('a DECSCUSR cursor-style set and a DCS payload do not count as printable output', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // DECSCUSR (a CSI sequence with an intermediate byte) and a DCS string
      // payload, BEFORE ConPTY's escape-only startup clear. Neither payload
      // may register as printable: if it did, the startup clear below would
      // wrongly read as the takeover clear (printable output already seen)
      // and consume the one-shot with nothing real to strip.
      manager.onData(SESSION, '\x1b[2 q\x1bPpayload-text\x1b\\\x1b[?25l\x1b[2J\x1b[m\x1b[H');
      manager.onData(SESSION, 'PS C:\\Users\\dev> node agent.js\r\n');
      let scrolledOutput = '';
      for (let line = 1; line <= 40; line += 1) {
        scrolledOutput += `banner text line ${line}\r\n`;
      }
      manager.onData(SESSION, scrolledOutput);
      manager.onResize(SESSION, 120, 30);
      manager.onData(SESSION, '\x1b[2J\x1b[1;1HTUI FRAME ROW');

      // The one-shot stayed armed through the DECSCUSR/DCS preamble and
      // fired on the REAL takeover clear: the echo is gone from the gated
      // frame.
      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toContain('TUI FRAME ROW');
      expect(snapshot).not.toContain('PS C:');

      manager.removeSession(SESSION);
    });

    it('a Clear-Host-style prelude (per-row erases + \\x1b[3J, no \\x1b[2J) cleans the frame purely in-stream', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // The spawn clear prelude's SOURCE layer must not depend on the 2J
      // detection layer at all: pwsh's Clear-Host renders through ConPTY as
      // per-row EL erases plus an \x1b[3J scrollback erase and NEVER emits
      // \x1b[2J (captured live 2026-08-26). The parser must come out clean
      // from those bytes alone - this is what keeps the prelude zero-
      // maintenance against shell updates, with no Kangentic parsing in the
      // loop.
      manager.onData(SESSION, 'PS C:\\Users\\dev> Clear-Host; node agent.js\r\n');
      let scrolledOutput = '';
      for (let line = 1; line <= 40; line += 1) {
        scrolledOutput += `pre-clear preamble line ${line}\r\n`;
      }
      manager.onData(SESSION, scrolledOutput);
      // Clear-Host's rendered output, shaped like the live capture.
      manager.onData(SESSION, `\x1b[m\x1b[H${'\x1b[K\r\n'.repeat(23)}\x1b[K\x1b[H\x1b[3J`);
      manager.onData(SESSION, 'agent output after the prelude clear');

      // The bare parser read (no gate, no settle, no injected ED3 triggered -
      // there is no \x1b[2J anywhere in this stream): everything pre-clear is
      // gone because the STREAM removed it.
      const mobileFrame = await manager.getSerializedFrame(SESSION);
      expect(mobileFrame).toContain('agent output after the prelude clear');
      expect(mobileFrame).not.toContain('PS C:');
      expect(mobileFrame).not.toContain('pre-clear preamble');

      manager.removeSession(SESSION);
    });

    it('a terminal mounted at spawn gets the pre-TUI strip LIVE, exactly once, at the first clear', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // No replay in this scenario: the terminal was already mounted when the
      // session spawned, so everything it shows arrives via the flush stream.
      manager.onData(SESSION, 'PS C:\\Users\\dev> node agent.js\r\n');
      manager.onData(SESSION, '\x1b[2J\x1b[1;1HTUI FRAME ROW');
      manager.onData(SESSION, '\x1b[2J\x1b[1;1Hsecond repaint');
      await expect
        .poll(() => onFlush.mock.calls.length > 0, { timeout: 2000, interval: 10 })
        .toBe(true);

      const flushed = onFlush.mock.calls.map((call) => call[1] as string).join('');
      // Exactly one ED 3, ordered after the FIRST clear so the live xterm
      // drops the echo from its scrollback the moment the TUI takes over;
      // later repaints must not re-trigger it.
      expect(flushed.split('\x1b[3J').length - 1).toBe(1);
      expect(flushed.indexOf('\x1b[2J')).toBeLessThan(flushed.indexOf('\x1b[3J'));

      manager.removeSession(SESSION);
    });

    it('an alt-screen entry coalesced with the clear in the same chunk leaves the one-shot armed for a later normal-buffer clear', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      // Printable echo first, so the takeover predicate has evidence.
      manager.onData(SESSION, 'PS C:\\Users\\dev> node agent.js\r\n');
      // Alt-screen enter AND a full clear together in one chunk - a
      // fullscreen TUI clearing on entry. inAltScreen is read AFTER
      // updateModeState, so this reads as alt and must be SKIPPED: the
      // one-shot stays armed for a later NORMAL-buffer clear.
      manager.onData(SESSION, '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame');
      // Exit alt screen, then a genuine normal-buffer takeover clear.
      manager.onData(SESSION, '\x1b[?1049l');
      manager.onData(SESSION, '\x1b[2J\x1b[1;1HTUI FRAME ROW');

      await expect
        .poll(() => onFlush.mock.calls.length > 0, { timeout: 2000, interval: 10 })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const flushed = onFlush.mock.calls.map((call) => call[1] as string).join('');
      // Exactly one ED3 in the whole stream, landing AFTER the alt frame -
      // the alt-chunk clear did not consume the one-shot.
      expect(flushed.split('\x1b[3J').length - 1).toBe(1);
      expect(flushed.indexOf('\x1b[3J')).toBeGreaterThan(flushed.indexOf('alt frame'));

      manager.removeSession(SESSION);
    });

    it('the injected ED3 lands at the clear boundary within the chunk, not at chunk end', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      let postClearLines = '';
      for (let line = 1; line <= 40; line += 1) {
        postClearLines += `post-clear line ${line}\r\n`;
      }
      // Printable echo, the takeover clear, and enough post-clear TUI output
      // in the SAME chunk to scroll the 24-row viewport, so some post-clear
      // lines land in the parser's retained SCROLLBACK, not just its
      // viewport. A chunk-end injection would erase those along with the
      // pre-TUI echo.
      manager.onData(
        SESSION,
        'PS C:\\Users\\dev> node agent.js\r\n'
        + '\x1b[2J'
        + postClearLines,
      );

      await expect
        .poll(() => onFlush.mock.calls.length > 0, { timeout: 2000, interval: 10 })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const flushed = onFlush.mock.calls.map((call) => call[1] as string).join('');
      const clearIndex = flushed.indexOf('\x1b[2J');
      const injectedIndex = flushed.indexOf('\x1b[3J');
      const firstPostClearLineIndex = flushed.indexOf('post-clear line 1\r\n');
      expect(clearIndex).toBeGreaterThanOrEqual(0);
      expect(injectedIndex).toBe(clearIndex + '\x1b[2J'.length);
      expect(injectedIndex).toBeLessThan(firstPostClearLineIndex);

      // The parsed grid confirms the early post-clear lines (scrolled into
      // the parser's retained scrollback) survive, while the pre-clear echo
      // is gone.
      const frame = await manager.getSerializedFrame(SESSION);
      expect(frame).toContain('post-clear line 1');
      expect(frame).not.toContain('PS C:');

      manager.removeSession(SESSION);
    });

    it('a carried-over ring\'s scrollback is never wiped by the NEW process\'s first clear', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      // Enough carried lines that the early ones sit in the parser's
      // SCROLLBACK (a \x1b[2J only erases the viewport, in both routes).
      // Unknown prior geometry: gate armed conservatively, frame route
      // serves the replay.
      let carriedHistory = '';
      for (let line = 1; line <= 40; line += 1) {
        carriedHistory += `carried-history line ${line}\r\n`;
      }
      manager.initSession(SESSION, carriedHistory, 80, 24);
      manager.onData(SESSION, '\x1b[2J\x1b[1;1Hrespawned frame');

      const snapshot = await manager.getReplaySnapshot(SESSION);
      // The pre-TUI strip is a fresh-spawn rule (mirroring tuiStartIndex's
      // carried-ring opt-out at initSession): carried history is genuine user
      // content, and the new process's first full clear must not trigger the
      // parser-side scrollback wipe on it.
      expect(snapshot).toContain('carried-history line 1');
      expect(snapshot).toContain('respawned frame');

      manager.removeSession(SESSION);
    });

    it('a transient session never arms the pre-TUI strip', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24, null, true);

      manager.onData(SESSION, 'PS C:\\Users\\dev> some-command\r\n');
      manager.onData(SESSION, '\x1b[2J\x1b[1;1Hcleared viewport');

      await expect
        .poll(() => onFlush.mock.calls.length > 0, { timeout: 2000, interval: 10 })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const flushed = onFlush.mock.calls.map((call) => call[1] as string).join('');
      // A Command Terminal shell has no spawn command to strip, and a later
      // ordinary \x1b[2J (which by spec erases the viewport only) must never
      // be upgraded into a scrollback wipe.
      expect(flushed).not.toContain('\x1b[3J');
      expect(manager.getRawScrollback(SESSION)).toContain('some-command');

      manager.removeSession(SESSION);
    });

    it('a resize with an empty ring never arms the gate (the common first fit after spawn)', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 120, 30);

      // The renderer's mount fit lands before any PTY output: nothing in the
      // ring was drawn at the spawn geometry, so the session keeps the raw
      // full-history route for life.
      manager.onResize(SESSION, 210, 48);
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBeNull();

      manager.onData(SESSION, 'first output after the fit');
      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toBe(manager.getScrollback(SESSION));

      manager.removeSession(SESSION);
    });

    it('self-heals to the raw byte replay once the trim passes the geometry change', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, 'pre-change bytes');
      manager.onResize(SESSION, 100, 24);
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBe('pre-change bytes'.length);

      // Flood well past the 768KB trim threshold (same pattern as the
      // parsed-grid ring-cap fixture above, without the alt-screen enter) so
      // the trim removes the whole pre-change prefix.
      const MAX_SCROLLBACK = 512 * 1024;
      const dynamicUnit = '\x1b[24;1H' + 'x'.repeat(20); // stays on row 24, 20 cols < 100: no wrap, no scroll
      const dynamicChunk = dynamicUnit.repeat(80);
      let floodedBytes = 0;
      while (floodedBytes < MAX_SCROLLBACK + 400 * 1024) {
        manager.onData(SESSION, dynamicChunk);
        floodedBytes += dynamicChunk.length;
      }

      // Every remaining ring byte postdates the change: gate cleared, raw
      // full-history replay restored.
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBeNull();
      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toBe(manager.getScrollback(SESSION));

      manager.removeSession(SESSION);
    });

    it('replays a geometry-spanning non-alt session through the parsed grid, so no stale-geometry frame stitches into the current one', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 210, 48);

      // Frame A: a normal-buffer TUI repaint drawn for a 48-row grid (Claude
      // Code's default renderer with fullscreen disabled) - absolute CUP per
      // row, EL to clear the remainder, every line short enough that no
      // geometry wraps it. No \x1b[2J anywhere: a full clear would trip the
      // tuiStartIndex strip in getScrollback and mask the geometry defect.
      let frameForTallGrid = '';
      for (let row = 2; row <= 40; row += 1) {
        frameForTallGrid += `\x1b[${row};1HFRAME_ALPHA_${String(row).padStart(2, '0')}\x1b[K`;
      }
      manager.onData(SESSION, frameForTallGrid);
      // Flush barrier: headless.write is queued on a macrotask while
      // headless.resize applies immediately, so without this the resize would
      // overtake frame A and the parser would lay it out at the SHORT grid.
      // In production the queue drains within the same tick burst; a bare
      // serialize (getSerializedFrame) awaits exactly that barrier.
      await manager.getSerializedFrame(SESSION);

      // The window is restored: the PTY shrinks and the TUI repaints its
      // whole frame for the new 24-row grid.
      manager.onResize(SESSION, 80, 24);
      let frameForShortGrid = '';
      for (let row = 1; row <= 24; row += 1) {
        frameForShortGrid += `\x1b[${row};1HFRAME_BRAVO_${String(row).padStart(2, '0')}\x1b[K`;
      }
      manager.onData(SESSION, frameForShortGrid);

      const snapshot = await manager.getReplaySnapshot(SESSION);

      // Replay at a THIRD geometry, like a detail-window xterm whose fit
      // matches neither historical grid.
      const terminal = await replayIntoFreshTerminal(snapshot, 120, 30);
      const activeBuffer = terminal.buffer.active;
      const alphaRows: number[] = [];
      const bravoRows: number[] = [];
      for (let row = 0; row < activeBuffer.length; row += 1) {
        const rowText = activeBuffer.getLine(row)?.translateToString(true) ?? '';
        const hasAlpha = rowText.includes('FRAME_ALPHA');
        const hasBravo = rowText.includes('FRAME_BRAVO');
        // The reported corruption: two frames' texts on the same row.
        expect(hasAlpha && hasBravo).toBe(false);
        if (hasAlpha) alphaRows.push(row);
        if (hasBravo) bravoRows.push(row);
      }
      // Both frames survive somewhere (guards a vacuous pass) ...
      expect(alphaRows.length).toBeGreaterThan(0);
      expect(bravoRows.length).toBeGreaterThan(0);
      // ... and history rows strictly precede current-frame rows. A raw byte
      // replay clamps frame A's rows 31..40 onto the 30-row grid and strands
      // them BELOW frame B - stale-geometry text under the live frame.
      expect(Math.max(...alphaRows)).toBeLessThan(Math.min(...bravoRows));

      manager.removeSession(SESSION);
    });

    it('drains the pending buffer on the frame branch like getScrollback does', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, '\x1b[?1049h\x1b[2J\x1b[1;1Hpending frame bytes');

      const snapshot = await manager.getReplaySnapshot(SESSION);
      expect(snapshot).toContain('pending frame bytes');
      expect(manager.getBufferStats(SESSION)?.pendingBytes).toBe(0);
      // The already-queued 16ms flush finds an empty buffer and stays silent,
      // so nothing baked into the frame is delivered a second time.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(onFlush).not.toHaveBeenCalled();

      manager.removeSession(SESSION);
    });

    it('the geometry-gated non-alt route runs the same sampling protocol as the alt route', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, 'seed drawn pre-resize');
      manager.onResize(SESSION, 120, 30);
      manager.onData(SESSION, 'pending frame bytes');

      const snapshot = await manager.getReplaySnapshot(SESSION);
      // Drain semantics: bytes pending at sample time ride the reply (baked
      // into the frame or tail-folded), never a later flush - the renderer
      // drops held bytes as already-replayed, so a flush here would lose them.
      expect(snapshot).toContain('pending frame bytes');
      expect(manager.getBufferStats(SESSION)?.pendingBytes).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(onFlush).not.toHaveBeenCalled();
      // Never-alt shape: the serialize addon emits the 1049h switch only when
      // the active buffer is alternate, and nothing else may sneak one in - a
      // switch here would strand the replayed frame in the wrong buffer.
      expect(snapshot).not.toContain('\x1b[?1049h');

      manager.removeSession(SESSION);
    });

    it('returns empty string for an unknown or empty session', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      expect(await manager.getReplaySnapshot('nonexistent')).toBe('');
      manager.initSession(SESSION, '', 80, 24);
      expect(await manager.getReplaySnapshot(SESSION)).toBe('');
      manager.removeSession(SESSION);
    });

    it('folds bytes that race the sample into the reply exactly once, never via a flush', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame');

      const pendingSnapshot = manager.getReplaySnapshot(SESSION); // do not await yet
      manager.onData(SESSION, 'RACE_BYTES'); // lands during the await window
      const snapshot = await pendingSnapshot;

      // The atomic serialize (see HeadlessFrameBuffer.serialize) bakes in only
      // the bytes fed before the drain, so the race bytes cannot land inside
      // the frame itself - they can only appear once, as the tail folded on
      // after the await.
      expect(snapshot.split('RACE_BYTES').length - 1).toBe(1);

      // The held flush tick (replaySamplesInFlight, see scheduleFlush) must
      // never deliver them a second time via onFlush: the tail fold already
      // drained state.buffer, so the re-armed tick finds nothing to emit.
      await new Promise((resolve) => setTimeout(resolve, 40));
      for (const call of onFlush.mock.calls) {
        expect(call[1]).not.toContain('RACE_BYTES');
      }

      manager.removeSession(SESSION);
    });

    it('resolves empty when the session is torn down mid-sample', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame');

      const pendingSnapshot = manager.getReplaySnapshot(SESSION); // do not await yet
      manager.removeSession(SESSION);

      // The post-await teardown check must settle the reply to an empty
      // string rather than leaving it hanging on a disposed parser, whether
      // the serialize barrier resolves before or after REPLAY_SERIALIZE_MAX_WAIT_MS.
      const snapshot = await pendingSnapshot;
      expect(snapshot).toBe('');
    });

    it('a stale-generation identity guard: removeSession + initSession under the SAME id mid-await never resolves the old sample to a live-looking snapshot, and never touches the new generation\'s pending bytes', async () => {
      const onFlush = vi.fn();
      const onDrain = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80, 24);
      const ALT_BYTES = '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame';
      manager.onData(SESSION, ALT_BYTES);

      // Make the OLD generation's serialize a controllable deferred promise
      // (rather than the permanently-wedged pattern used above) so the test
      // can resolve it deterministically AFTER swapping in a new generation,
      // instead of racing REPLAY_SERIALIZE_MAX_WAIT_MS.
      interface ManagerInternals {
        buffers: Map<string, { headless: { serialize: () => Promise<string> } }>;
      }
      const oldBufferState = (manager as unknown as ManagerInternals).buffers.get(SESSION);
      if (!oldBufferState) throw new Error('test setup: session buffer state missing');
      let resolveSerialize: ((value: string) => void) | undefined;
      const deferredSerialize = new Promise<string>((resolve) => { resolveSerialize = resolve; });
      oldBufferState.headless.serialize = () => deferredSerialize;

      const pendingSnapshot = manager.getReplaySnapshot(SESSION); // do not await yet
      // The pre-serialize drain reports the OLD generation's pending bytes
      // synchronously, before the await.
      expect(onDrain.mock.calls).toEqual([[SESSION, ALT_BYTES]]);

      // Same session id, a NEW generation, while the old sample is still
      // in flight (`state` inside the pending call still points at the OLD
      // BufferState object).
      manager.removeSession(SESSION);
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, 'NEW_GENERATION_BYTES');

      // Let the old sample's serialize resolve now that a new generation
      // exists under the same id.
      if (!resolveSerialize) throw new Error('test setup: resolveSerialize not captured');
      resolveSerialize('stale frame from the disposed generation');
      const snapshot = await pendingSnapshot;

      // The mid-await identity check (`this.buffers.get(sessionId) !== state`)
      // must reject the stale sample rather than resolve the OLD generation's
      // frame under the now-live session id.
      expect(snapshot).toBe('');

      // The old sample's teardown must never drain or tap-report the NEW
      // generation's pending buffer: onDrain has still seen only the OLD
      // generation's pre-serialize drain, never NEW_GENERATION_BYTES.
      expect(onDrain.mock.calls).toEqual([[SESSION, ALT_BYTES]]);

      // And the new generation's bytes are still there, untouched, for its
      // own sample to find.
      expect(manager.getScrollback(SESSION)).toContain('NEW_GENERATION_BYTES');

      manager.removeSession(SESSION);
    });

    it('resumes normal flush delivery once a sample completes (replaySamplesInFlight must not stick)', async () => {
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame');

      await manager.getReplaySnapshot(SESSION);

      // The frame branch drains everything into the reply (see "drains the
      // pending buffer" above), so nothing should have flushed yet.
      expect(onFlush).not.toHaveBeenCalled();

      // Bytes fed AFTER the sample has fully resolved must still reach
      // onFlush on the ordinary 16ms tick. If replaySamplesInFlight's finally
      // decrement were ever lost (an early return before it, an off-by-one),
      // the counter would stay above zero, scheduleFlush's tick would re-arm
      // forever, and this data would never be delivered - the renderer would
      // go permanently silent for the session.
      manager.onData(SESSION, 'POST_SAMPLE_BYTES');
      await expect
        .poll(
          () => onFlush.mock.calls.some((call) => typeof call[1] === 'string' && call[1].includes('POST_SAMPLE_BYTES')),
          { timeout: 2000, interval: 20 },
        )
        .toBe(true);

      manager.removeSession(SESSION);
    });

    it('propagates a HeadlessFrameBuffer.serialize rejection rather than swallowing it', async () => {
      const manager = new PtyBufferManager({ onFlush: vi.fn(), onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame');

      // Force the underlying serializer to throw. HeadlessFrameBuffer.serialize's
      // own try/catch (see tests/unit/headless-frame.test.ts) turns that into a
      // REJECTED promise rather than an uncaught main-process exception - but
      // getReplaySnapshot has no catch of its own around the Promise.race, so
      // that rejection must propagate all the way out to the caller
      // (SessionManager.getScrollback, then the IPC reply) rather than resolve
      // to a frame, the byte replay, or an empty string. The renderer's
      // existing getScrollback().catch() (useTerminal.ts) is the actual safety
      // net downstream; this pins that getReplaySnapshot itself does not
      // silently absorb the failure first.
      interface ManagerInternals {
        buffers: Map<string, { headless: { serializer: { serialize: (...args: unknown[]) => string } } }>;
      }
      const bufferState = (manager as unknown as ManagerInternals).buffers.get(SESSION);
      if (!bufferState) throw new Error('test setup: session buffer state missing');
      bufferState.headless.serializer.serialize = () => {
        throw new Error('serializer disposed mid-sample');
      };

      await expect(manager.getReplaySnapshot(SESSION)).rejects.toThrow('serializer disposed mid-sample');

      manager.removeSession(SESSION);
    });
  });

  describe('pre-TUI takeover-clear one-shot window expiry', () => {
    // Isolate the one fake-timer test in this cluster so a failure that
    // skips the inline vi.useRealTimers() restore cannot leak fake timers
    // into a sibling real-timer test elsewhere in the file that awaits the
    // headless parser's macrotask flush (same guard as the replay-drain
    // onDrain seam block below).
    afterEach(() => {
      vi.useRealTimers();
    });

    it('the one-shot expires after PRE_TUI_TAKEOVER_WINDOW_MS: a qualifying clear past the window does not strip', async () => {
      vi.useFakeTimers();
      const onFlush = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain: vi.fn() });
      manager.initSession(SESSION, '', 80, 24);

      manager.onData(SESSION, 'PS C:\\Users\\dev> node agent.js\r\n');
      // Past the 15s takeover window: onData disarms the one-shot without
      // firing before it even scans this next chunk for a clear.
      await vi.advanceTimersByTimeAsync(16_000);
      manager.onData(SESSION, '\x1b[2J\x1b[1;1HTUI FRAME ROW');
      await vi.advanceTimersByTimeAsync(100);

      const flushed = onFlush.mock.calls.map((call) => call[1] as string).join('');
      expect(flushed).not.toContain('\x1b[3J');

      vi.useRealTimers();
      manager.removeSession(SESSION);
    });
  });

  describe('replay-drain onDrain seam (focus-independent data-tap feeder)', () => {
    // A replay sample's double-delivery guard empties state.buffer without an
    // onFlush, which is correct for the requesting renderer (the bytes are
    // inside the replay payload it receives) but used to starve every
    // focus-independent data-tap consumer: a phone streaming the session
    // missed whatever was pending at sample time. onDrain is the dedicated
    // report of exactly those drained bytes.

    // A failing assertion skips a test's inline vi.useRealTimers(); restore
    // here so a red test cannot leak fake timers into later suites (the
    // headless parser's macrotask flush hangs forever under fake timers).
    afterEach(() => {
      vi.useRealTimers();
    });

    it('getScrollback reports the drained pending bytes via onDrain, never via onFlush', () => {
      vi.useFakeTimers();
      const { manager, onFlush, onDrain } = createManager();

      manager.onData(SESSION, 'hello world');
      manager.getScrollback(SESSION);

      expect(onDrain).toHaveBeenCalledTimes(1);
      expect(onDrain).toHaveBeenCalledWith(SESSION, 'hello world');

      // The already-queued 16ms flush still finds an empty buffer and stays
      // silent: onDrain reports the bytes, it does not re-deliver them.
      vi.advanceTimersByTime(20);
      expect(onFlush).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('reports the frame-branch pre-serialize drain via onDrain', async () => {
      const onFlush = vi.fn();
      const onDrain = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80, 24);
      const ALT_BYTES = '\x1b[?1049h\x1b[2J\x1b[1;1Hpending frame bytes';
      manager.onData(SESSION, ALT_BYTES);

      await manager.getReplaySnapshot(SESSION);

      expect(onDrain).toHaveBeenCalledTimes(1);
      expect(onDrain).toHaveBeenCalledWith(SESSION, ALT_BYTES);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(onFlush).not.toHaveBeenCalled();

      manager.removeSession(SESSION);
    });

    it('reports race bytes once via the tail fold, in order after the pre-drain', async () => {
      const onFlush = vi.fn();
      const onDrain = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80, 24);
      const ALT_BYTES = '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame';
      manager.onData(SESSION, ALT_BYTES);

      const pendingSnapshot = manager.getReplaySnapshot(SESSION); // do not await yet
      manager.onData(SESSION, 'RACE_BYTES'); // lands during the await window
      await pendingSnapshot;

      // Pre-drain first, tail second: data-tap consumers see the same byte
      // order the desktop replay preserves, and the race bytes appear in
      // exactly one report.
      expect(onDrain.mock.calls).toEqual([
        [SESSION, ALT_BYTES],
        [SESSION, 'RACE_BYTES'],
      ]);

      // And never a second time via a flush once the held tick re-fires.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(onFlush).not.toHaveBeenCalled();

      manager.removeSession(SESSION);
    });

    it('reports nothing when the pending buffer is already empty at sample time', () => {
      vi.useFakeTimers();
      const { manager, onFlush, onDrain } = createManager();

      manager.onData(SESSION, 'flushed before the sample');
      vi.advanceTimersByTime(20);
      expect(onFlush).toHaveBeenCalledTimes(1);

      manager.getScrollback(SESSION);
      expect(onDrain).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('an alt-screen sample with nothing pending reports neither a pre-drain nor a tail', async () => {
      const onFlush = vi.fn();
      const onDrain = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame');
      // Let the ordinary 16ms tick deliver the bytes first, so both the
      // pre-serialize drain and the tail fold find an empty buffer.
      await expect
        .poll(() => onFlush.mock.calls.length > 0, { timeout: 2000, interval: 10 })
        .toBe(true);

      await manager.getReplaySnapshot(SESSION);
      expect(onDrain).not.toHaveBeenCalled();

      manager.removeSession(SESSION);
    });

    it('the normal flush path delivers via onFlush only, never onDrain', () => {
      vi.useFakeTimers();
      const { manager, onFlush, onDrain } = createManager();

      manager.onData(SESSION, 'ordinary streamed output');
      vi.advanceTimersByTime(20);

      expect(onFlush).toHaveBeenCalledWith(SESSION, 'ordinary streamed output');
      expect(onDrain).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('the serialize-deadline fallback reports await-window bytes exactly once via onDrain', async () => {
      vi.useFakeTimers();
      const onFlush = vi.fn();
      const onDrain = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80, 24);
      const ALT_BYTES = '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame';
      manager.onData(SESSION, ALT_BYTES);

      // Wedge the parser so the sample rides the REPLAY_SERIALIZE_MAX_WAIT_MS
      // deadline into the byte-replay fallback.
      interface ManagerInternals {
        buffers: Map<string, { headless: { serialize: () => Promise<string> } }>;
      }
      const bufferState = (manager as unknown as ManagerInternals).buffers.get(SESSION);
      if (!bufferState) throw new Error('test setup: session buffer state missing');
      bufferState.headless.serialize = () => new Promise<string>(() => {});

      const pendingSnapshot = manager.getReplaySnapshot(SESSION);
      // The pre-serialize drain reports synchronously, before the await.
      expect(onDrain.mock.calls).toEqual([[SESSION, ALT_BYTES]]);

      manager.onData(SESSION, 'AWAIT_WINDOW_BYTES');
      await vi.advanceTimersByTimeAsync(1100);
      const snapshot = await pendingSnapshot;

      // The fallback's byte replay carries the await-window bytes to the
      // desktop, and its getScrollback drain reports the SAME bytes to
      // onDrain exactly once; no flush ever delivers them.
      expect(snapshot).toContain('AWAIT_WINDOW_BYTES');
      expect(onDrain.mock.calls).toEqual([
        [SESSION, ALT_BYTES],
        [SESSION, 'AWAIT_WINDOW_BYTES'],
      ]);
      expect(onFlush).not.toHaveBeenCalled();

      vi.useRealTimers();
      manager.removeSession(SESSION);
    });

    it('the serialize-deadline fallback degrades the geometry-gated (non-alt) route to the byte replay, not black', async () => {
      vi.useFakeTimers();
      const onFlush = vi.fn();
      const onDrain = vi.fn();
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80, 24);
      manager.onData(SESSION, 'drawn at the old geometry');
      manager.onResize(SESSION, 120, 30);
      manager.onData(SESSION, 'drawn at the new geometry');
      expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).not.toBeNull();

      // Wedge the parser so the sample rides the REPLAY_SERIALIZE_MAX_WAIT_MS
      // deadline into the byte-replay fallback (mirrors the alt-route
      // wedged-serialize test above, without entering the alt screen).
      interface ManagerInternals {
        buffers: Map<string, { headless: { serialize: () => Promise<string> } }>;
      }
      const bufferState = (manager as unknown as ManagerInternals).buffers.get(SESSION);
      if (!bufferState) throw new Error('test setup: session buffer state missing');
      bufferState.headless.serialize = () => new Promise<string>(() => {});

      const pendingSnapshot = manager.getReplaySnapshot(SESSION);
      await vi.advanceTimersByTimeAsync(1100);
      const snapshot = await pendingSnapshot;

      // Degrades to the byte replay - not black, not empty - and matches
      // getScrollback's own value for the same (now-drained) state.
      expect(snapshot).toContain('drawn at the old geometry');
      expect(snapshot).toContain('drawn at the new geometry');
      expect(snapshot).toBe(manager.getScrollback(SESSION));

      vi.useRealTimers();
      manager.removeSession(SESSION);
    });

    it('contains a throwing onDrain listener at the reportDrain chokepoint: the replay resolves and the counter never sticks', async () => {
      const onFlush = vi.fn();
      const onDrain = vi.fn(() => {
        throw new Error('listener failure');
      });
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80, 24);
      const ALT_BYTES = '\x1b[?1049h\x1b[2J\x1b[1;1Halt frame';
      manager.onData(SESSION, ALT_BYTES);

      // Two of the three drain sites report AFTER the pending buffer is
      // already emptied, so a propagating listener throw would reject the
      // replay IPC with the drained bytes gone. reportDrain contains the
      // throw instead: the replay must resolve normally, with the drain
      // still reported (best-effort, exactly once).
      await manager.getReplaySnapshot(SESSION);
      expect(onDrain).toHaveBeenCalledTimes(1);
      expect(onDrain).toHaveBeenCalledWith(SESSION, ALT_BYTES);

      // And the replaySamplesInFlight pairing survives the throw: new data
      // delivered via the ordinary flush path (not another sample, so
      // onDrain does not fire a second time) proves scheduleFlush's
      // replaySamplesInFlight > 0 hold is not re-arming forever.
      manager.onData(SESSION, 'new data after the failed drain');
      await expect
        .poll(() => onFlush.mock.calls.length > 0, { timeout: 2000, interval: 10 })
        .toBe(true);
      expect(onFlush).toHaveBeenCalledWith(SESSION, 'new data after the failed drain');

      manager.removeSession(SESSION);
    });

    it('a re-entrant onDrain that synchronously calls getScrollback for the same session sees exactly one drain report (no recursion, no duplicate delivery)', () => {
      vi.useFakeTimers();
      const onFlush = vi.fn();
      // Closes over `manager`, assigned on the next line - safe because this
      // callback only ever RUNS once manager.getScrollback(SESSION) is called
      // below, by which point the const is initialized.
      const onDrain = vi.fn((sessionId: string) => {
        // Synchronously call back into the manager for the SAME session, from
        // inside the drain report itself. reportDrain's ORDERING RULE
        // (state.buffer cleared BEFORE onDrain fires, see the comment on
        // PtyBufferManager.reportDrain) is what makes this re-entrant call
        // find an already-empty buffer and become a harmless no-op instead of
        // unbounded recursion with duplicate tap delivery.
        manager.getScrollback(sessionId);
      });
      const manager = new PtyBufferManager({ onFlush, onDrain });
      manager.initSession(SESSION, '', 80);
      manager.onResize(SESSION, 80);

      manager.onData(SESSION, 'hello world');
      manager.getScrollback(SESSION);

      expect(onDrain).toHaveBeenCalledTimes(1);
      expect(onDrain).toHaveBeenCalledWith(SESSION, 'hello world');

      vi.useRealTimers();
    });
  });

  describe('getOutputPeek (live PTY-grid-to-peek wiring)', () => {
    // Real timers, mirroring the getSerializedFrame block above: the headless
    // parser drains its write buffer on a macrotask. getOutputPeek itself is
    // deliberately SYNCHRONOUS and does not flush (see its doc comment on
    // PtyBufferManager) - in production it self-heals on the next 500ms sample
    // tick - so each test below forces the flush via getSerializedFrame (the
    // only public path to HeadlessFrameBuffer's private flush()) and discards
    // the serialized string. That is not a copy-paste mistake: it is the same
    // flush barrier the getSerializedFrame tests above rely on, reused here
    // because both methods read the SAME underlying headless parser instance.
    it('returns the real parsed-grid tail lines after feeding text through onData', async () => {
      const { manager } = createManager();

      manager.onData(SESSION, 'alpha\r\nbravo\r\ncharlie\r\n');
      await manager.getSerializedFrame(SESSION);

      expect(manager.getOutputPeek(SESSION)).toEqual(['alpha', 'bravo', 'charlie']);

      manager.removeSession(SESSION);
    });

    it('excludes the trailing prompt line the cursor currently sits on', async () => {
      const { manager } = createManager();

      manager.onData(SESSION, 'alpha\r\nbravo\r\ncharlie\r\nPS C:\\project> ');
      await manager.getSerializedFrame(SESSION);

      const peek = manager.getOutputPeek(SESSION);
      expect(peek).toEqual(['alpha', 'bravo', 'charlie']);
      expect(peek.join('\n')).not.toContain('PS C:');

      manager.removeSession(SESSION);
    });

    it('honors an explicit count, keeping the newest lines', async () => {
      const { manager } = createManager();

      manager.onData(SESSION, 'alpha\r\nbravo\r\ncharlie\r\ndelta\r\n');
      await manager.getSerializedFrame(SESSION);

      expect(manager.getOutputPeek(SESSION, 2)).toEqual(['charlie', 'delta']);

      manager.removeSession(SESSION);
    });

    it('returns [] for a session that has produced no output yet', async () => {
      const { manager } = createManager();

      await manager.getSerializedFrame(SESSION);
      expect(manager.getOutputPeek(SESSION)).toEqual([]);

      manager.removeSession(SESSION);
    });

    it('returns [] for a session id the manager has never heard of', () => {
      const { manager } = createManager();

      expect(manager.getOutputPeek('nonexistent-session')).toEqual([]);

      manager.removeSession(SESSION);
    });
  });
});
