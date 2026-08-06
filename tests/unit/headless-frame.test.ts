import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { HeadlessFrameBuffer } from '../../src/main/pty/buffer/headless-frame';

/**
 * Cold-replay a serialized frame into a fresh parser, exactly as the renderer
 * does (xterm.reset() then write). Awaits xterm's own write callback so the
 * parse has actually landed before the assertions read the buffer.
 */
async function replayIntoFreshTerminal(payload: string, cols = 80, rows = 24): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => {
    terminal.write(payload, () => resolve());
  });
  return terminal;
}

/**
 * The scroll region has no public read path (see the note on
 * TerminalWithScrollRegion in headless-frame.ts), so the assertions go through
 * the same private door the production code does, cast through `unknown`.
 */
function readScrollRegion(terminal: Terminal): { top: number; bottom: number } {
  interface CoreAccessor {
    _core: { buffers: { active: { scrollTop: number; scrollBottom: number } } };
  }
  const activeBuffer = (terminal as unknown as CoreAccessor)._core.buffers.active;
  return { top: activeBuffer.scrollTop, bottom: activeBuffer.scrollBottom };
}

/**
 * HeadlessFrameBuffer.serialize underlies both the mobile seed
 * (PtyBufferManager.getSerializedFrame) and the desktop alt-screen replay
 * (PtyBufferManager.getReplaySnapshot). Both call sites, and the atomic
 * flush-barrier boundary that makes serialize()'s content cutoff exact, are
 * already exercised through PtyBufferManager in pty-buffer-manager.test.ts.
 *
 * This file targets the one behavior that lives entirely inside
 * HeadlessFrameBuffer and is not observable through those higher-level
 * callers: serialize() REJECTS (rather than throwing into xterm's own
 * write/parse loop as an uncaught main-process exception) when the
 * serializer itself throws mid-callback.
 *
 * Real timers throughout: serialize() awaits xterm's own macrotask flush
 * barrier (a zero-length terminal.write callback), matching the real-timer
 * discipline of the getSerializedFrame / getReplaySnapshot blocks in
 * pty-buffer-manager.test.ts.
 */
describe('HeadlessFrameBuffer', () => {
  describe('serialize', () => {
    it('rejects, rather than throwing uncaught, when the serializer throws mid-callback', async () => {
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('some content');

      // The callback that invokes serializer.serialize() runs inside xterm's
      // own write/parse loop (see the comment on HeadlessFrameBuffer.serialize),
      // not in this test's stack frame - so reaching into the private
      // serializer to force a throw from exactly there is the only way to
      // exercise the boundary the try/catch guards. A cast through `unknown`
      // (never `any`) is the narrowest way to reach it from a test.
      interface SerializerAccessor {
        serializer: { serialize: (...args: unknown[]) => string };
      }
      (buffer as unknown as SerializerAccessor).serializer.serialize = () => {
        throw new Error('serializer disposed mid-sample');
      };

      await expect(buffer.serialize()).rejects.toThrow('serializer disposed mid-sample');

      buffer.dispose();
    });
  });

  /**
   * The DECSTBM scroll region is the one piece of TUI state a serialized frame
   * cannot carry on its own: @xterm/addon-serialize builds its mode prefix from
   * `terminal.modes`, which is a bag of mode FLAGS with no margin members. So
   * every replay used to land in a terminal whose region spanned the full
   * viewport while the agent still believed its own margins were set, leaving
   * each later region-relative op (SD, IL) acting on the wrong rows. Claude Code
   * drives a real region, so this is a live gap rather than a theoretical one.
   *
   * These assertions replay the frame the way the renderer does and read the
   * margins back out, which is the only way to observe the round trip.
   */
  describe('serialize scroll-region round trip', () => {
    it('restores the scroll region a replayed frame would otherwise drop', async () => {
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('\x1b[?1049h');   // alt screen, as a fullscreen TUI uses
      buffer.write('\x1b[5;20r');    // DECSTBM rows 5..20 => 0-based 4..19
      buffer.write('\x1b[8;3Hhello');

      const replayed = await replayIntoFreshTerminal(await buffer.serialize());

      expect(readScrollRegion(replayed)).toEqual({ top: 4, bottom: 19 });

      buffer.dispose();
      replayed.dispose();
    });

    it('leaves the cursor where the frame left it, despite DECSTBM homing it', async () => {
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('\x1b[?1049h');
      buffer.write('\x1b[5;20r');
      buffer.write('\x1b[8;3Hhello');

      const replayed = await replayIntoFreshTerminal(await buffer.serialize());

      // `\x1b[8;3H` then 5 printed cells: row 7, column 7 (both 0-based).
      // Without the CUP that follows the region, DECSTBM's own _setCursor(0, 0)
      // would leave this at the region top instead.
      expect(replayed.buffer.active.cursorY).toBe(7);
      expect(replayed.buffer.active.cursorX).toBe(7);

      buffer.dispose();
      replayed.dispose();
    });

    it('compensates for origin mode, whose CUP is region-relative', async () => {
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('\x1b[?1049h');
      buffer.write('\x1b[5;20r');
      buffer.write('\x1b[?6h');      // DECOM: CUP rows become region-relative
      buffer.write('\x1b[3;1Hhi');   // row 3 OF THE REGION => absolute row 6

      // serialize() carries the flush barrier; cursorRow() deliberately does
      // not, so the source grid is only readable after the await.
      const frame = await buffer.serialize();
      expect(buffer.cursorRow()).toBe(6);

      const replayed = await replayIntoFreshTerminal(frame);

      expect(readScrollRegion(replayed)).toEqual({ top: 4, bottom: 19 });
      expect(replayed.buffer.active.cursorY).toBe(6);

      buffer.dispose();
      replayed.dispose();
    });

    it('adds nothing when the region already spans the grid', async () => {
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('\x1b[?1049h');
      buffer.write('plain output with no scroll region');

      // The suffix is region + CUP, so a session that never sets a region pays
      // zero bytes for this - which is every plain shell and most of a TUI's life.
      expect(await buffer.serialize()).not.toMatch(/\x1b\[\d+;\d+r/);

      buffer.dispose();
    });

    it('still emits a bare CUP for origin mode with no scroll region set', async () => {
      // scrollRegionSuffix's early return is `if (!region && !originMode) return '';`,
      // so origin mode alone (no region) must still fall through and emit a CUP.
      // The reason: the serialize addon appends its own `\x1b[?6h` AFTER its own
      // cursor restore, and DECSET 6 homes the cursor on its own, so without this
      // half of the condition a frame with origin mode on but no region would
      // always replay with the cursor stuck at home. Dropping the `originMode`
      // operand from the early-return condition (`!region && !originMode` ->
      // `!region`) makes this go red.
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('\x1b[?1049h');   // alt screen, as a fullscreen TUI uses
      buffer.write('\x1b[?6h');      // DECOM on, no DECSTBM region set
      buffer.write('\x1b[8;3Hhello'); // no active region, so this addresses absolutely

      const frame = await buffer.serialize();

      // No region was ever set, so the suffix must carry no DECSTBM re-assert.
      expect(frame).not.toMatch(/\x1b\[\d+;\d+r/);

      const replayed = await replayIntoFreshTerminal(frame);

      // Same landing spot as the plain cursor-survives-homing case: row 7, column 7
      // (both 0-based), from `\x1b[8;3H` plus five printed cells.
      expect(replayed.buffer.active.cursorY).toBe(7);
      expect(replayed.buffer.active.cursorX).toBe(7);

      buffer.dispose();
      replayed.dispose();
    });

    it('round-trips a region whose bottom touches the grid edge but whose top does not', async () => {
      // activeScrollRegion() treats a region as "spans the whole grid" (and drops
      // it) only when BOTH `top <= 0` and `bottom >= rows - 1` hold. Every other
      // test in this file uses top=4/bottom=19 on a 24-row grid, where both
      // operands are false, so `&&` and a mutated `||` agree and no existing test
      // can tell them apart. This region has top=4 (not <= 0) but bottom=23, the
      // last row of a 24-row grid (>= rows - 1): a real, non-full region that a
      // broken `||` would wrongly null out and silently drop.
      const buffer = new HeadlessFrameBuffer(80, 24);
      buffer.write('\x1b[?1049h');
      buffer.write('\x1b[5;24r');    // DECSTBM rows 5..24 => 0-based 4..23 (grid edge)
      buffer.write('\x1b[8;3Hhello');

      const frame = await buffer.serialize();

      expect(frame).toMatch(/\x1b\[\d+;\d+r/);

      const replayed = await replayIntoFreshTerminal(frame);

      expect(readScrollRegion(replayed)).toEqual({ top: 4, bottom: 23 });

      buffer.dispose();
      replayed.dispose();
    });
  });
});
