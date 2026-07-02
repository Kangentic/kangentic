// Runtime bridge between a live xterm `Terminal` and the pure block-detection
// core in `terminal-blocks.ts`. This is the only place that reads the xterm
// buffer's cell attributes and does pixel-to-row hit testing; the detection and
// extraction logic itself stays pure and DOM-free for unit testing.
import type { Terminal, IBufferCell, IBufferLine } from '@xterm/xterm';
import {
  findBlockAt,
  extractBlockContent,
  cleanSelectionLines,
  BAR_GLYPHS,
  MIN_BOX_RUN_CELLS,
  MAX_BOX_RUN_START_COLUMN,
  type BlockLineFacts,
  type BlockLineSource,
  type BlockRange,
  type BlockKind,
} from './terminal-blocks';

// Minimal shape of xterm's private render-service dimensions, accessed the same
// way the custom FitAddon does (`src/renderer/addons/fit-addon.ts`). xterm does
// not expose cell dimensions publicly.
interface XtermRenderCore {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width?: number; height?: number } } };
    };
  };
}

function foregroundKey(cell: IBufferCell): string {
  if (cell.isFgDefault()) return 'def';
  if (cell.isFgRGB()) return `rgb:${cell.getFgColor()}`;
  if (cell.isFgPalette()) return `p:${cell.getFgColor()}`;
  return `o:${cell.getFgColor()}`;
}

function backgroundKey(cell: IBufferCell): string {
  if (cell.isBgRGB()) return `rgb:${cell.getBgColor()}`;
  if (cell.isBgPalette()) return `p:${cell.getBgColor()}`;
  return `o:${cell.getBgColor()}`;
}

/** Classify one buffer line into the facts the pure detector needs. */
function classifyLine(line: IBufferLine, cols: number, reusableCell: IBufferCell): {
  quoteBar: { column: number; fgKey: string } | null;
  bgRun: { key: string; startColumn: number; endColumn: number } | null;
  hasDefaultFg: boolean;
} {
  let quoteBar: { column: number; fgKey: string } | null = null;
  let firstNonSpaceSeen = false;
  let hasDefaultFg = false;

  let bgRun: { key: string; startColumn: number; endColumn: number } | null = null;
  let runKey = 'def';
  let runStart = -1;
  let runLength = 0;

  const commitRun = (): void => {
    if (!bgRun && runKey !== 'def' && runLength >= MIN_BOX_RUN_CELLS && runStart <= MAX_BOX_RUN_START_COLUMN) {
      bgRun = { key: runKey, startColumn: runStart, endColumn: runStart + runLength };
    }
  };

  const limit = Math.min(line.length, cols);
  for (let x = 0; x < limit; x += 1) {
    const cell = line.getCell(x, reusableCell);
    if (!cell) continue;

    if (cell.getWidth() !== 0) {
      const chars = cell.getChars();
      if (chars !== '' && chars !== ' ') {
        if (cell.isFgDefault()) hasDefaultFg = true;
        if (!firstNonSpaceSeen) {
          firstNonSpaceSeen = true;
          if (BAR_GLYPHS.has(chars) && !cell.isFgDefault()) {
            quoteBar = { column: x, fgKey: foregroundKey(cell) };
          }
        }
      }
    }

    if (!cell.isBgDefault()) {
      const key = backgroundKey(cell);
      if (key === runKey) {
        runLength += 1;
      } else {
        commitRun();
        runKey = key;
        runStart = x;
        runLength = 1;
      }
    } else if (runKey !== 'def') {
      commitRun();
      runKey = 'def';
      runLength = 0;
    }
  }
  commitRun();

  return { quoteBar, bgRun, hasDefaultFg };
}

/** Wrap a live terminal's active buffer as a pure `BlockLineSource`. */
export function createBufferLineSource(terminal: Terminal): BlockLineSource {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const reusableCell = buffer.getNullCell();

  return {
    length: buffer.length,
    cols,
    getLine(y: number): BlockLineFacts | undefined {
      const line = buffer.getLine(y);
      if (!line) return undefined;
      const { quoteBar, bgRun, hasDefaultFg } = classifyLine(line, cols, reusableCell);
      return {
        isWrapped: line.isWrapped,
        quoteBar,
        bgRun,
        hasDefaultFg,
        text(startColumn = 0, endColumn?: number): string {
          // Re-fetch by index so the returned facts never hold a stale line ref
          // (xterm warns getLine results are only valid until the next update).
          const fresh = buffer.getLine(y);
          return fresh ? fresh.translateToString(false, startColumn, endColumn) : '';
        },
      };
    },
  };
}

/** Read xterm's CSS cell dimensions, or null if the render service is not ready. */
export function readCellDimensions(terminal: Terminal): { width: number; height: number } | null {
  const core = (terminal as unknown as XtermRenderCore)._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (!cell || !cell.width || !cell.height) return null;
  return { width: cell.width, height: cell.height };
}

/** The `.xterm-screen` element's client rect, or null when unavailable. */
export function getScreenRect(terminal: Terminal): DOMRect | null {
  const screen = terminal.element?.querySelector('.xterm-screen');
  return screen ? screen.getBoundingClientRect() : null;
}

/**
 * Map client (viewport) coordinates to an absolute buffer row, or null when the
 * point is outside the terminal's screen area.
 */
export function pixelToBufferRow(terminal: Terminal, clientX: number, clientY: number): number | null {
  const rect = getScreenRect(terminal);
  if (!rect) return null;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }
  const dimensions = readCellDimensions(terminal);
  if (!dimensions) return null;
  const rowInViewport = Math.floor((clientY - rect.top) / dimensions.height);
  const buffer = terminal.buffer.active;
  const absoluteRow = buffer.viewportY + rowInViewport;
  return Math.max(0, Math.min(absoluteRow, buffer.length - 1));
}

/** Find the block under a client point (hit test + expansion), or null. */
export function findBlockAtPoint(terminal: Terminal, clientX: number, clientY: number): BlockRange | null {
  const row = pixelToBufferRow(terminal, clientX, clientY);
  if (row == null) return null;
  return findBlockAt(createBufferLineSource(terminal), row);
}

/** The kind of block under a client point, or null. Used by the hit-test probe. */
export function blockKindAtPoint(terminal: Terminal, clientX: number, clientY: number): BlockKind | null {
  return findBlockAtPoint(terminal, clientX, clientY)?.kind ?? null;
}

/** Extract the clean content of the block containing an absolute buffer row. */
export function extractBlockContentAt(
  terminal: Terminal,
  bufferRow: number,
): { kind: BlockKind; content: string; range: BlockRange } | null {
  const source = createBufferLineSource(terminal);
  const range = findBlockAt(source, bufferRow);
  if (!range) return null;
  return { kind: range.kind, content: extractBlockContent(source, range), range };
}

/** A block's pixel rectangle relative to the `.xterm-screen` top-left, clamped to the viewport. */
export interface BlockPixelBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Compute the pixel rectangle covering a block within the visible viewport, so
 * the UI can draw a hover highlight and anchor the copy button to it. The
 * highlight always spans the full terminal width (consistent framing regardless
 * of block kind or content extent). Returns null when the block is fully
 * scrolled out of view or metrics are unavailable. Coordinates are relative to
 * the `.xterm-screen` element's top-left corner.
 */
export function getBlockPixelBounds(terminal: Terminal, range: BlockRange): BlockPixelBounds | null {
  const dimensions = readCellDimensions(terminal);
  if (!dimensions) return null;
  const viewportY = terminal.buffer.active.viewportY;
  const maxRow = terminal.rows - 1;

  const topRow = Math.max(range.startY - viewportY, 0);
  const bottomRow = Math.min(range.endY - viewportY, maxRow);
  if (bottomRow < 0 || topRow > maxRow) return null;

  return {
    top: topRow * dimensions.height,
    left: 0,
    width: terminal.cols * dimensions.width,
    height: (bottomRow - topRow + 1) * dimensions.height,
  };
}

/**
 * Clean the current terminal selection using buffer attributes (stripping quote
 * decoration from decorated rows). Falls back to `fallback()` when there is no
 * selection or the buffer read throws, so behavior is never worse than the
 * legacy string-based clean. The fallback is injected to avoid a circular import
 * with `terminal-clipboard.ts`.
 */
export function cleanTerminalSelection(terminal: Terminal, fallback: () => string): string {
  try {
    const range = terminal.getSelectionPosition();
    if (!range) return fallback();
    return cleanSelectionLines(createBufferLineSource(terminal), range);
  } catch {
    return fallback();
  }
}
