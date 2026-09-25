/**
 * `awaitConform` (inside buildDemoPreConfig's generated script,
 * tests/captures/helpers/demo-dataset.ts) is the safety net for the resize wrapper's held-grid
 * offer: when main's mocked resize answers `held`, the terminal's own `conformToHeldGrid`
 * (src/renderer/hooks/useTerminal.ts) is supposed to conform and echo the held grid straight back
 * on its own resize call, which the seed reads as `conformLanded`. `awaitConform` waits
 * CONFORM_WAIT_MS for that echo; if it never lands, the pane cannot actually show the held grid
 * (the seed's own prediction, displayFor, was wrong for this face, or the box could not be
 * measured), so the session falls back to its own natural grid and is marked `conformDeclined`
 * (never offered that same hold again on a later resize at the same natural grid).
 *
 * No test drove this before: the demo tier's "a held terminal reporting its conformed grid is not
 * a resize" case (tests/demo/static-demo.spec.ts) only exercises the LANDED path, because
 * demo-layout-choice.test.ts already proves the seed's held-grid prediction matches what the real
 * conform lands on for the fonts that test covers. So the decline branch is a genuine safety net
 * that the demo tier never trips, and the three-way guard (landed / superseded / genuinely
 * declined) had no coverage at any tier.
 *
 * Lifted out of the GENERATED seed, not the TypeScript source, the way demo-emulator-disposal.test.ts
 * and demo-frame-fit.test.ts lift their functions: the seed is a template literal, so its numeric
 * constants only take their real value once the template has been evaluated by buildDemoPreConfig.
 * `repaintSession`, `stillFrameFor`, `emitBytes`, `notePainted` and `fitFrameToGrid` are stubbed:
 * this file is about the guard that decides WHETHER a decline fires and what it writes to
 * `conformDeclined` / `heldAnswer` / `mountedGeometry`, not about what a repaint or a still frame
 * then does with that decision (each of those is its own already-tested concern - repaintSession's
 * frameScrollback path is demo-emulator-disposal.test.ts's job, and a still's fitFrameToGrid call
 * is demo-frame-fit.test.ts's).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';

interface Grid { cols: number; rows: number }
interface Entry { file: string; projectId: string }

interface Lifted {
  awaitConform: (sessionId: string, entry: Entry, held: Grid) => void;
  conformLanded: Record<string, Grid | null>;
  conformDeclined: Record<string, Grid>;
}

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

function extractNumericConstant(script: string, name: string): number {
  const match = script.match(new RegExp(`var ${name} = ([0-9.]+);`));
  if (!match) throw new Error(`var ${name} not found in the generated seed`);
  return Number(match[1]);
}

const script = buildDemoPreConfig({ scrollback: loadDemoScrollback(), cellWidths: buildCellWidthTable() });
const CONFORM_WAIT_MS = extractNumericConstant(script, 'CONFORM_WAIT_MS');
const SAME_GRID_SOURCE = extractFunction(script, 'sameGrid');
const AWAIT_CONFORM_SOURCE = extractFunction(script, 'awaitConform');

interface LiftState {
  heldAnswer: Record<string, Grid | null>;
  naturalGeometry: Record<string, Grid>;
  mountedGeometry: Record<string, Grid>;
  repaintSession: ReturnType<typeof vi.fn>;
}

/** Builds `awaitConform` over injected `heldAnswer` / `naturalGeometry` / `mountedGeometry` state
 *  (mutated in place, so a test reads them back off the same objects it passed in) and a spy for
 *  `repaintSession`. `live` is fixed to `true`: the still-frame branch (`stillFrameFor` /
 *  `fitFrameToGrid`) is a different surface (a still page, not a live one) and is stubbed to throw
 *  so a test never silently exercises it by accident. */
function lift(state: LiftState): Lifted {
  const source = [
    'var heldAnswer = state.heldAnswer;',
    'var naturalGeometry = state.naturalGeometry;',
    'var mountedGeometry = state.mountedGeometry;',
    'var live = true;',
    'var repaintSession = state.repaintSession;',
    'function stillFrameFor() { throw new Error("stillFrameFor should not be reached while live is true"); }',
    'function emitBytes() { throw new Error("emitBytes should not be reached while live is true"); }',
    'function notePainted() { throw new Error("notePainted should not be reached while live is true"); }',
    'function fitFrameToGrid() { throw new Error("fitFrameToGrid should not be reached while live is true"); }',
    'var REPAINT = "";',
    `var CONFORM_WAIT_MS = ${CONFORM_WAIT_MS};`,
    'var conformLanded = {};',
    'var conformDeclined = {};',
    SAME_GRID_SOURCE,
    AWAIT_CONFORM_SOURCE,
    'return { awaitConform: awaitConform, conformLanded: conformLanded, conformDeclined: conformDeclined };',
  ].join('\n');
  return new Function('state', source)(state) as Lifted;
}

const HELD: Grid = { cols: 60, rows: 20 };
const NATURAL: Grid = { cols: 50, rows: 18 };
const SUPERSEDING_HOLD: Grid = { cols: 70, rows: 22 };
const ENTRY: Entry = { file: 'rec.json', projectId: 'proj-1' };

describe('awaitConform / conformDeclined (the resize wrapper\'s held-grid decline bookkeeping)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declines a hold that never lands within CONFORM_WAIT_MS: repaints the natural grid and marks it declined', async () => {
    vi.useFakeTimers();
    const heldAnswer: Record<string, Grid | null> = { 's1': HELD };
    const naturalGeometry: Record<string, Grid> = { 's1': NATURAL };
    const mountedGeometry: Record<string, Grid> = { 's1': HELD };
    const repaintSession = vi.fn();
    const lifted = lift({ heldAnswer, naturalGeometry, mountedGeometry, repaintSession });

    lifted.awaitConform('s1', ENTRY, HELD);
    // Armed immediately: conformLanded is reset to null the instant the wait starts, so a stale
    // value from an earlier hold can never be misread as "this one already landed".
    expect(lifted.conformLanded['s1']).toBeNull();

    await vi.advanceTimersByTimeAsync(CONFORM_WAIT_MS);
    expect(lifted.conformDeclined['s1']).toEqual(NATURAL);
    expect(heldAnswer['s1']).toBeNull();
    expect(mountedGeometry['s1']).toEqual(NATURAL);
    expect(repaintSession).toHaveBeenCalledTimes(1);
    expect(repaintSession).toHaveBeenCalledWith('s1', ENTRY, NATURAL);
  });

  it('does nothing when the hold lands (the resize wrapper\'s conform-echo sets conformLanded) before the wait ends', async () => {
    vi.useFakeTimers();
    const heldAnswer: Record<string, Grid | null> = { 's2': HELD };
    const naturalGeometry: Record<string, Grid> = { 's2': NATURAL };
    const mountedGeometry: Record<string, Grid> = { 's2': HELD };
    const repaintSession = vi.fn();
    const lifted = lift({ heldAnswer, naturalGeometry, mountedGeometry, repaintSession });

    lifted.awaitConform('s2', ENTRY, HELD);
    // What the resize wrapper does on a conform echo (`if (conformEcho) conformLanded[sessionId] = held;`).
    lifted.conformLanded['s2'] = HELD;
    await vi.advanceTimersByTimeAsync(CONFORM_WAIT_MS);

    expect(lifted.conformDeclined['s2']).toBeUndefined();
    expect(heldAnswer['s2']).toEqual(HELD);
    expect(mountedGeometry['s2']).toEqual(HELD);
    expect(repaintSession).not.toHaveBeenCalled();
  });

  it('does nothing when a later resize has already replaced the held answer before the wait ends', async () => {
    vi.useFakeTimers();
    const heldAnswer: Record<string, Grid | null> = { 's3': HELD };
    const naturalGeometry: Record<string, Grid> = { 's3': NATURAL };
    const mountedGeometry: Record<string, Grid> = { 's3': SUPERSEDING_HOLD };
    const repaintSession = vi.fn();
    const lifted = lift({ heldAnswer, naturalGeometry, mountedGeometry, repaintSession });

    lifted.awaitConform('s3', ENTRY, HELD);
    // A newer resize offered (or cleared to) a different hold before this one's wait ran out.
    heldAnswer['s3'] = SUPERSEDING_HOLD;
    await vi.advanceTimersByTimeAsync(CONFORM_WAIT_MS);

    expect(lifted.conformDeclined['s3']).toBeUndefined();
    expect(heldAnswer['s3']).toEqual(SUPERSEDING_HOLD);
    expect(mountedGeometry['s3']).toEqual(SUPERSEDING_HOLD);
    expect(repaintSession).not.toHaveBeenCalled();
  });
});
