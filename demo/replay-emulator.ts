/**
 * The web demo's own terminal emulator (tests/captures/helpers/demo-dataset.ts, frameScrollback).
 *
 * A recording's bytes replay only into the grid they were recorded at, and a visitor's pane is
 * almost never exactly that grid. So a terminal on any other grid is fed through one of these: the
 * recording's bytes are written into it at the RECORDED grid, on the session's clock, and the
 * visitor's terminal is repainted from what it shows, fitted to the visitor's grid. That is main's
 * own answer for a PTY whose grid the renderer does not share (a parsed-grid frame), at the pace
 * of the stream.
 *
 * It is the xterm the renderer runs, with the same Unicode 11 widths
 * (src/shared/xterm-unicode11.ts), serialized by the physical-row serializer the capture script
 * writes its frames with (scripts/lib/demo-frame-serializer.js), so a frame painted here and one
 * recorded there are the same bytes for the same screen.
 *
 * Loaded on first use (demo/replay-emulator-entry.ts): a page whose terminals all fit their
 * recordings never fetches it.
 */
import { Terminal } from '@xterm/xterm';
import { activateUnicode11 } from '../src/shared/xterm-unicode11';
import { serializePhysicalRows } from '../scripts/lib/demo-frame-serializer.js';

/** DECTCEM: the CLI hiding or showing its cursor. The last one written is the state a frame carries. */
const CURSOR_VISIBILITY = /\x1b\[\?25([hl])/g;
/** ED3: the CLI clearing the rows above its screen, after which a repaint cannot build on the last. */
const CLEAR_SCROLLBACK = '\x1b[3J';

/** Rows kept above the screen, as the renderer's own terminal keeps them. */
const EMULATOR_SCROLLBACK_ROWS = 5000;

export interface ReplayFrame {
  /** The screen and `rowsAbove` rows above it, as physical rows with an absolute cursor. */
  frame: string;
  /** Whether the CLI last hid its cursor, which a frame (no terminal modes) does not carry. */
  cursorHidden: boolean;
  /** How many rows have scrolled above the screen so far (the buffer's base row). */
  scrolledRows: number;
  /** Whether the CLI is on its alternate screen, which has no rows above it. */
  alternate: boolean;
  /** Whether the CLI cleared the rows above its screen since the last frame was taken. */
  historyCleared: boolean;
}

export interface ReplayEmulator {
  write(data: string): Promise<void>;
  frame(rowsAbove: number): ReplayFrame;
  dispose(): void;
}

export function createReplayEmulator(cols: number, rows: number): ReplayEmulator {
  // Never opened: the parser and the buffer run without a renderer or a DOM.
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: EMULATOR_SCROLLBACK_ROWS });
  activateUnicode11(terminal);
  let cursorHidden = false;
  let historyCleared = false;
  return {
    write(data: string): Promise<void> {
      CURSOR_VISIBILITY.lastIndex = 0;
      for (let match = CURSOR_VISIBILITY.exec(data); match !== null; match = CURSOR_VISIBILITY.exec(data)) {
        cursorHidden = match[1] === 'l';
      }
      if (data.includes(CLEAR_SCROLLBACK)) historyCleared = true;
      return new Promise((resolve) => terminal.write(data, () => resolve()));
    },
    frame(rowsAbove: number): ReplayFrame {
      const buffer = terminal.buffer.active;
      const snapshot = {
        frame: serializePhysicalRows(terminal, { scrollback: rowsAbove }),
        cursorHidden,
        scrolledRows: terminal.buffer.normal.baseY,
        alternate: buffer.type === 'alternate',
        historyCleared,
      };
      historyCleared = false;
      return snapshot;
    },
    dispose(): void {
      terminal.dispose();
    },
  };
}
