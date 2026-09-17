/**
 * Serialize a headless xterm screen as PHYSICAL rows, one per buffer row, for the web demo.
 *
 * @xterm/addon-serialize joins a row onto the row before it when the buffer marks it wrapped: it
 * emits no line break there, only a cursor-forward to the row's end, and relies on the terminal
 * wrapping at the same width when the bytes are replayed. That join is faithful at exactly the
 * recorded width and at no other. The demo replays a recording's frames into whatever grid the
 * visitor's terminal has (demo/README.md, "Live replay"), and on a grid 20 columns wider every
 * joined continuation spilled its first 20 characters onto the previous visual row and started
 * its own row 20 characters in, which is the cut left edge and the phantom sidebar of task #673.
 *
 * This serializer writes every buffer row as its own row, joined with \r\n, so a row can never
 * spill into another whatever the mounted width. Three more things differ from the addon, each
 * for the applier that fits these frames (tests/captures/helpers/demo-dataset.ts):
 *
 * - Each row is self-contained: its style diff starts from the default attributes and the row
 *   ends with a reset when it set any. The addon diffs each cell against the previous cell
 *   ACROSS rows, so clipping a row's tail at a narrower grid would leave the next row's opening
 *   diff assuming a style that was never written.
 * - The cursor is one absolute CUP at the end, screen-relative for the recorded grid, so a still
 *   at that grid lands it where the CLI left it, and the applier can recompute it for a grid with
 *   another row count. The addon's relative moves are measured from the last content cell, which
 *   moves the moment a row is clipped.
 * - No terminal modes. The addon re-emitted bracketed paste, focus reporting and any-event mouse
 *   tracking with every frame; re-arming mouse tracking four times a second is what stopped the
 *   wheel scrolling a Copilot frame in the bottom panel. Trailing default-styled spaces (the
 *   padding ConPTY writes to every row) are dropped here rather than in a loader pass.
 *
 * An alternate-screen session serializes the alternate buffer only, behind the switch that
 * enters it. The cell walk and the SGR diff mirror the addon's (MIT, xterm.js authors) over the
 * public IBufferCell getters, so a cell paints the same colour whichever serializer wrote it.
 *
 * Shared by scripts/lib/demo-replay-timelines.js (frame timelines), scripts/capture-agent-scrollback.js
 * (the final frame and the open frame of a new recording) and scripts/backfill-demo-timelines.mjs
 * (the recordings already on disk), so a backfilled recording and a fresh one agree byte for byte.
 */
'use strict';

/** Enters the alternate screen and homes the cursor: the prefix of an alt-screen frame. */
const ALT_PREFIX = '\x1b[?1049h\x1b[H';
/** The absolute cursor position every physical-row frame ends with (1-based row and column). */
const CURSOR_SUFFIX = /\x1b\[(\d+);(\d+)H$/;

function equalFg(cell, other) {
  return cell.getFgColorMode() === other.getFgColorMode() && cell.getFgColor() === other.getFgColor();
}

function equalBg(cell, other) {
  return cell.getBgColorMode() === other.getBgColorMode() && cell.getBgColor() === other.getBgColor();
}

function equalFlags(cell, other) {
  return cell.isInverse() === other.isInverse()
    && cell.isBold() === other.isBold()
    && cell.isUnderline() === other.isUnderline()
    && cell.isOverline() === other.isOverline()
    && cell.isBlink() === other.isBlink()
    && cell.isInvisible() === other.isInvisible()
    && cell.isItalic() === other.isItalic()
    && cell.isDim() === other.isDim()
    && cell.isStrikethrough() === other.isStrikethrough();
}

/** The SGR parameters that take the terminal from `previous` to `cell`, as the addon computes them. */
function diffStyle(cell, previous) {
  const parameters = [];
  const fgChanged = !equalFg(cell, previous);
  const bgChanged = !equalBg(cell, previous);
  const flagsChanged = !equalFlags(cell, previous);
  if (!fgChanged && !bgChanged && !flagsChanged) return parameters;
  if (cell.isAttributeDefault()) {
    if (!previous.isAttributeDefault()) parameters.push(0);
    return parameters;
  }
  if (fgChanged) {
    const color = cell.getFgColor();
    if (cell.isFgRGB()) parameters.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    else if (cell.isFgPalette()) {
      if (color >= 16) parameters.push(38, 5, color);
      else parameters.push(color & 8 ? 90 + (color & 7) : 30 + (color & 7));
    } else parameters.push(39);
  }
  if (bgChanged) {
    const color = cell.getBgColor();
    if (cell.isBgRGB()) parameters.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    else if (cell.isBgPalette()) {
      if (color >= 16) parameters.push(48, 5, color);
      else parameters.push(color & 8 ? 100 + (color & 7) : 40 + (color & 7));
    } else parameters.push(49);
  }
  if (flagsChanged) {
    if (cell.isInverse() !== previous.isInverse()) parameters.push(cell.isInverse() ? 7 : 27);
    if (cell.isBold() !== previous.isBold()) parameters.push(cell.isBold() ? 1 : 22);
    if (cell.isUnderline() !== previous.isUnderline()) parameters.push(cell.isUnderline() ? 4 : 24);
    if (cell.isOverline() !== previous.isOverline()) parameters.push(cell.isOverline() ? 53 : 55);
    if (cell.isBlink() !== previous.isBlink()) parameters.push(cell.isBlink() ? 5 : 25);
    if (cell.isInvisible() !== previous.isInvisible()) parameters.push(cell.isInvisible() ? 8 : 28);
    if (cell.isItalic() !== previous.isItalic()) parameters.push(cell.isItalic() ? 3 : 23);
    if (cell.isDim() !== previous.isDim()) parameters.push(cell.isDim() ? 2 : 22);
    if (cell.isStrikethrough() !== previous.isStrikethrough()) parameters.push(cell.isStrikethrough() ? 9 : 29);
  }
  return parameters;
}

/**
 * One buffer row as a self-contained string: styles from the default attributes, null cells as
 * cursor-forward gaps (or an erase plus a forward when the current background paints), a trailing
 * styled pad as an erase, trailing default spaces and nulls dropped, a reset at the end when any
 * style was set. Returns '' for a row that paints nothing.
 */
function serializeRow(line, buffer) {
  // Two scratch cells, alternated so the style reference never aliases the cell being read.
  const scratch = [buffer.getNullCell(), buffer.getNullCell()];
  const nullCell = buffer.getNullCell();
  let style = buffer.getNullCell();
  let styleIsDefault = true;
  let row = '';
  // Runs of cells that paint nothing under the current style, in order: default-styled spaces
  // (ConPTY pads every row with them) and null cells. Written out only when content follows;
  // a run left at the row's end is dropped, unless it is a null run under a painting background.
  const pending = [];
  const hold = (kind, count) => {
    const last = pending[pending.length - 1];
    if (last && last.kind === kind) last.count += count;
    else pending.push({ kind, count });
  };
  const flushPending = () => {
    for (const run of pending) {
      if (run.kind === 'spaces') row += ' '.repeat(run.count);
      // A gap with a painting background is erased to that background first; the addon does the
      // same, since a cursor-forward alone leaves the cells untouched.
      else row += equalBg(style, nullCell) ? `\x1b[${run.count}C` : `\x1b[${run.count}X\x1b[${run.count}C`;
    }
    pending.length = 0;
  };
  for (let column = 0; column < line.length; column++) {
    const cell = line.getCell(column, scratch[column % 2]);
    if (!cell || cell.getWidth() === 0) continue; // the placeholder after a wide glyph
    const chars = cell.getChars();
    const isEmpty = chars === '';
    if (chars === ' ' && cell.isAttributeDefault()) {
      if (!styleIsDefault) {
        // Whatever was held under the old style is written under it, then the style ends.
        flushPending();
        row += '\x1b[0m';
        style = buffer.getNullCell();
        styleIsDefault = true;
      }
      hold('spaces', 1);
      continue;
    }
    const parameters = diffStyle(cell, style);
    const styleChanged = isEmpty ? !equalBg(style, cell) : parameters.length > 0;
    if (styleChanged) {
      flushPending();
      row += `\x1b[${parameters.length > 0 ? parameters.join(';') : '0'}m`;
      style = line.getCell(column, buffer.getNullCell());
      styleIsDefault = style.isAttributeDefault();
    }
    if (isEmpty) {
      hold('nulls', cell.getWidth());
      continue;
    }
    flushPending();
    row += chars;
  }
  // A trailing null run under a painting background is content (a diff row's colour band).
  const last = pending[pending.length - 1];
  if (last && last.kind === 'nulls' && !equalBg(style, nullCell)) {
    pending.pop();
    flushPending();
    row += `\x1b[${last.count}X`;
  }
  if (!styleIsDefault) row += '\x1b[0m';
  return row;
}

/**
 * The active buffer as physical rows, with an absolute cursor.
 *
 * `scrollback` is the number of scrollback lines to keep above the screen (the addon's meaning);
 * undefined keeps every line. The alternate buffer has no scrollback, so an alt-screen session
 * serializes its screen behind ALT_PREFIX.
 *
 * Trailing rows below both the last content and the cursor are dropped, but only when the whole
 * range fits on the screen (the addon's own fixup): with scrollback above the screen every row
 * is kept, since the rows below the cursor are what scroll the screen into its recorded place.
 */
function serializePhysicalRows(terminal, options) {
  const buffer = terminal.buffer.active;
  const alt = buffer.type === 'alternate';
  const scrollback = alt ? undefined : (options && options.scrollback);
  const totalRows = buffer.length;
  const keep = scrollback === undefined ? totalRows : Math.max(0, Math.min(scrollback + terminal.rows, totalRows));
  const firstRow = totalRows - keep;
  const rows = [];
  let lastContentRow = -1;
  for (let y = firstRow; y < totalRows; y++) {
    const line = buffer.getLine(y);
    const row = line ? serializeRow(line, buffer) : '';
    rows.push(row);
    if (row.length > 0) lastContentRow = y - firstRow;
  }
  const cursorRow = buffer.baseY + buffer.cursorY - firstRow;
  if (keep <= terminal.rows) rows.length = Math.max(0, Math.max(lastContentRow, cursorRow) + 1);
  const cursorCol = Math.max(0, Math.min(terminal.cols - 1, buffer.cursorX));
  const screenRow = cursorRow - Math.max(0, rows.length - terminal.rows);
  return `${alt ? ALT_PREFIX : ''}${rows.join('\r\n')}\x1b[${Math.max(0, screenRow) + 1};${cursorCol + 1}H`;
}

/**
 * The inverse, for the tests and the loader: the alt flag, the rows, and the cursor as the
 * suffix names it (0-based). A string without the suffix is not a physical-row frame and yields
 * a null cursor, which is how a recording that predates this serializer is told apart.
 */
function parsePhysicalFrame(text) {
  const alt = text.startsWith(ALT_PREFIX);
  const body = alt ? text.slice(ALT_PREFIX.length) : text;
  const match = CURSOR_SUFFIX.exec(body);
  const rows = (match ? body.slice(0, match.index) : body).split('\r\n');
  return { alt, rows, cursor: match ? { row: Number(match[1]) - 1, col: Number(match[2]) - 1 } : null };
}

module.exports = { ALT_PREFIX, CURSOR_SUFFIX, serializePhysicalRows, parsePhysicalFrame, diffStyle };
