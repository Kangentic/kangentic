/**
 * `emulatorPaint` (inside buildDemoPreConfig's generated script,
 * tests/captures/helpers/demo-dataset.ts) builds the bytes that bring a visitor's terminal to what
 * the page's own replay emulator (demo/replay-emulator.ts) currently shows. It takes an
 * INCREMENTAL paint, which builds on the last one the way a real stream does, only when nothing
 * about the terminal changed in a way an incremental repaint cannot express (a new grid, the
 * alternate screen, a scrollback clear, or more rows scrolled than the grid holds); every other
 * case is a FULL paint that clears the terminal first
 * (.claude/rules/web-demo-parity.md, "A repaint builds on the last one...").
 *
 * Lifted out of the GENERATED seed, not the TypeScript source, the way demo-frame-fit.test.ts
 * lifts the frame applier: the seed is a template literal, so its `\\x1b`-style escapes only
 * become escape characters once the template has been evaluated by buildDemoPreConfig. Driven
 * with the REAL replay emulator (demo/replay-emulator.ts) rather than a fake, so the
 * `historyCleared`-is-consumed-on-read behavior and the real `scrolledRows` (xterm's own
 * `buffer.normal.baseY`) are exactly what emulatorPaint sees in the page.
 *
 * `@xterm/xterm`'s `Terminal` never touches a DOM until `.open()` is called on one, and the
 * replay emulator never calls `.open()`, so it loads and runs here under vitest's default node
 * environment with no alias needed (see tests/unit/demo-replay-emulator.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';
import { createReplayEmulator, type ReplayEmulator } from '../../demo/replay-emulator';

interface Grid { cols: number; rows: number }
interface PaintedState { cols: number; rows: number; alternate: boolean; scrolledRows: number }
interface EmulatorPaintState {
  emulator: ReplayEmulator;
  recording: Grid;
  grid: Grid;
  painted: PaintedState | null;
}
type EmulatorPaint = (state: EmulatorPaintState, full: boolean) => string;
interface Lifted { emulatorPaint: EmulatorPaint; REPAINT: string }

/** One function's source out of the generated script, by brace matching from its declaration. */
function extractFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in the generated seed`);
  const open = script.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name} in the generated seed`);
}

/** The exact `var NAME = '...';` statement text, escapes and all, for a single-quoted string constant. */
function extractQuotedStatement(script: string, name: string): string {
  const marker = `var ${name} = '`;
  const start = script.indexOf(marker);
  if (start === -1) throw new Error(`var ${name} not found in the generated seed`);
  let index = start + marker.length;
  while (index < script.length) {
    if (script[index] === '\\') { index += 2; continue; }
    if (script[index] === "'") break;
    index += 1;
  }
  const end = script.indexOf(';', index);
  if (end === -1) throw new Error(`unterminated var ${name} in the generated seed`);
  return script.slice(start, end + 1);
}

function extractNumericConstant(script: string, name: string): number {
  const match = script.match(new RegExp(`var ${name} = ([0-9.]+);`));
  if (!match) throw new Error(`var ${name} not found in the generated seed`);
  return Number(match[1]);
}

/**
 * `var FRAME_SEQUENCE` through the end of `fitFrameToGrid`: the same range
 * tests/unit/demo-frame-fit.test.ts lifts as "the applier", which carries fitFrameParts,
 * cursorPosition, fitRow, cellWidth, ALT_PREFIX and the edge-glyph tables emulatorPaint needs.
 */
function extractApplierRange(script: string): string {
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
  return script.slice(start, end);
}

const script = buildDemoPreConfig({ scrollback: loadDemoScrollback(), cellWidths: buildCellWidthTable() });
const REPAINT_STATEMENT = extractQuotedStatement(script, 'REPAINT');
const FULL_PAINT_ROWS_ABOVE = extractNumericConstant(script, 'FULL_PAINT_ROWS_ABOVE');
const APPLIER_RANGE = extractApplierRange(script);
const EMULATOR_PAINT_SOURCE = extractFunction(script, 'emulatorPaint');

function lift(emulatorPaintSource: string = EMULATOR_PAINT_SOURCE): Lifted {
  const source = [
    REPAINT_STATEMENT,
    `var FULL_PAINT_ROWS_ABOVE = ${FULL_PAINT_ROWS_ABOVE};`,
    APPLIER_RANGE,
    emulatorPaintSource,
    'return { emulatorPaint: emulatorPaint, REPAINT: REPAINT };',
  ].join('\n');
  return new Function('cellWidths', source)(buildCellWidthTable()) as Lifted;
}

const { emulatorPaint, REPAINT } = lift();

// tests/unit/demo-fit-layout-blob.test.ts is the one file in the unit tier that parses the WHOLE
// generated script (`new Function(script)`, compile-only); this file only extracts the ranges
// above, so it does not duplicate that guard.

describe('emulatorPaint', () => {
  const states: EmulatorPaintState[] = [];
  afterEach(() => {
    for (const state of states.splice(0)) state.emulator.dispose();
  });

  function trackedState(recording: Grid, grid: Grid): EmulatorPaintState {
    const state: EmulatorPaintState = { emulator: createReplayEmulator(recording.cols, recording.rows), recording, grid, painted: null };
    states.push(state);
    return state;
  }

  it('the first paint is always full, prefixed with REPAINT', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('hello');
    const bytes = emulatorPaint(state, false);
    expect(bytes.startsWith(REPAINT)).toBe(true);
    expect(state.painted).toEqual({ cols: 10, rows: 4, alternate: false, scrolledRows: 0 });
  });

  it('a second paint after N scrolled lines is incremental, with exactly N newline feeds', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('line0\r\nline1\r\nline2\r\nline3');
    emulatorPaint(state, false); // first paint: full, establishes state.painted at scrolledRows 0
    // Three more scrolls on a filled 4-row screen.
    await state.emulator.write('\r\nline4\r\nline5\r\nline6');
    const bytes = emulatorPaint(state, false);
    expect(bytes.startsWith(REPAINT)).toBe(false);
    expect(bytes.startsWith('\x1b[4;1H')).toBe(true); // cursor to the grid's bottom row (4)
    const feedCount = (bytes.match(/\n/g) || []).length;
    expect(feedCount).toBe(3);
    // Every screen row is redrawn in place behind an erase.
    for (let row = 1; row <= 4; row++) {
      expect(bytes).toContain(`\x1b[${row};1H\x1b[0m\x1b[2K`);
    }
  });

  it('a grid size change forces a full paint even with no other change', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('hello');
    emulatorPaint(state, false);
    state.grid = { cols: 12, rows: 4 };
    const bytes = emulatorPaint(state, false);
    expect(bytes.startsWith(REPAINT)).toBe(true);
  });

  it('entering the alternate screen forces a full paint', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('hello');
    emulatorPaint(state, false);
    await state.emulator.write('\x1b[?1049h');
    const bytes = emulatorPaint(state, false);
    expect(bytes.startsWith(REPAINT)).toBe(true);
  });

  it('the CLI clearing its own scrollback forces a full paint', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('hello');
    emulatorPaint(state, false);
    await state.emulator.write('\x1b[3J');
    const bytes = emulatorPaint(state, false);
    expect(bytes.startsWith(REPAINT)).toBe(true);
  });

  it('scrolling more rows than the grid holds between two paints forces a full paint, with history above the screen', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('line0\r\nline1\r\nline2\r\nline3');
    emulatorPaint(state, false); // baseline, scrolledRows 0
    // Five more scrolls, more than the grid's 4 rows: line0 has scrolled off the 4-row screen.
    await state.emulator.write('\r\nline4\r\nline5\r\nline6\r\nline7\r\nline8');
    const bytes = emulatorPaint(state, false);
    expect(bytes.startsWith(REPAINT)).toBe(true);
    // A full paint re-snapshots with FULL_PAINT_ROWS_ABOVE, not just the forced repaint's own
    // rowsAbove (0 for a same-size grid): line0 is still there, above the screen.
    expect(bytes).toContain('line0');
  });

  it('leaving the alternate screen also forces a full paint', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('hello');
    emulatorPaint(state, false); // paint 1: full, painted.alternate becomes false
    await state.emulator.write('\x1b[?1049h');
    emulatorPaint(state, false); // paint 2: forced full (entering alternate), painted.alternate becomes true
    await state.emulator.write('\x1b[?1049l');
    const bytes = emulatorPaint(state, false); // paint 3: last.alternate was true, snapshot.alternate is now false
    expect(bytes.startsWith(REPAINT)).toBe(true);
  });

  it('state.painted reflects the grid and the emulator snapshot after both a full and an incremental paint', async () => {
    const state = trackedState({ cols: 10, rows: 4 }, { cols: 10, rows: 4 });
    await state.emulator.write('line0\r\nline1\r\nline2\r\nline3');
    emulatorPaint(state, false);
    expect(state.painted).toEqual({ cols: 10, rows: 4, alternate: false, scrolledRows: 0 });
    await state.emulator.write('\r\nline4');
    emulatorPaint(state, false);
    expect(state.painted).toEqual({ cols: 10, rows: 4, alternate: false, scrolledRows: 1 });
  });

  it('an explicit full=true paint carries FULL_PAINT_ROWS_ABOVE worth of history, not just the screen', async () => {
    // Far fewer lines than FULL_PAINT_ROWS_ABOVE, so nothing the emulator holds is trimmed away:
    // this isolates the FULL_PAINT_ROWS_ABOVE floor from the emulator's own scrollback budget.
    expect(50).toBeLessThan(FULL_PAINT_ROWS_ABOVE);
    const state = trackedState({ cols: 10, rows: 2 }, { cols: 10, rows: 2 });
    const lines = Array.from({ length: 50 }, (_, index) => `l${index}`).join('\r\n');
    await state.emulator.write(lines);
    // The screen alone (rowsAbove 0) no longer shows the first line: it scrolled off long ago.
    expect(state.emulator.frame(0).frame).not.toContain('l0');
    const bytes = emulatorPaint(state, true);
    expect(bytes.startsWith(REPAINT)).toBe(true);
    expect(bytes).toContain('l0');
  });
});
