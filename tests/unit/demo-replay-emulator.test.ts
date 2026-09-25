/**
 * `createReplayEmulator` (demo/replay-emulator.ts) is the web demo's own terminal: it plays a
 * recording's bytes into a headless xterm at the RECORDED grid and hands `emulatorPaint`
 * (tests/captures/helpers/demo-dataset.ts) a snapshot of what it shows, so a visitor's terminal on
 * any other grid can be repainted from it rather than fed the raw bytes
 * (.claude/rules/web-demo-parity.md, "A recording's bytes address rows for their own grid...").
 * This file drives the module directly: it is a real TypeScript module with a typed export, not
 * lifted out of a generated script.
 *
 * `@xterm/xterm`'s `Terminal` never touches a DOM until `.open()` is called on one, and
 * `createReplayEmulator` never calls `.open()` (the comment in replay-emulator.ts: "Never opened:
 * the parser and the buffer run without a renderer or a DOM"), so it loads and runs under
 * vitest's default node environment with no alias needed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parsePhysicalFrame } from '../../scripts/lib/demo-frame-serializer.js';
import { createReplayEmulator, type ReplayEmulator } from '../../demo/replay-emulator';

describe('createReplayEmulator', () => {
  let emulator: ReplayEmulator | null = null;
  afterEach(() => {
    emulator?.dispose();
    emulator = null;
  });

  describe('cursorHidden', () => {
    it('follows the last DECTCEM sequence written', async () => {
      emulator = createReplayEmulator(20, 5);
      expect(emulator.frame(0).cursorHidden).toBe(false);
      await emulator.write('\x1b[?25l');
      expect(emulator.frame(0).cursorHidden).toBe(true);
      await emulator.write('\x1b[?25h');
      expect(emulator.frame(0).cursorHidden).toBe(false);
    });

    it('takes the LAST of both sequences written in one call', async () => {
      emulator = createReplayEmulator(20, 5);
      await emulator.write('\x1b[?25l\x1b[?25h');
      expect(emulator.frame(0).cursorHidden).toBe(false);
      await emulator.write('\x1b[?25h\x1b[?25l');
      expect(emulator.frame(0).cursorHidden).toBe(true);
    });
  });

  describe('historyCleared', () => {
    it('is false before any ED3, true on the first frame() after one, and false again on the next', async () => {
      emulator = createReplayEmulator(20, 5);
      await emulator.write('hello');
      expect(emulator.frame(0).historyCleared).toBe(false);
      expect(emulator.frame(0).historyCleared).toBe(false);
      await emulator.write('\x1b[3J');
      expect(emulator.frame(0).historyCleared).toBe(true);
      expect(emulator.frame(0).historyCleared).toBe(false);
    });

    it('is set by a write that carries ED3 among other bytes, not only a write that is ED3 alone', async () => {
      emulator = createReplayEmulator(20, 5);
      await emulator.write('a\x1b[3Jb');
      expect(emulator.frame(0).historyCleared).toBe(true);
    });
  });

  describe('scrolledRows', () => {
    it('is zero until the screen has filled and scrolled', async () => {
      emulator = createReplayEmulator(10, 3);
      await emulator.write('line0\r\nline1\r\nline2');
      expect(emulator.frame(0).scrolledRows).toBe(0);
    });

    it('equals the normal buffer\'s baseY once more lines are written than the screen holds', async () => {
      emulator = createReplayEmulator(10, 3);
      // Five lines on a 3-row screen: the first three fill it, the next two each scroll it once.
      await emulator.write('line0\r\nline1\r\nline2\r\nline3\r\nline4');
      expect(emulator.frame(0).scrolledRows).toBe(2);
    });

    it('keeps growing as more lines are written across separate write() calls', async () => {
      emulator = createReplayEmulator(10, 3);
      await emulator.write('line0\r\nline1\r\nline2\r\nline3');
      expect(emulator.frame(0).scrolledRows).toBe(1);
      await emulator.write('\r\nline4\r\nline5');
      expect(emulator.frame(0).scrolledRows).toBe(3);
    });
  });

  describe('alternate', () => {
    it('is true after entering the alternate screen and false again after leaving it', async () => {
      emulator = createReplayEmulator(20, 5);
      expect(emulator.frame(0).alternate).toBe(false);
      await emulator.write('\x1b[?1049h');
      expect(emulator.frame(0).alternate).toBe(true);
      await emulator.write('\x1b[?1049l');
      expect(emulator.frame(0).alternate).toBe(false);
    });
  });

  describe('frame', () => {
    it('is physical rows ending in an absolute cursor suffix', async () => {
      emulator = createReplayEmulator(20, 5);
      await emulator.write('hello world');
      const parsed = parsePhysicalFrame(emulator.frame(0).frame) as { alt: boolean; rows: string[]; cursor: { row: number; col: number } | null };
      expect(parsed.cursor).not.toBeNull();
      expect(parsed.cursor?.row).toBeGreaterThanOrEqual(0);
      expect(parsed.cursor?.col).toBeGreaterThanOrEqual(0);
      expect(parsed.rows.length).toBeGreaterThan(0);
      expect(parsed.rows.length).toBeLessThanOrEqual(5);
      expect(parsed.rows.some((row) => row.includes('hello world'))).toBe(true);
    });

    it('carries rowsAbove extra rows above the screen when the buffer holds them', async () => {
      emulator = createReplayEmulator(10, 3);
      await emulator.write('line0\r\nline1\r\nline2\r\nline3\r\nline4');
      const parsed = parsePhysicalFrame(emulator.frame(2).frame) as { rows: string[] };
      // 2 rows above the 3-row screen: up to 5 physical rows.
      expect(parsed.rows.length).toBeLessThanOrEqual(5);
      expect(parsed.rows.some((row) => row.includes('line2'))).toBe(true);
      expect(parsed.rows.some((row) => row.includes('line4'))).toBe(true);
    });
  });

  it('dispose() does not throw', async () => {
    const handle = createReplayEmulator(20, 5);
    await handle.write('hello');
    expect(() => handle.dispose()).not.toThrow();
  });
});
