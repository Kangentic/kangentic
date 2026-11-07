/**
 * Reads a row and the rows that continue it as one string, and maps a string index
 * back to the cell it came from.
 *
 * A string index is not a column. A wide glyph takes two cells and an emoji two
 * code units, a combining mark adds code units to one cell, and an empty cell
 * holds nothing at all. So the map is built cell by cell from the widths the
 * terminal itself assigned, which are Unicode 11 widths (`xterm-unicode11-parity.md`).
 * The second cell of a wide glyph has width 0 and contributes no text.
 *
 * Two things continue a row. A soft wrap is `isWrapped`. A TUI's own wrap is not:
 * Claude Code, Codex, Copilot, Grok and the rest draw every row themselves, usually
 * indented, so xterm sees separate lines and a URL split across them would open cut
 * short. No agent has to cooperate for that to work: `continuesOnNextRow` reads the
 * shape off the screen, and an agent's own OSC 8 link still wins an overlap.
 */

/** The part of xterm's buffer API this reads. Both `@xterm/xterm` and `@xterm/headless` fit it. */
export interface TerminalCellLike {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(column: number): TerminalCellLike | undefined;
}

export interface TerminalBufferLike {
  getLine(row: number): TerminalLineLike | undefined;
}

interface CellOrigin {
  /** 0-based buffer row. */
  row: number;
  /** 0-based column. */
  column: number;
  width: number;
}

export interface LogicalLine {
  text: string;
  /** One entry per UTF-16 code unit of `text`. */
  cellOf: CellOrigin[];
}

/** 1-based and inclusive, as xterm's `IBufferRange` is. */
export interface CellRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

interface RowCell {
  chars: string;
  column: number;
  width: number;
}

/**
 * How far a logical line reaches each way from the hovered row. An agent TUI pads
 * every row to the full width and reaches the next by autowrap, so a whole screen
 * can read as one wrapped line.
 */
const MAX_WRAPPED_ROWS_EACH_WAY = 4;
/**
 * A TUI's text column can stop short of the grid or its own border: Claude Code's
 * prompt echo wraps one cell before the edge, and Copilot's wraps seven cells before
 * its panel border. So the margin is wide, and `continuesOnNextRow` pairs it with the
 * test that a wrap has to pass: the word below must not have fit in the gap.
 */
const WRAP_MARGIN_CELLS = 12;
/** The indent a TUI puts on a wrapped row. A deeper one is a different block of text. */
const MAX_CONTINUATION_INDENT = 8;
const LINK_CHARACTER = /[A-Za-z0-9\-._~:/\\?#[\]@!$&'()*+,;=%]/;

function readRow(line: TerminalLineLike): RowCell[] {
  const cells: RowCell[] = [];
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell) continue;
    const width = cell.getWidth();
    if (width === 0) continue;
    cells.push({ chars: cell.getChars() || ' ', column, width });
  }
  return cells;
}

/** Blank, or a line a TUI draws around its text, which is never part of a link. */
function isFrame(cell: RowCell): boolean {
  return cell.chars === ' ' || /^[─-╿]$/.test(cell.chars);
}

function firstInk(cells: readonly RowCell[]): number {
  return cells.findIndex((cell) => !isFrame(cell));
}

function lastInk(cells: readonly RowCell[]): number {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (!isFrame(cells[index])) return index;
  }
  return -1;
}

/** Where a row's text area ends: the grid's edge, or a border drawn at the right of it. */
function textAreaEnd(cells: readonly RowCell[], columns: number): number {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index].chars === ' ') continue;
    return isFrame(cells[index]) ? cells[index].column : columns;
  }
  return columns;
}

/**
 * Whether a TUI wrapped a link from this row onto the next. The row's text runs close
 * to its edge, its last word carries a path separator, and the next row opens, at a
 * small indent, with a word that could not have fit in the gap left on this row. That
 * last test is what tells a break in the middle of a long word from a line that simply
 * ends in a URL. The separator keeps ordinary wrapped prose apart, since two wrapped
 * words must not read as one.
 */
function continuesOnNextRow(buffer: TerminalBufferLike, row: number, columns: number, rowsBack = 0): boolean {
  const line = buffer.getLine(row);
  const nextLine = buffer.getLine(row + 1);
  if (!line || !nextLine || nextLine.isWrapped) return false;

  const cells = readRow(line);
  const last = lastInk(cells);
  if (last === -1) return false;
  const gap = textAreaEnd(cells, columns) - (cells[last].column + cells[last].width);
  if (gap > WRAP_MARGIN_CELLS) return false;
  let wordStart = last;
  while (wordStart > 0 && !isFrame(cells[wordStart - 1])) wordStart -= 1;
  const holdsSeparator = cells.slice(wordStart, last + 1).some((cell) => cell.chars === '/' || cell.chars === '\\');
  // A middle row of a long URL may hold no separator of its own. It counts when the
  // whole row is that one word, carried on from the row above.
  const isWholeRowOfALink = !holdsSeparator
    && wordStart === firstInk(cells)
    && row > 0
    && rowsBack < MAX_WRAPPED_ROWS_EACH_WAY
    && continuesOnNextRow(buffer, row - 1, columns, rowsBack + 1);
  if (!holdsSeparator && !isWholeRowOfALink) return false;

  const nextCells = readRow(nextLine);
  const first = firstInk(nextCells);
  if (first === -1 || nextCells[first].column > MAX_CONTINUATION_INDENT) return false;
  if (!LINK_CHARACTER.test(nextCells[first].chars)) return false;
  let nextWordLength = 0;
  for (let index = first; index < nextCells.length && !isFrame(nextCells[index]); index += 1) nextWordLength += 1;
  return nextWordLength > gap;
}

export function readLogicalLine(buffer: TerminalBufferLike, row: number, columns: number): LogicalLine {
  const joinsNext = (fromRow: number): boolean => buffer.getLine(fromRow + 1)?.isWrapped === true || continuesOnNextRow(buffer, fromRow, columns);

  let firstRow = row;
  while (row - firstRow < MAX_WRAPPED_ROWS_EACH_WAY && firstRow > 0 && joinsNext(firstRow - 1)) firstRow -= 1;
  let lastRow = row;
  while (lastRow - row < MAX_WRAPPED_ROWS_EACH_WAY && joinsNext(lastRow)) lastRow += 1;

  const parts: string[] = [];
  const cellOf: CellOrigin[] = [];
  for (let currentRow = firstRow; currentRow <= lastRow; currentRow += 1) {
    const line = buffer.getLine(currentRow);
    if (!line) continue;
    const cells = readRow(line);
    // A TUI's wrap keeps neither the padding at the end of a row nor the indent at
    // the start of the next. A soft wrap has neither to drop.
    const fromTuiWrap = currentRow > firstRow && !line.isWrapped;
    const intoTuiWrap = currentRow < lastRow && buffer.getLine(currentRow + 1)?.isWrapped !== true;
    const start = fromTuiWrap ? Math.max(firstInk(cells), 0) : 0;
    const end = intoTuiWrap ? lastInk(cells) + 1 : cells.length;
    for (const cell of cells.slice(start, end)) {
      parts.push(cell.chars);
      for (let unit = 0; unit < cell.chars.length; unit += 1) {
        cellOf.push({ row: currentRow, column: cell.column, width: cell.width });
      }
    }
  }
  return { text: parts.join(''), cellOf };
}

/** The cells a half-open string range covers, or null for a range outside the text. */
export function cellRangeOf(line: LogicalLine, start: number, end: number): CellRange | null {
  const first = line.cellOf[start];
  const last = line.cellOf[end - 1];
  if (!first || !last) return null;
  return {
    start: { x: first.column + 1, y: first.row + 1 },
    // column is 0-based and x is 1-based, so column + width is the last cell a
    // wide glyph covers.
    end: { x: last.column + last.width, y: last.row + 1 },
  };
}
