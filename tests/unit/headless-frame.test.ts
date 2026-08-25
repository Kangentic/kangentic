import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { HeadlessFrameBuffer } from '../../src/main/pty/buffer/headless-frame';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';

/**
 * Cold-replay a serialized frame into a fresh parser, exactly as the renderer
 * does (xterm.reset() then write) - including the renderer's Unicode 11 width
 * table, so round-trip assertions exercise the real serialize/replay pair.
 * Awaits xterm's own write callback so the parse has actually landed before
 * the assertions read the buffer.
 */
async function replayIntoFreshTerminal(payload: string, cols = 80, rows = 24): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  activateUnicode11(terminal);
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
 * This file targets behavior that lives entirely inside HeadlessFrameBuffer
 * and is not observable through those higher-level callers: serialize()
 * REJECTS (rather than throwing into xterm's own write/parse loop as an
 * uncaught main-process exception) when the serializer itself throws
 * mid-callback; the DECSTBM/origin-mode suffix round trip; and the Unicode 11
 * width table that keeps the parsed grid aligned with what the producing TUI
 * drew (see the 'Unicode 11 width parity' block).
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
   * each later region-relative op (SD, IL) acting on the wrong rows.
   *
   * Claude Code's own DECSTBM use is currently gated OFF under xterm.js
   * (measured with `claude --debug`; see `scrollRegionSuffix`), so the region
   * branch guards against that gate reopening rather than repairing a live
   * break. The origin-mode branch is live regardless, which is why it has its
   * own case below.
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

  /**
   * Agent TUIs (Claude Code) pad each row with spaces to the FULL terminal
   * width, counting modern emoji as double width, and rely on autowrap - not
   * CR/LF - to reach the next row. xterm's default Unicode V6 table scores
   * those emoji single width, so every emoji left the row one column short,
   * the wrap fired one character late, and each following row drifted one
   * column further left (task #557). The parser must run the Unicode 11
   * table (activateUnicode11) to wrap where the producer expected.
   */
  describe('Unicode 11 width parity', () => {
    // The task's live repro shape at 40 columns: row 0 is exactly full when
    // the check mark counts as TWO columns (1 + 2 + 37), so 'B' and 'C' reach
    // their rows purely by autowrap.
    const EMOJI_AUTOWRAP_FRAME =
      'A✅' + ' '.repeat(37) + 'B' + ' '.repeat(39) + 'C';

    // The frame's padding is WRITTEN spaces, which translateToString(true)
    // keeps (it trims only never-written null cells), so the row readers trim
    // trailing whitespace themselves - same as the devtools forensics dump.
    // What the assertions pin is where the wrap fired: under V6 the 'B'
    // survives any trim because it sits at the END of row 0.
    it('scores emoji double width, so autowrapped rows land where the TUI drew them', async () => {
      const buffer = new HeadlessFrameBuffer(40, 24);
      buffer.write(EMOJI_AUTOWRAP_FRAME);

      // serialize() carries the flush barrier; lineAt() deliberately does not,
      // so the grid is only readable after the await.
      await buffer.serialize();
      const sourceRow = (row: number): string => buffer.lineAt(row).replace(/\s+$/u, '');

      expect(sourceRow(0)).toBe('A✅');
      expect(sourceRow(1)).toBe('B');
      expect(sourceRow(2)).toBe('C');

      buffer.dispose();
    });

    it('round-trips an emoji frame through serialize into a fresh terminal without drift', async () => {
      const buffer = new HeadlessFrameBuffer(40, 24);
      buffer.write(EMOJI_AUTOWRAP_FRAME);

      const replayed = await replayIntoFreshTerminal(await buffer.serialize(), 40, 24);
      const replayedRow = (row: number): string =>
        (replayed.buffer.active.getLine(row)?.translateToString(true) ?? '').replace(/\s+$/u, '');
      const sourceRow = (row: number): string => buffer.lineAt(row).replace(/\s+$/u, '');

      // The ABSOLUTE expectations are load-bearing: a rows-match-the-source
      // assertion alone would pass with BOTH parsers on V6 (drifting in
      // lockstep), and if either side alone ever lost the addon would fail
      // only via the mismatch. Pinning 'B' to row 1 keeps this red in both
      // failure shapes.
      expect(replayedRow(0)).toBe('A✅');
      expect(replayedRow(1)).toBe('B');
      expect(replayedRow(2)).toBe('C');
      expect([replayedRow(0), replayedRow(1), replayedRow(2)])
        .toEqual([sourceRow(0), sourceRow(1), sourceRow(2)]);

      buffer.dispose();
      replayed.dispose();
    });
  });
});
