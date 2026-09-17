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
type FitFrameToGrid = (frame: string, grid: Grid, recordedRows: number) => string;
type FitRow = (row: string, cols: number) => string;
interface Applier { fitFrameToGrid: FitFrameToGrid; fitRow: FitRow; cellWidth: (codepoint: number) => number }

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
  const factory = new Function('cellWidths', `${script.slice(start, end)}\nreturn { fitFrameToGrid, fitRow, cellWidth };`) as (table: unknown) => Applier;
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
    await write(terminal, REPAINT + applier.fitFrameToGrid(frame, grid, recording.rows));
    return terminal;
  }

  it('Copilot at 174 columns: no spill, no stripes, the border on its own column', async () => {
    const { recording, frame, source } = await lastFrameOf('contoso-web-copilot-rate-limit.json');
    const fitted = await fitInto(frame, recording, { cols: 174, rows: 39 });
    expect(wrappedLineCount(fitted)).toBe(0);
    for (let row = 0; row < recording.rows; row++) {
      const expected = rowText(source, row);
      const actual = rowText(fitted, row);
      // Nothing spills, so every row reads exactly as recorded: the only difference a wider grid
      // may introduce is a horizontal rule extended to the new edge.
      expect(actual.startsWith(expected), `row ${row}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`).toBe(true);
      expect(actual.includes('┃┃'), `row ${row} grew a stripe: ${JSON.stringify(actual)}`).toBe(false);
      const extension = actual.slice(expected.length);
      expect(/^(▄*|▀*)$/.test(extension), `row ${row} extended with ${JSON.stringify(extension)}`).toBe(true);
    }
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
      const expected = rowText(source, row + scrolled);
      expect(rowText(fitted, row).startsWith(expected), `row ${row}`).toBe(true);
    }
    expect(fitted.buffer.active.cursorY).toBe(source.buffer.active.cursorY - scrolled);
    fitted.dispose();
  }, 30_000);

  it('a frame from before this serializer passes through untouched apart from its rows', () => {
    const legacy = 'abc\r\ndef\x1b[1A\x1b[2D';
    // No cursor suffix, so no cursor is placed; the rows are still fitted and bracketed.
    expect(applier.fitFrameToGrid(legacy, { cols: 2, rows: 5 }, 5)).toBe('\x1b[?7lab\x1b[0m\r\nde\x1b[0m\x1b[?7h');
  });
});
