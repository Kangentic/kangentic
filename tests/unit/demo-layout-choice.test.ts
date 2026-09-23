/**
 * How the web demo shows a recording in a pane of any grid (`displayFor`, `layoutFor` in
 * buildDemoPreConfig's generated script, tests/captures/helpers/demo-dataset.ts). The terminal
 * FILLS its pane: at the configured type when the pane is at least the recording's width or a
 * column or two short of it, and otherwise HELD at the grid the whole pane takes at a smaller type
 * that carries the recording's columns. A session recorded twice (the single task window and a
 * tiled pane) shows whichever recording its pane shows best.
 *
 * The functions are lifted out of the GENERATED seed, not the TypeScript source, the way
 * demo-frame-fit.test.ts lifts the frame applier: the seed is a template literal, and a test that
 * read the .ts text would run a different program from the one the page runs. The unit tier has
 * no OffscreenCanvas, so the cell the page measures (terminalDeviceCell) is injected: a face whose
 * cell scales linearly with its size (Consolas) and one whose height rounds unevenly (Courier New,
 * whose 11 px cell is a whole device pixel shorter than 12 scaled down), the case where the
 * renderer's conform used to land below the largest size that fits and letterbox rows.
 */
import { describe, expect, it } from 'vitest';
import { buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';

interface Grid { cols: number; rows: number }
interface Layout extends Grid { file: string }
interface DeviceCell { width: number; height: number; scale: number }
interface Display { scale: number; held: Grid | null; cut: number }
type CellModel = (terminalConfig: unknown, fontSize?: number) => DeviceCell;
interface Lifted {
  displayFor: (layout: Grid, cols: number, rows: number) => Display;
  layoutFor: (entry: { layouts: { single: Layout; tiled: Layout } | null }, cols: number, rows: number) => Layout | null;
}

const CONFIGURED_FONT_PX = 12;

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

function extractConstant(script: string, name: string): number {
  const match = script.match(new RegExp(`var ${name} = ([0-9.]+);`));
  if (!match) throw new Error(`var ${name} not found in the generated seed`);
  return Number(match[1]);
}

const script = buildDemoPreConfig({ scrollback: loadDemoScrollback(), cellWidths: buildCellWidthTable() });
const HOLD_MIN_SCALE = extractConstant(script, 'HOLD_MIN_SCALE');
const NEAR_MISS_COLUMNS = extractConstant(script, 'NEAR_MISS_COLUMNS');

function lift(cellModel: CellModel): Lifted {
  const source = [
    `var HOLD_MIN_SCALE = ${HOLD_MIN_SCALE};`,
    `var NEAR_MISS_COLUMNS = ${NEAR_MISS_COLUMNS};`,
    `var mockState = { config: { terminal: { fontSize: ${CONFIGURED_FONT_PX} } } };`,
    extractFunction(script, 'configuredFontSize'),
    'var terminalDeviceCell = cellModel;',
    extractFunction(script, 'displayFor'),
    extractFunction(script, 'layoutScore'),
    extractFunction(script, 'layoutFor'),
    'return { displayFor: displayFor, layoutFor: layoutFor };',
  ].join('\n');
  return new Function('cellModel', source)(cellModel) as Lifted;
}

/** Consolas: the advance is 0.5498 of the size and the line 1.1719, both measured as floats. */
function consolasAt(scale: number): CellModel {
  return (_config, fontSize = CONFIGURED_FONT_PX) => ({
    width: Math.floor(fontSize * 0.5498 * scale),
    height: Math.ceil(fontSize * 1.1719 * scale),
    scale,
  });
}

/** Courier New: a 0.6 advance, and ascent and descent that each round to whole pixels per size. */
function courierAt(scale: number): CellModel {
  return (_config, fontSize = CONFIGURED_FONT_PX) => ({
    width: Math.floor(fontSize * 0.6 * scale),
    height: Math.ceil((Math.round(fontSize * 0.833) + Math.round(fontSize * 0.3)) * scale),
    scale,
  });
}

/**
 * Where the renderer's conform lands for a held grid in a pane (useTerminal's conformToHeldGrid):
 * the LARGEST quarter-pixel size at or below the configured one at which the grid fits.
 */
function conformLanding(cellModel: CellModel, held: Grid, paneWidth: number, paneHeight: number): DeviceCell | null {
  for (let font = CONFIGURED_FONT_PX; font >= 4; font -= 0.25) {
    const cell = cellModel(null, font);
    if (held.cols * cell.width <= paneWidth && held.rows * cell.height <= paneHeight) return cell;
  }
  return null;
}

const SINGLE: Layout = { file: 'single', cols: 154, rows: 37 };
const TILED: Layout = { file: 'tiled', cols: 115, rows: 37 };
const MIDDLEWARE = { layouts: { single: SINGLE, tiled: TILED } };

describe('displayFor (the grid a pane shows a recording at)', () => {
  const consolas = lift(consolasAt(1));

  it('keeps the configured type for a pane at least the recording, or a column or two short', () => {
    expect(consolas.displayFor(SINGLE, 154, 37)).toEqual({ scale: 1, held: null, cut: 0 });
    expect(consolas.displayFor(SINGLE, 218, 15)).toEqual({ scale: 1, held: null, cut: 0 });
    expect(consolas.displayFor(SINGLE, 153, 37)).toEqual({ scale: 1, held: null, cut: 1 });
    expect(consolas.displayFor(SINGLE, 154 - NEAR_MISS_COLUMNS, 37)).toEqual({ scale: 1, held: null, cut: NEAR_MISS_COLUMNS });
  });

  it('holds a pane further short at the grid the WHOLE pane takes in smaller type, never the recording alone', () => {
    // A card window at 125 percent: 143 columns at an 8 device pixel cell.
    const display = lift(consolasAt(1.25)).displayFor(SINGLE, 143, 36);
    expect(display.scale).toBe(7 / 8);
    expect(display.held?.cols).toBeGreaterThan(154);
    expect(display.held?.rows).toBeGreaterThan(36);
  });

  it('takes the larger of two smaller types when it leaves the recording only a column or two short', () => {
    // A card window at twice scale: 141 columns at a 13 device pixel cell. At 12 the pane holds
    // 152 of the recording's 154, a near miss at that size, which beats 11 pixels and 166 columns.
    const display = lift(consolasAt(2)).displayFor(SINGLE, 141, 37);
    expect(display.scale).toBe(12 / 13);
    expect(display.held?.cols).toBe(152);
    expect(display.cut).toBe(2);
  });

  it('leaves unreadable type alone: below the floor the recording is cut at the configured size', () => {
    expect(consolas.displayFor(SINGLE, 80, 37)).toEqual({ scale: 1, held: null, cut: 74 });
    expect(80 / 154).toBeLessThan(HOLD_MIN_SCALE);
  });

  // The invariant the seed's arithmetic exists for, in both faces and at every display scale a
  // visitor has: the held grid carries the recording's columns, the renderer's conform LANDS on
  // the cell the seed predicted (the largest size at which the grid fits), and at that cell the
  // grid fills the pane to within a cell each way. The pane is taken at its smallest, whole native
  // cells of the natural grid, as the seed takes it.
  for (const [name, model] of [['Consolas', consolasAt], ['Courier New', courierAt]] as const) {
    for (const scale of [1, 1.25, 1.5, 2]) {
      it(`fills every held pane to within a cell, in ${name} at ${scale * 100} percent`, () => {
        const cellModel = model(scale);
        const lifted = lift(cellModel);
        const native = cellModel(null);
        let held = 0;
        for (const layout of [SINGLE, TILED]) {
          for (let cols = Math.ceil(layout.cols * HOLD_MIN_SCALE); cols < layout.cols; cols++) {
            for (const rows of [15, 26, 36, 37, 39, 59]) {
              const display = lifted.displayFor(layout, cols, rows);
              if (!display.held) continue;
              held += 1;
              const paneWidth = cols * native.width;
              const paneHeight = rows * native.height;
              const label = `${layout.file} in ${cols}x${rows}`;
              expect(display.held.cols, label).toBeGreaterThanOrEqual(layout.cols - NEAR_MISS_COLUMNS);
              expect(display.scale, label).toBeGreaterThanOrEqual(HOLD_MIN_SCALE);
              const landed = conformLanding(cellModel, display.held, paneWidth, paneHeight);
              expect(landed, `${label}: the conform found no size`).not.toBeNull();
              expect((landed as DeviceCell).width / native.width, `${label}: the conform landed on another cell`).toBe(display.scale);
              expect(paneWidth - display.held.cols * (landed as DeviceCell).width, `${label}: columns left over`).toBeLessThan((landed as DeviceCell).width);
              expect(paneHeight - display.held.rows * (landed as DeviceCell).height, `${label}: rows left over`).toBeLessThan((landed as DeviceCell).height);
            }
          }
        }
        // Not vacuous: most of the sweep is held.
        expect(held).toBeGreaterThan(100);
      });
    }
  }
});

describe('layoutFor (the recording a pane shows)', () => {
  it('takes the tiled recording at the configured type for a tiled pair or a pane beside a panel', () => {
    const consolas = lift(consolasAt(1));
    expect(consolas.layoutFor(MIDDLEWARE, 123, 37)?.file).toBe('tiled');
    expect(consolas.layoutFor(MIDDLEWARE, 118, 59)?.file).toBe('tiled');
    // A column short of the tiled recording beside the Changes panel: the tiled one, held.
    expect(consolas.layoutFor(MIDDLEWARE, 110, 59)?.file).toBe('tiled');
  });

  it('takes the single recording in smaller type for a card window short of it, laid out edge to edge as recorded', () => {
    // 125 percent on Windows, and a Mac or Linux face at twice scale.
    expect(lift(consolasAt(1.25)).layoutFor(MIDDLEWARE, 143, 36)?.file).toBe('single');
    expect(lift(courierAt(2)).layoutFor(MIDDLEWARE, 132, 37)?.file).toBe('single');
  });

  it('takes the single recording for a pane at least its width, and a panel wider than both', () => {
    const consolas = lift(consolasAt(1));
    expect(consolas.layoutFor(MIDDLEWARE, 154, 37)?.file).toBe('single');
    expect(consolas.layoutFor(MIDDLEWARE, 153, 37)?.file).toBe('single');
    expect(consolas.layoutFor(MIDDLEWARE, 218, 15)?.file).toBe('single');
  });

  it('chooses nothing for a session recorded once', () => {
    expect(lift(consolasAt(1)).layoutFor({ layouts: null }, 145, 37)).toBeNull();
  });
});
