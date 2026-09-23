/**
 * The web demo's frame applier (`fitFrameToGrid` and its helpers inside buildDemoPreConfig's
 * generated script, tests/captures/helpers/demo-dataset.ts) fits a physical-row frame to the grid
 * a visitor's terminal actually has. This file extracts those functions from the GENERATED seed,
 * not from the TypeScript source: the seed is a template literal, so its `\\x1b` escapes only
 * become escape characters once the template has been evaluated, and a test that read the .ts
 * text would run a different program from the one the page runs.
 *
 * The two recordings from task #673 are replayed through the serializer and then fitted to the
 * grids that broke: 20 columns wider (the take-control dialog on a 1920 by 1080 display, where
 * every wrapped row spilled its first 20 characters onto the row above and Copilot's right
 * border became a striped block), narrower, and the board's 15-row bottom panel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';
import { parsePhysicalFrame, serializePhysicalRows } from '../../scripts/lib/demo-frame-serializer.js';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo');
const REPAINT = '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H';

interface Grid { cols: number; rows: number }
type FitFrameToGrid = (frame: string, grid: Grid, recorded: Grid | number) => string;
type FitRow = (row: string, cols: number, recordedCols?: number) => string;
interface Applier {
  fitFrameToGrid: FitFrameToGrid;
  fitRow: FitRow;
  cellWidth: (codepoint: number) => number;
  /** The seed's VERTICAL_EDGE_GLYPHS and HORIZONTAL_RULE_GLYPHS, for the sweep's pin below. */
  edgeGlyphs: string;
  ruleGlyphs: string;
}

/**
 * The applier's source, from `var FRAME_SEQUENCE` through the end of `fitFrameToGrid`, lifted out
 * of the generated script and built over an injected `cellWidths`.
 */
function extractApplier(): Applier {
  const script = buildDemoPreConfig({ scrollback: loadDemoScrollback(), cellWidths: buildCellWidthTable() });
  const start = script.indexOf('var FRAME_SEQUENCE');
  if (start === -1) throw new Error('var FRAME_SEQUENCE not found in the generated seed');
  const marker = 'function fitFrameToGrid(';
  const functionStart = script.indexOf(marker, start);
  if (functionStart === -1) throw new Error('function fitFrameToGrid not found in the generated seed');
  const open = script.indexOf('{', functionStart);
  let depth = 0;
  let end = -1;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  if (end === -1) throw new Error('unbalanced fitFrameToGrid in the generated seed');
  const factory = new Function('cellWidths', `${script.slice(start, end)}\nreturn { fitFrameToGrid, fitRow, cellWidth, edgeGlyphs: VERTICAL_EDGE_GLYPHS, ruleGlyphs: HORIZONTAL_RULE_GLYPHS };`) as (table: unknown) => Applier;
  return factory(buildCellWidthTable());
}

const applier = extractApplier();

function createTerminal(cols: number, rows: number): Terminal {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()));
}

function rowText(terminal: Terminal, screenRow: number): string {
  const buffer = terminal.buffer.active;
  return buffer.getLine(buffer.baseY + screenRow)?.translateToString(true).replace(/\s+$/, '') ?? '';
}

function wrappedLineCount(terminal: Terminal): number {
  const buffer = terminal.buffer.active;
  let count = 0;
  for (let row = 0; row < buffer.length; row++) {
    if (buffer.getLine(row)?.isWrapped) count += 1;
  }
  return count;
}

describe('fitRow', () => {
  it('leaves a row that already fits alone', () => {
    expect(applier.fitRow('abc', 3)).toBe('abc');
    expect(applier.fitRow('a\x1b[3Cb', 5)).toBe('a\x1b[3Cb');
  });

  it('cuts a longer row at the edge and resets its style', () => {
    expect(applier.fitRow('\x1b[31mabcdef\x1b[0m', 4)).toBe('\x1b[31mabcd\x1b[0m');
  });

  it('never cuts inside a wide glyph', () => {
    expect(applier.fitRow('ab✅cd', 3)).toBe('ab\x1b[0m');
    expect(applier.fitRow('ab✅cd', 4)).toBe('ab✅\x1b[0m');
    expect(applier.fitRow('ab✅cd', 6)).toBe('ab✅cd');
  });

  it('pulls a right-aligned tail in by shrinking the gap before it', () => {
    expect(applier.fitRow('ab\x1b[10Ccd', 8)).toBe('ab\x1b[4Ccd');
    // The gap floors at one cell; what still overruns is cut.
    expect(applier.fitRow('abcdef\x1b[3Cghij', 8)).toBe('abcdef\x1b[1Cg\x1b[0m');
  });

  it('clamps an erase to the room left and drops one past the edge', () => {
    expect(applier.fitRow('\x1b[44m\x1b[10X', 4)).toBe('\x1b[44m\x1b[4X');
    expect(applier.fitRow('abcd\x1b[3X\x1b[3Cef', 4)).toBe('abcd\x1b[0m');
  });

  it('extends a horizontal rule to a wider edge and nothing else', () => {
    expect(applier.fitRow('──', 5)).toBe('─────');
    expect(applier.fitRow('▄▄\x1b[0m', 4)).toBe('▄▄▄▄\x1b[0m');
    // A vertical bar extended sideways is a stripe: Copilot's right border stays one cell.
    expect(applier.fitRow('\x1b[153C┃', 174)).toBe('\x1b[153C┃');
    expect(applier.fitRow('── 5. Chat about this', 40)).toBe('── 5. Chat about this');
    // A gap is never grown either.
    expect(applier.fitRow('│\x1b[1CShould reconnection', 60)).toBe('│\x1b[1CShould reconnection');
  });

  it('moves a right-hand scrollbar to a wider edge, growing the gap before it', () => {
    // Recorded at 10: text, a gap, the scrollbar on the last column. Four wider, the gap takes them.
    expect(applier.fitRow('ab\x1b[7C┃', 14, 10)).toBe('ab\x1b[11C┃');
    // Plain spaces before it: blank cells go in where the spaces start, in the style in force.
    expect(applier.fitRow('abc      ┃', 14, 10)).toBe('abc\x1b[4X\x1b[4C      ┃');
  });

  it('widens a box before its right side and keeps its left side where it was', () => {
    // A box row, then one space, then a scrollbar: the box's two sides stay a box.
    expect(applier.fitRow('│\x1b[6C│ ┃', 14, 10)).toBe('│\x1b[10C│ ┃');
    // Its bottom edge runs on to the corner.
    expect(applier.fitRow('╰──────╯ ┃', 14, 10)).toBe('╰──────────╯ ┃');
    // A bar inside a scrollbar's column runs on, and the scrollbar moves out.
    expect(applier.fitRow(' ▄▄▄▄▄▄▄ ┃', 14, 10)).toBe(' ▄▄▄▄▄▄▄▄▄▄▄ ┃');
    // A box the CLI drew two columns short of its edge (Copilot's welcome box) widens the same
    // way, sides and corners together, keeping its padding.
    expect(applier.fitRow('│ ab     │', 16, 12)).toBe('│ ab\x1b[4X\x1b[4C     │');
    expect(applier.fitRow('╭────────╮', 16, 12)).toBe('╭────────────╮');
  });

  it('grows a background band that reaches the edge, and leaves one that stops short alone', () => {
    // An input band: one cell, then an erase to the edge in the band's background.
    expect(applier.fitRow('\x1b[48;5;236m \x1b[9X\x1b[0m', 14, 10)).toBe('\x1b[48;5;236m \x1b[13X\x1b[0m');
    // A diff line's band, erased and stepped over, a few columns short of the edge as Claude pads it.
    expect(applier.fitRow('\x1b[48;5;22m+ a\x1b[4X\x1b[4C\x1b[0m', 14, 10)).toBe('\x1b[48;5;22m+ a\x1b[8X\x1b[8C\x1b[0m');
    // A band that ends far short of the edge is part of the content, not the edge.
    expect(applier.fitRow('\x1b[48;5;22m+ a\x1b[2X\x1b[2C\x1b[0m', 40, 30)).toBe('\x1b[48;5;22m+ a\x1b[2X\x1b[2C\x1b[0m');
  });

  it('runs a rule and a panel background on to the new edge, only from rows that reached the old one', () => {
    expect(applier.fitRow('──────────', 14, 10)).toBe('──────────────');
    expect(applier.fitRow('\x1b[48;5;236mab        \x1b[0m', 14, 10)).toBe('\x1b[48;5;236mab            \x1b[0m');
    // A short rule, a markdown divider say, is content: it stays its length.
    expect(applier.fitRow('────', 40, 30)).toBe('────');
    // Plain text that reached the edge is prose the CLI wrapped there: nothing is added.
    expect(applier.fitRow('abcdefghij', 14, 10)).toBe('abcdefghij');
  });

  it('moves right-aligned text out with its gap, and never pulls prose apart', () => {
    // A footer's right-aligned item after a wide cursor-forward, ending a column short as recorded.
    expect(applier.fitRow('mode\x1b[4C/rc', 14, 12)).toBe('mode\x1b[6C/rc');
    // A reset and a space between the gap and the item still read as one gap (Copilot's
    // "Session: 0.88 AIC used", a column short of its edge).
    expect(applier.fitRow('main\x1b[3C\x1b[0m \x1b[90mSession\x1b[0m', 19, 16)).toBe('main\x1b[6C\x1b[0m \x1b[90mSession\x1b[0m');
    // Claude's footer tail is several styled words with one-cell steps between them, two columns
    // short of the edge: the wide gap before the whole tail takes the extra cells.
    expect(applier.fitRow('mode\x1b[1Cagent   \x1b[10C◐\x1b[1Cmedium\x1b[1C·\x1b[1C/effort', 47, 43))
      .toBe('mode\x1b[1Cagent   \x1b[14C◐\x1b[1Cmedium\x1b[1C·\x1b[1C/effort');
    // One word alone after a leading gap is still right-aligned ("/rc" on its own row).
    expect(applier.fitRow('\x1b[9C/rc', 18, 14)).toBe('\x1b[13C/rc');
    // Claude writes one-cell cursor-forwards between words: prose, left as it was.
    expect(applier.fitRow('the\x1b[1Cquick\x1b[1Cbrown', 20, 15)).toBe('the\x1b[1Cquick\x1b[1Cbrown');
    // Indented prose that ends inside the padding is not a tail: a leading gap before more than
    // one word is indentation.
    expect(applier.fitRow('     some indented prose', 30, 25)).toBe('     some indented prose');
    // A Codex search hit: code after the gap its indentation leaves, running most of the row. The
    // old rule moved the whole row right; it stays as recorded.
    expect(applier.fitRow('  f:1:     await a.b(c, d, e, f)', 40, 33)).toBe('  f:1:     await a.b(c, d, e, f)');
    // A row that runs to the edge itself is content the CLI cut or wrapped there.
    expect(applier.fitRow('ab      cd', 14, 10)).toBe('ab      cd');
  });

  it('keeps right-aligned text against a border or scrollbar, and a truncated line where it was', () => {
    // Copilot's "10s ┃": the time a cell from the scrollbar; the gap before the time grows, so
    // the time stays against the scrollbar at the new edge.
    expect(applier.fitRow('ab      10s ┃', 17, 13)).toBe('ab          10s ┃');
    // Gemini's edit line, cut to fit with an ellipsis a cell from its box: content, so the box
    // widens at its border as any box does.
    expect(applier.fitRow('│ a =>     bcd… │', 21, 17)).toBe('│ a =>     bcd…\x1b[4X\x1b[4C │');
    // A table's last cell with a wide gap inside is not a tail: the walk stops at the cell border.
    expect(applier.fitRow('│ a │     b │', 17, 13)).toBe('│ a │     b\x1b[4X\x1b[4C │');
  });

  it('keeps a right-edge border or scrollbar at a narrower edge, in its own style, and cuts before it', () => {
    // Padded with plain spaces: the cut used to take the border with it.
    expect(applier.fitRow('abcdef ┃', 7)).toBe('abcdef\x1b[0m┃');
    // Reached through a gap: the gap shrinks, as it always did, and the border stays last.
    expect(applier.fitRow('ab\x1b[5C┃', 6)).toBe('ab\x1b[3C┃');
    // The style the border was drawn in comes back after the cut's reset.
    expect(applier.fitRow('\x1b[90mabc   ┃', 6)).toBe('\x1b[90mabc  \x1b[0m\x1b[90m┃');
    // A box's right corner stays on the box, the rule before it gives way.
    expect(applier.fitRow('┌────┐', 4)).toBe('┌──\x1b[0m┐');
    // Only a row that ENDS in one: text after a bar is cut as before.
    expect(applier.fitRow('│abcdef', 4)).toBe('│abc\x1b[0m');
  });
});

describe('cellWidth', () => {
  it('reads the same widths as the app table for the glyphs the recordings carry', () => {
    expect(applier.cellWidth('a'.codePointAt(0) as number)).toBe(1);
    expect(applier.cellWidth('─'.codePointAt(0) as number)).toBe(1);
    expect(applier.cellWidth('┃'.codePointAt(0) as number)).toBe(1);
    expect(applier.cellWidth('✅'.codePointAt(0) as number)).toBe(2);
    expect(applier.cellWidth('中'.codePointAt(0) as number)).toBe(2);
    expect(applier.cellWidth(0x0301)).toBe(0);
    expect(applier.cellWidth(0x1f600)).toBe(2);
  });
});

describe('fitFrameToGrid on the recordings from task #673', () => {
  interface Recording { cols: number; rows: number; stream: Array<{ t: number; data: string }> }
  interface Replayed { recording: Recording; frame: string; source: Terminal }

  // Each recording is replayed once and shared: the source terminal is the reference every
  // case reads its expected rows from, so it is kept alive for the file.
  const replayed = new Map<string, Promise<Replayed>>();
  function lastFrameOf(file: string): Promise<Replayed> {
    let pending = replayed.get(file);
    if (!pending) {
      pending = (async () => {
        const recording = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as Recording;
        const source = createTerminal(recording.cols, recording.rows);
        await write(source, recording.stream.map((window) => window.data).join(''));
        return { recording, frame: serializePhysicalRows(source, { scrollback: 0 }), source };
      })();
      replayed.set(file, pending);
    }
    return pending;
  }
  afterAll(async () => {
    for (const pending of replayed.values()) (await pending).source.dispose();
  });

  async function fitInto(frame: string, recording: Recording, grid: Grid): Promise<Terminal> {
    const terminal = createTerminal(grid.cols, grid.rows);
    await write(terminal, REPAINT + applier.fitFrameToGrid(frame, grid, { cols: recording.cols, rows: recording.rows }));
    return terminal;
  }

  it('Copilot at 174 columns: no spill, no stripes, the scrollbar on the new last column', async () => {
    const { recording, frame, source } = await lastFrameOf('contoso-web-copilot-rate-limit.json');
    const fitted = await fitInto(frame, recording, { cols: 174, rows: 39 });
    expect(wrappedLineCount(fitted)).toBe(0);
    let scrollbarRows = 0;
    for (let row = 0; row < recording.rows; row++) {
      // Nothing spills, so the left of every row reads exactly as recorded; the fill goes in at
      // the right, before a border, into a gap, or onto a rule or a band.
      expect(rowText(fitted, row).slice(0, 100), `row ${row}`).toBe(rowText(source, row).slice(0, 100));
      expect(rowText(fitted, row).includes('┃┃'), `row ${row} grew a stripe: ${JSON.stringify(rowText(fitted, row))}`).toBe(false);
      const sourceEdge = source.buffer.active.getLine(source.buffer.active.baseY + row)?.getCell(recording.cols - 1);
      if (sourceEdge?.getChars() !== '┃') continue;
      scrollbarRows += 1;
      const fittedEdge = fitted.buffer.active.getLine(fitted.buffer.active.baseY + row)?.getCell(173);
      expect(fittedEdge?.getChars(), `row ${row}`).toBe('┃');
      expect(fittedEdge?.getFgColor(), `row ${row} scrollbar colour`).toBe(sourceEdge.getFgColor());
    }
    expect(scrollbarRows).toBeGreaterThanOrEqual(30);
    // The row that read "tion-path: expired windows" at its left edge in the report.
    const found = Array.from({ length: recording.rows }, (_, row) => rowText(fitted, row)).find((text) => text.includes('expiration-path'));
    expect(found).toMatch(/^\s*● I found an expiration-path bug: expired windows/);
    expect(fitted.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    expect(fitted.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
    fitted.dispose();
  }, 30_000);

  it('Claude at 174 by 35: the "finished" row stays whole and the cursor moves with the scroll', async () => {
    const { recording, frame, source } = await lastFrameOf('contoso-web-claude-websocket.json');
    const fitted = await fitInto(frame, recording, { cols: 174, rows: 35 });
    expect(wrappedLineCount(fitted)).toBe(0);
    const rows = parsePhysicalFrame(frame).rows.length;
    const scrolled = Math.max(0, rows - 35);
    for (let row = 0; row < 35; row++) {
      const expected = rowText(source, row + scrolled);
      const actual = rowText(fitted, row);
      expect(actual.startsWith(expected), `row ${row}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`).toBe(true);
    }
    const finished = Array.from({ length: 35 }, (_, row) => rowText(fitted, row)).find((text) => text.includes('finished'));
    expect(finished).toContain('● Agent "Find LiveUpdates usages" finished');
    expect(fitted.buffer.active.cursorY).toBe(source.buffer.active.cursorY - scrolled);
    expect(fitted.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
    fitted.dispose();
  }, 30_000);

  it('Copilot at 144 by 39: every row keeps its left edge, a gapped border lands on the last column', async () => {
    const { recording, frame, source } = await lastFrameOf('contoso-web-copilot-rate-limit.json');
    const fitted = await fitInto(frame, recording, { cols: 144, rows: 39 });
    expect(wrappedLineCount(fitted)).toBe(0);
    const scrolled = 0;
    for (let row = 0; row < 39; row++) {
      // Padded before slicing: a row of spaces up to a border at column 153 loses the border to
      // the cut, and the trimmed text of what is left is empty.
      const expected = rowText(source, row + scrolled).padEnd(40).slice(0, 40);
      const actual = rowText(fitted, row).padEnd(40).slice(0, 40);
      expect(actual, `row ${row}`).toBe(expected);
      expect(rowText(fitted, row).length).toBeLessThanOrEqual(144);
    }
    // " ❯ Thought for 2s" then a cursor-forward gap then the border: the gap shrank by ten.
    const thought = Array.from({ length: 39 }, (_, row) => rowText(fitted, row)).find((text) => text.includes('Thought for 2s'));
    expect(thought?.length).toBe(144);
    expect(thought?.endsWith('┃')).toBe(true);
    expect(fitted.buffer.active.cursorY).toBe(source.buffer.active.cursorY - scrolled);
    fitted.dispose();
  }, 30_000);

  it('Copilot one column short (153): the scrollbar stays one unbroken line down the last column', async () => {
    // What a task window shows on a desktop browser at 100 percent, whose 8px scrollbar gutter
    // leaves the default window 153 columns for a 154-column recording (a near miss, so frames).
    // Rows padded with plain spaces up to the scrollbar used to lose it to the cut while rows that
    // reached it through a gap kept it, and the line broke into segments.
    const { recording, frame, source } = await lastFrameOf('contoso-web-copilot-rate-limit.json');
    const fitted = await fitInto(frame, recording, { cols: 153, rows: 39 });
    expect(wrappedLineCount(fitted)).toBe(0);
    let scrollbarRows = 0;
    for (let row = 0; row < 39; row++) {
      const sourceLine = source.buffer.active.getLine(source.buffer.active.baseY + row);
      const fittedLine = fitted.buffer.active.getLine(fitted.buffer.active.baseY + row);
      const sourceEdge = sourceLine?.getCell(153);
      if (sourceEdge?.getChars() !== '┃') continue;
      scrollbarRows += 1;
      const fittedEdge = fittedLine?.getCell(152);
      expect(fittedEdge?.getChars(), `row ${row} lost its scrollbar`).toBe('┃');
      expect(fittedEdge?.getFgColor(), `row ${row} scrollbar colour`).toBe(sourceEdge.getFgColor());
      expect(fittedEdge?.getFgColorMode(), `row ${row} scrollbar colour mode`).toBe(sourceEdge.getFgColorMode());
      // The text before it reads as recorded up to the one column the cut took.
      expect(rowText(fitted, row).slice(0, 140), `row ${row}`).toBe(rowText(source, row).slice(0, 140));
    }
    // Rows 2 to 33 of the recording carry it: not vacuous.
    expect(scrollbarRows).toBeGreaterThanOrEqual(30);
    fitted.dispose();
  }, 30_000);

  it('Claude in the 219 by 15 bottom panel: the last 15 rows, nothing wrapped, the cursor on its row', async () => {
    const { recording, frame, source } = await lastFrameOf('contoso-web-claude-websocket.json');
    const fitted = await fitInto(frame, recording, { cols: 219, rows: 15 });
    expect(wrappedLineCount(fitted)).toBe(0);
    const rows = parsePhysicalFrame(frame).rows.length;
    const scrolled = rows - 15;
    for (let row = 0; row < 15; row++) {
      const expected = rowText(source, row + scrolled);
      expect(rowText(fitted, row).startsWith(expected), `row ${row}`).toBe(true);
    }
    // The earlier rows are still there, above the screen, for a visitor who scrolls up.
    expect(fitted.buffer.active.length).toBe(rows);
    expect(fitted.buffer.active.cursorY).toBe(source.buffer.active.cursorY - scrolled);
    fitted.dispose();
  }, 30_000);

  it('Copilot in the 219 by 15 bottom panel enters the alternate screen and shows its last rows', async () => {
    const { recording, frame, source } = await lastFrameOf('contoso-web-copilot-rate-limit.json');
    const fitted = await fitInto(frame, recording, { cols: 219, rows: 15 });
    expect(fitted.buffer.active.type).toBe('alternate');
    const scrolled = recording.rows - 15;
    for (let row = 0; row < 15; row++) {
      // The left of each row as recorded; what was on the recording's last column is on the panel's.
      expect(rowText(fitted, row).slice(0, 100), `row ${row}`).toBe(rowText(source, row + scrolled).slice(0, 100));
      const sourceEdge = source.buffer.active.getLine(source.buffer.active.baseY + row + scrolled)?.getCell(recording.cols - 1)?.getChars();
      if (sourceEdge === '┃') expect(fitted.buffer.active.getLine(fitted.buffer.active.baseY + row)?.getCell(218)?.getChars(), `row ${row}`).toBe('┃');
    }
    expect(fitted.buffer.active.cursorY).toBe(source.buffer.active.cursorY - scrolled);
    fitted.dispose();
  }, 30_000);

  it('Copilot six rows taller: the rows open above the footer, the scrollbar runs down them, the input stays last', async () => {
    const { recording, frame, source } = await lastFrameOf('contoso-web-copilot-rate-limit.json');
    const fitted = await fitInto(frame, recording, { cols: 154, rows: 45 });
    expect(wrappedLineCount(fitted)).toBe(0);
    // The footer (cwd, the input box, the status line) is the recording's last five rows, still last.
    for (let offset = 1; offset <= 5; offset++) {
      expect(rowText(fitted, 45 - offset), `footer row ${offset} from the bottom`).toBe(rowText(source, 39 - offset));
    }
    // The scrollbar runs unbroken from the recording's first scrollbar row to the footer.
    for (let row = 6; row < 40; row++) {
      expect(fitted.buffer.active.getLine(row)?.getCell(153)?.getChars(), `row ${row}`).toBe('┃');
    }
    // The cursor, in the input box, moved down with it.
    expect(fitted.buffer.active.cursorY).toBe(source.buffer.active.cursorY + 6);
    fitted.dispose();
  }, 30_000);

  it('a frame from before this serializer passes through untouched apart from its rows', () => {
    const legacy = 'abc\r\ndef\x1b[1A\x1b[2D';
    // No cursor suffix, so no cursor is placed; the rows are still fitted and bracketed.
    expect(applier.fitFrameToGrid(legacy, { cols: 2, rows: 5 }, 5)).toBe('\x1b[?7lab\x1b[0m\r\nde\x1b[0m\x1b[?7h');
  });
});

describe('fitFrameToGrid on every recording, on grids wider than it was made at', () => {
  // What a terminal wider than its recording shows: the web demo never letterboxes, so a pane
  // wider than a recording plays its frames at the pane's own width. Whatever the CLI drew in its
  // LAST column (a scrollbar, a box's side or corner, a rule, a background band) is what the
  // desktop would draw at the new last column; prose that happened to reach it is not.
  const recordingFiles = fs.readdirSync(FIXTURES_DIR).filter((file) => file.endsWith('.json') && file !== 'manifest.json');
  interface Recording { cols: number; rows: number; stream: Array<{ t: number; data: string }> }

  const EDGE_GLYPHS = '│┃┆┇┊┋╎╏║▐▕┐┓┘┛┤┫╗╝╢╣╮╯';
  const RULE_GLYPHS = '─━┄┅┈┉╌╍═╴╶╸╺╼╾▀▁▂▃▄▅▆▇█▔';

  it('recordings exist to check', () => {
    expect(recordingFiles.length).toBeGreaterThanOrEqual(30);
  });

  it('checks the same edge and rule glyphs the applier draws to the edge', () => {
    // The sweep keeps its own lists so the applier does not grade itself, and this pins the two
    // equal: a glyph added to the applier and not here would drop out of the sweep silently.
    expect([...EDGE_GLYPHS].sort()).toEqual([...applier.edgeGlyphs].sort());
    expect([...RULE_GLYPHS].sort()).toEqual([...applier.ruleGlyphs].sort());
  });

  for (const file of recordingFiles) {
    it(`${file}: its last column is drawn at the new last column, 1, 9 and 64 wider`, async () => {
      const recording = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as Recording;
      const source = createTerminal(recording.cols, recording.rows);
      await write(source, recording.stream.map((window) => window.data).join(''));
      // A frame the way the page's emulator cuts it: the screen and the rows above it.
      const frame = serializePhysicalRows(source, { scrollback: 64 });
      let edgeRows = 0;
      for (const extra of [1, 9, 64]) {
        const grid = { cols: recording.cols + extra, rows: recording.rows };
        const fitted = createTerminal(grid.cols, grid.rows);
        await write(fitted, REPAINT + applier.fitFrameToGrid(frame, grid, { cols: recording.cols, rows: recording.rows }));
        expect(wrappedLineCount(fitted), `${file} +${extra} wrapped`).toBe(0);
        for (let row = 0; row < recording.rows; row++) {
          const sourceLine = source.buffer.active.getLine(source.buffer.active.baseY + row);
          const fittedLine = fitted.buffer.active.getLine(fitted.buffer.active.baseY + row);
          const sourceCell = sourceLine?.getCell(recording.cols - 1);
          const fittedCell = fittedLine?.getCell(grid.cols - 1);
          if (!sourceCell || !fittedCell) continue;
          const glyph = sourceCell.getChars();
          const edgeBound = (glyph !== '' && (EDGE_GLYPHS.includes(glyph) || RULE_GLYPHS.includes(glyph)))
            || ((glyph === '' || glyph === ' ') && sourceCell.getBgColorMode() !== 0);
          if (!edgeBound) continue;
          if (extra === 1) edgeRows += 1;
          const label = `${file} +${extra} row ${row} ${JSON.stringify(sourceLine?.translateToString(true).slice(-30))}`;
          expect(fittedCell.getChars() || ' ', label).toBe(glyph || ' ');
          expect(fittedCell.getBgColorMode(), `${label} background mode`).toBe(sourceCell.getBgColorMode());
          expect(fittedCell.getBgColor(), `${label} background`).toBe(sourceCell.getBgColor());
          if (glyph.trim() !== '') expect(fittedCell.getFgColor(), `${label} colour`).toBe(sourceCell.getFgColor());
        }
        fitted.dispose();
      }
      source.dispose();
      // Not vacuous for the recordings that draw to their edge (every TUI but a bare boot).
      if (/copilot|opencode|codex-otel|claude-middleware\.json/.test(file)) expect(edgeRows, `${file} edge rows`).toBeGreaterThan(0);
    }, 60_000);
  }
});
