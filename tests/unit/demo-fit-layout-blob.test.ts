/**
 * `fitLayoutBlob` (inside buildDemoPreConfig's generated script,
 * tests/captures/helpers/demo-dataset.ts) sizes a floating window a scene marks
 * `fitToRecording` to the recording's own columns at the visitor's measured terminal cell
 * (.claude/rules/web-demo-parity.md, "A floating terminal window..."). It runs over the scene
 * registry's own layout blobs, so it must never mutate its input, must pass through a blob with
 * no marked window untouched, and must fail loudly rather than silently when a marker names a
 * session the recordings index does not carry.
 *
 * Lifted out of the GENERATED seed, not the TypeScript source, the way demo-layout-choice.test.ts
 * and demo-frame-fit.test.ts lift their functions: the seed is a template literal, so its
 * `\\x1b`-style escapes and its numeric constants only take their real values once the template
 * has been evaluated by buildDemoPreConfig.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';

interface Geometry { x?: number; w?: number; h?: number; y?: number }
interface ManagedWindow { id: string; fitToRecording?: string; geometry?: Geometry }
interface LayoutBlob { windows: ManagedWindow[] }
interface DeviceCell { width: number; gutter: number }
type Measure = () => DeviceCell | null;
type FitLayoutBlob = (blob: LayoutBlob | null | undefined, measure: Measure) => LayoutBlob | null | undefined;
interface RecordingsIndex { sessions: Record<string, { cols: number }> }

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
const FIT_REFERENCE_FRAME_WIDTH = extractConstant(script, 'FIT_REFERENCE_FRAME_WIDTH');
const WINDOW_FRAME_BORDER_PX = extractConstant(script, 'WINDOW_FRAME_BORDER_PX');
const fitLayoutBlobSource = extractFunction(script, 'fitLayoutBlob');

/**
 * The whole generated script must at least PARSE (compile, not run): this is the one file in the
 * unit tier that checks that, so a syntax error anywhere in the template does not slip past every
 * lifted-function test silently extracting around it.
 */
it('the whole generated seed parses', () => {
  expect(() => new Function(script)).not.toThrow();
});

/** Builds `fitLayoutBlob` over an injected `recordings` index and a stub `document`, the way the
 * real function closes over the module's own `recordings` variable and reads `document` directly. */
function lift(recordings: RecordingsIndex, clientWidth: number, source: string = fitLayoutBlobSource): FitLayoutBlob {
  const built = [
    `var FIT_REFERENCE_FRAME_WIDTH = ${FIT_REFERENCE_FRAME_WIDTH};`,
    `var WINDOW_FRAME_BORDER_PX = ${WINDOW_FRAME_BORDER_PX};`,
    source,
    'return fitLayoutBlob;',
  ].join('\n');
  const documentStub = { documentElement: { clientWidth } };
  return new Function('recordings', 'document', built)(recordings, documentStub) as FitLayoutBlob;
}

const NO_RECORDINGS: RecordingsIndex = { sessions: {} };
const neverMeasured: Measure = () => {
  throw new Error('measure() must not be called when no marked window has a matching recording');
};

describe('fitLayoutBlob: pass-through', () => {
  it('returns the exact same blob reference when no window carries fitToRecording', () => {
    const fitLayoutBlob = lift(NO_RECORDINGS, 1600);
    const blob: LayoutBlob = { windows: [{ id: 'a' }, { id: 'b', geometry: { x: 0.1, w: 0.5 } }] };
    expect(fitLayoutBlob(blob, neverMeasured)).toBe(blob);
  });

  it('returns null and undefined blobs unchanged', () => {
    const fitLayoutBlob = lift(NO_RECORDINGS, 1600);
    expect(fitLayoutBlob(null, neverMeasured)).toBeNull();
    expect(fitLayoutBlob(undefined, neverMeasured)).toBeUndefined();
  });

  it('returns a blob with no windows array unchanged', () => {
    const fitLayoutBlob = lift(NO_RECORDINGS, 1600);
    const blob = {} as LayoutBlob;
    expect(fitLayoutBlob(blob, neverMeasured)).toBe(blob);
  });
});

describe('fitLayoutBlob: a marker naming a session the recordings index does not carry', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs a console error naming the session id and strips the marker with geometry untouched', () => {
    const fitLayoutBlob = lift(NO_RECORDINGS, 1600);
    const blob: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'ghost-session', geometry: { h: 0.4, y: 0.1 } }] };
    const result = fitLayoutBlob(blob, neverMeasured);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('ghost-session');
    expect(errorSpy.mock.calls[0][0]).toContain('recordings index does not carry');
    const resultWindow = result?.windows[0];
    expect(resultWindow).toBeDefined();
    expect(resultWindow).not.toHaveProperty('fitToRecording');
    expect(resultWindow?.geometry).toEqual({ h: 0.4, y: 0.1 });
  });

  it('never calls measure() when the session is missing from the index', () => {
    const fitLayoutBlob = lift(NO_RECORDINGS, 1600);
    const blob: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'ghost-session' }] };
    // neverMeasured throws if invoked, so reaching this line without throwing is the pin.
    expect(() => fitLayoutBlob(blob, neverMeasured)).not.toThrow();
  });

  it('does not mutate the input blob', () => {
    const fitLayoutBlob = lift(NO_RECORDINGS, 1600);
    const original: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'ghost-session' }] };
    const snapshot = structuredClone(original);
    fitLayoutBlob(original, neverMeasured);
    expect(original).toEqual(snapshot);
  });
});

describe('fitLayoutBlob: a marked session the recordings index does carry', () => {
  it('sets geometry w and x to the measured formula, and strips the marker', () => {
    const recordings: RecordingsIndex = { sessions: { 'sess-1': { cols: 120 } } };
    const fitLayoutBlob = lift(recordings, 1024);
    const measure: Measure = () => ({ width: 8, gutter: 15 });
    const blob: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'sess-1' }] };
    const result = fitLayoutBlob(blob, measure);
    const frameWidth = Math.max(1024, FIT_REFERENCE_FRAME_WIDTH);
    const expectedWidth = (WINDOW_FRAME_BORDER_PX + 15 + (120 + 0.5) * 8) / frameWidth;
    const resultWindow = result?.windows[0];
    expect(resultWindow).not.toHaveProperty('fitToRecording');
    expect(resultWindow?.geometry?.w).toBeCloseTo(expectedWidth, 10);
    expect(resultWindow?.geometry?.x).toBeCloseTo((1 - expectedWidth) / 2, 10);
  });

  it('keeps a marked window clientWidth WIDER than the reference frame as the frame width, not the reference', () => {
    const recordings: RecordingsIndex = { sessions: { 'sess-1': { cols: 80 } } };
    const fitLayoutBlob = lift(recordings, 2000);
    const measure: Measure = () => ({ width: 9, gutter: 0 });
    const blob: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'sess-1' }] };
    const result = fitLayoutBlob(blob, measure);
    const frameWidth = Math.max(2000, FIT_REFERENCE_FRAME_WIDTH);
    expect(frameWidth).toBe(2000);
    const expectedWidth = (WINDOW_FRAME_BORDER_PX + 0 + (80 + 0.5) * 9) / frameWidth;
    expect(result?.windows[0].geometry?.w).toBeCloseTo(expectedWidth, 10);
  });

  it('merges the fitted x/w into any geometry the window already carried', () => {
    const recordings: RecordingsIndex = { sessions: { 'sess-1': { cols: 120 } } };
    const fitLayoutBlob = lift(recordings, 1024);
    const measure: Measure = () => ({ width: 8, gutter: 15 });
    const blob: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'sess-1', geometry: { h: 0.6, y: 0.05 } }] };
    const result = fitLayoutBlob(blob, measure);
    const geometry = result?.windows[0].geometry;
    expect(geometry?.h).toBe(0.6);
    expect(geometry?.y).toBe(0.05);
    expect(geometry?.w).toBeGreaterThan(0);
    expect(geometry?.x).toBeGreaterThan(0);
  });

  it('leaves geometry untouched when the session is indexed but measure() returns nothing', () => {
    const recordings: RecordingsIndex = { sessions: { 'sess-1': { cols: 120 } } };
    const fitLayoutBlob = lift(recordings, 1024);
    const measure: Measure = () => null;
    const blob: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'sess-1', geometry: { h: 0.6 } }] };
    const result = fitLayoutBlob(blob, measure);
    const resultWindow = result?.windows[0];
    expect(resultWindow).not.toHaveProperty('fitToRecording');
    expect(resultWindow?.geometry).toEqual({ h: 0.6 });
  });

  it('does not mutate the input blob, its windows, or their geometry', () => {
    const recordings: RecordingsIndex = { sessions: { 'sess-1': { cols: 120 } } };
    const fitLayoutBlob = lift(recordings, 1024);
    const measure: Measure = () => ({ width: 8, gutter: 15 });
    const original: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'sess-1', geometry: { h: 0.6 } }, { id: 'w2' }] };
    const snapshot = structuredClone(original);
    fitLayoutBlob(original, measure);
    expect(original).toEqual(snapshot);
  });

  it('returns a NEW blob object (a copy), never the same reference, once a window is marked', () => {
    const recordings: RecordingsIndex = { sessions: { 'sess-1': { cols: 120 } } };
    const fitLayoutBlob = lift(recordings, 1024);
    const measure: Measure = () => ({ width: 8, gutter: 15 });
    const original: LayoutBlob = { windows: [{ id: 'w1', fitToRecording: 'sess-1' }] };
    const result = fitLayoutBlob(original, measure);
    expect(result).not.toBe(original);
  });
});
