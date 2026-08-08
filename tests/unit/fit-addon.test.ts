/**
 * Unit coverage for FitAddon.proposeDimensions().
 *
 * The load-bearing property is DETERMINISM: the same container must always
 * propose the same column count. Every distinct column count a mount produces
 * costs a PTY resize and a full agent repaint, and a fit whose result depends on
 * state that changes DURING a mount hands the PTY two widths.
 *
 * That is not hypothetical. proposeDimensions used to reclaim the scrollbar
 * gutter whenever the alternate screen buffer was active, on the premise that a
 * fullscreen TUI has no scrollbar. Two consequences, both observed live:
 *
 *   - The buffer mode flips normal -> alternate mid-mount, the moment the
 *     scrollback replay writes the TUI's alt-screen enter. So the mount fit and
 *     the post-replay refit disagreed by two columns on EVERY open (always, under
 *     Claude Code's `/tui fullscreen`), and the user watched the agent's second
 *     repaint land.
 *   - xterm's own stylesheet sets `.xterm-viewport { overflow-y: scroll }`, so the
 *     gutter is reserved in the alternate buffer too. Reclaiming it pushed the
 *     grid past the visible viewport and clipped the right-hand column.
 *
 * The gutter is now MEASURED off the viewport, which is both correct and
 * constant across buffer modes. The first two describes below are the regression
 * guards for that; restoring either branch turns them red.
 *
 * proposeDimensions() touches:
 *   _terminal.element / .parentElement / .querySelector('.xterm-viewport')
 *   _terminal._core._renderService.dimensions.css.cell  (private xterm API)
 *   window.getComputedStyle  (mocked via vi.stubGlobal; jsdom not required)
 *
 * Geometry used across all cases:
 *   parentWidth = 800, parentHeight = 600, padding = 0 on the terminal element
 *   cellWidth = 8, cellHeight = 16
 *   viewport offsetWidth = 800, clientWidth = 792  ->  measured gutter = 8
 *   cols = floor((800 - 8) / 8) = 99
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Terminal } from '@xterm/xterm';
import { FitAddon, FALLBACK_SCROLLBAR_WIDTH } from '../../src/renderer/addons/fit-addon';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const CELL_WIDTH = 8;
const PARENT_WIDTH = 800;

interface ViewportStub {
  offsetWidth: number;
  clientWidth: number;
}

/** Pair of parent/element objects that satisfy proposeDimensions()'s early-exit
 *  checks without any real DOM. parentElement is non-null (truthy), so the guard
 *  `!_terminal.element.parentElement` passes, and querySelector answers with the
 *  viewport stub the gutter is measured from. */
function makeElements(viewport: ViewportStub | null = { offsetWidth: 800, clientWidth: 792 }) {
  const parentEl = {};
  const elementEl = {
    parentElement: parentEl,
    querySelector: (selector: string) => (selector === '.xterm-viewport' ? viewport : null),
  };
  return { parentEl, elementEl };
}

/** Build a minimal Terminal-shaped stub. The private _core path uses `as any`
 *  in the source, so a plain object satisfies it without type gymnastics. */
function makeTerminalStub(
  elementEl: object,
  bufferType: 'normal' | 'alternate' = 'normal',
  scrollback = 1000,
): Terminal {
  return {
    element: elementEl,
    options: { scrollback },
    buffer: { active: { type: bufferType } },
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: CELL_WIDTH, height: 16 } } },
      },
    },
  } as unknown as Terminal;
}

/** Returns controlled geometry for both the parent element (800x600) and the
 *  terminal element (zero padding). */
function makeWindowStub(parentEl: object) {
  return {
    getComputedStyle: (element: unknown) => ({
      getPropertyValue: (prop: string): string => {
        if (element === parentEl) {
          if (prop === 'width') return String(PARENT_WIDTH);
          if (prop === 'height') return '600';
        }
        // terminal element -- all padding values are 0
        return '0';
      },
    }),
  };
}

/** Same shape as makeWindowStub, but the parent box reports a collapsed size
 *  for one axis - a hidden/mid-transition container. */
function makeCollapsedWindowStub(parentEl: object, dimension: 'width' | 'height' | 'both'): unknown {
  const width = dimension === 'width' || dimension === 'both' ? '0' : '800';
  const height = dimension === 'height' || dimension === 'both' ? '0' : '600';
  return {
    getComputedStyle: (element: unknown) => ({
      getPropertyValue: (prop: string): string => {
        if (element === parentEl) {
          if (prop === 'width') return width;
          if (prop === 'height') return height;
        }
        return '0';
      },
    }),
  };
}

/** Same shape as makeCollapsedWindowStub, but the parent box reports an EMPTY
 *  string (not '0') for the selected axis - a real-world computed-style value
 *  ('' or 'auto') that `parseInt` turns into NaN rather than 0. The guard's
 *  comment claims `> 0` also rejects NaN; this stub is what proves it, since
 *  an equivalent-looking `=== 0` rewrite would let a NaN box slip past every
 *  '0'-only case above. The other axis stays a valid '800'/'600' so each
 *  single-axis case is discriminating. */
function makeNaNWindowStub(parentEl: object, dimension: 'width' | 'height' | 'both'): unknown {
  const width = dimension === 'width' || dimension === 'both' ? '' : '800';
  const height = dimension === 'height' || dimension === 'both' ? '' : '600';
  return {
    getComputedStyle: (element: unknown) => ({
      getPropertyValue: (prop: string): string => {
        if (element === parentEl) {
          if (prop === 'width') return width;
          if (prop === 'height') return height;
        }
        return '0';
      },
    }),
  };
}

function proposeFor(terminal: Terminal): { cols: number; rows: number } {
  const fitAddon = new FitAddon();
  fitAddon.activate(terminal);
  const dims = fitAddon.proposeDimensions();
  expect(dims).toBeDefined();
  return dims!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FitAddon.proposeDimensions -- deterministic for a fixed container', () => {
  const { parentEl, elementEl } = makeElements();

  beforeEach(() => {
    vi.stubGlobal('window', makeWindowStub(parentEl));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proposes the same columns in the normal and alternate screen buffers', () => {
    // THE regression guard. The buffer mode flips mid-mount when the scrollback
    // replay writes the TUI's alt-screen enter, so a buffer-mode-dependent fit
    // gives a mount two different widths and the PTY two SIGWINCH repaints.
    //
    // RED: restoring `|| inAltBuffer` to the scrollbar condition makes the
    // alternate case 100 against the normal case's 99.
    const normal = proposeFor(makeTerminalStub(elementEl, 'normal'));
    const alternate = proposeFor(makeTerminalStub(elementEl, 'alternate'));
    expect(alternate.cols).toBe(normal.cols);
    expect(alternate.rows).toBe(normal.rows);
  });

  it('proposes the same columns whether or not scrollback is enabled', () => {
    // `scrollback === 0` used to reclaim the gutter too. It is just as wrong:
    // overflow-y is `scroll`, so the gutter is reserved regardless.
    //
    // RED: restoring the `options.scrollback === 0` branch makes this 100 vs 99.
    const withScrollback = proposeFor(makeTerminalStub(elementEl, 'normal', 1000));
    const withoutScrollback = proposeFor(makeTerminalStub(elementEl, 'normal', 0));
    expect(withoutScrollback.cols).toBe(withScrollback.cols);
  });

  it('reserves exactly the measured gutter (800 - 8) / 8 = 99 columns', () => {
    expect(proposeFor(makeTerminalStub(elementEl)).cols).toBe(99);
  });
});

describe('FitAddon.proposeDimensions -- the grid fits inside the visible viewport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('measures the gutter off the viewport rather than assuming a width', () => {
    // A wider gutter must cost a column. RED: any hardcoded reserve makes both
    // cases agree, which is how a 14px assumption against an 8px gutter left a
    // 12px empty strip on the right (the symptom the alt-buffer reclaim was
    // mistakenly written to fix).
    const thin = makeElements({ offsetWidth: 800, clientWidth: 792 });
    vi.stubGlobal('window', makeWindowStub(thin.parentEl));
    expect(proposeFor(makeTerminalStub(thin.elementEl)).cols).toBe(99);

    const thick = makeElements({ offsetWidth: 800, clientWidth: 780 });
    vi.stubGlobal('window', makeWindowStub(thick.parentEl));
    expect(proposeFor(makeTerminalStub(thick.elementEl)).cols).toBe(97);
  });

  it('never proposes a grid wider than the viewport can show', () => {
    // The invariant the old reclaim violated: it produced a grid 2px past the
    // visible viewport, clipping the last column with no recovery path (xterm
    // re-emits a resize only when its OWN size changes). Asserted across a range
    // of gutters so it holds for whatever the platform reserves.
    for (const clientWidth of [800, 792, 786, 780, 774]) {
      const { parentEl, elementEl } = makeElements({ offsetWidth: 800, clientWidth });
      vi.stubGlobal('window', makeWindowStub(parentEl));
      const { cols } = proposeFor(makeTerminalStub(elementEl));
      expect(cols * CELL_WIDTH).toBeLessThanOrEqual(clientWidth);
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the constant before the viewport has been laid out', () => {
    // Pre-layout the viewport reports 0/0, and `offsetWidth - clientWidth` would
    // measure a 0 gutter and overflow. A missing viewport takes the same path.
    for (const viewport of [{ offsetWidth: 0, clientWidth: 0 }, null]) {
      const { parentEl, elementEl } = makeElements(viewport);
      vi.stubGlobal('window', makeWindowStub(parentEl));
      const { cols } = proposeFor(makeTerminalStub(elementEl));
      expect(cols).toBe(Math.floor((PARENT_WIDTH - FALLBACK_SCROLLBAR_WIDTH) / CELL_WIDTH));
      vi.unstubAllGlobals();
    }
  });

  it('keeps the fallback constant equal to the scrollbar width index.css sets', () => {
    // The fallback is only reached pre-layout, so nothing else would notice it
    // drifting from the CSS. Parity here means changing the global scrollbar
    // width cannot silently leave the pre-layout fit wrong.
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/index.css'),
      'utf-8',
    );
    const globalRule = css.match(/^::-webkit-scrollbar\s*\{[^}]*?width:\s*(\d+)px/m);
    expect(
      globalRule,
      'Could not find the global `::-webkit-scrollbar { width: Npx }` rule in '
      + 'index.css. If the selector moved, update this test and FALLBACK_SCROLLBAR_WIDTH together.',
    ).not.toBeNull();
    expect(Number(globalRule![1])).toBe(FALLBACK_SCROLLBAR_WIDTH);
  });
});

describe('FitAddon.proposeDimensions -- collapsed container bails instead of clamping', () => {
  // A hidden/mid-transition container (tile/untile, visibility toggle) can report
  // a 0 (or NaN) box. Clamping to MINIMUM_COLS/MINIMUM_ROWS would still produce a
  // valid-looking 2x1 grid that flows all the way to sessions.resize, corrupting
  // the PTY's real width. proposeDimensions() must return undefined instead, so
  // fit() no-ops and the real grid survives until the container has real
  // dimensions again.
  let fitAddon: FitAddon;
  const { parentEl, elementEl } = makeElements();

  beforeEach(() => {
    fitAddon = new FitAddon();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns undefined when the parent width is 0', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'width'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when the parent height is 0', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'height'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when both dimensions are 0', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'both'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('fit() no-ops (never calls terminal.resize) against a collapsed container', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'both'));
    const terminal = makeTerminalStub(elementEl);
    const resize = vi.fn();
    (terminal as unknown as { resize: typeof resize }).resize = resize;
    fitAddon.activate(terminal);
    fitAddon.fit();
    expect(resize).not.toHaveBeenCalled();
  });
});

describe('FitAddon.proposeDimensions -- NaN parent box bails instead of clamping', () => {
  // A real-world collapsed/mid-transition container does not necessarily
  // report '0' from getComputedStyle - it can report '' or 'auto', which
  // parseInt turns into NaN, not 0. The guard in fit-addon.ts is written
  // as `!(parentWidth > 0) || !(parentHeight > 0)` specifically because that
  // form also rejects NaN (any comparison against NaN is false). An
  // equivalent-looking `parentWidth === 0 || parentHeight === 0` rewrite
  // would pass every '0'-only case in the describe block above while letting
  // a NaN box fall through to the clamp logic below it - the exact
  // corruption the guard exists to prevent (a valid-looking 2x1 grid flowing
  // to sessions.resize and corrupting the PTY's real width).
  //
  // parentWidth is `Math.max(0, parseInt(...))` and parentHeight is a bare
  // `parseInt(...)`; Math.max propagates NaN (Math.max(0, NaN) === NaN), so
  // both axes reach the guard as NaN and both return undefined - there is no
  // axis-specific carve-out to assert.
  //
  // Red-green: reverting the guard to `parentWidth === 0 || parentHeight === 0`
  // makes all three cases below return a clamped {cols: 2, rows: ...} /
  // {cols: ..., rows: 1} object instead of undefined.
  let fitAddon: FitAddon;
  const { parentEl, elementEl } = makeElements();

  beforeEach(() => {
    fitAddon = new FitAddon();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns undefined when the parent width computed style is NaN (e.g. \'\')', () => {
    vi.stubGlobal('window', makeNaNWindowStub(parentEl, 'width'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when the parent height computed style is NaN (e.g. \'\')', () => {
    vi.stubGlobal('window', makeNaNWindowStub(parentEl, 'height'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when both parent dimensions are NaN', () => {
    vi.stubGlobal('window', makeNaNWindowStub(parentEl, 'both'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });
});

describe('FitAddon.fit - reports what it did, and why it declined', () => {
  // fit() used to return void and proposeDimensions() collapsed all four bails
  // to `undefined`, so "the grid was resized to N" and "the fit declined and the
  // grid kept an older N" were indistinguishable from the outside. That is the
  // difference between the two repairs a mis-sized replay needs, and getting it
  // wrong is actively harmful: acting on a declined fit's stale columns would
  // ship that width to the PTY. The reload fit traces in useTerminal are the
  // consumer; without the outcome they could only report the number.
  let fitAddon: FitAddon;
  const { parentEl, elementEl } = makeElements();

  beforeEach(() => {
    fitAddon = new FitAddon();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the applied grid, matching what it passed to terminal.resize', () => {
    vi.stubGlobal('window', makeWindowStub(parentEl));
    const terminal = makeTerminalStub(elementEl);
    const resize = vi.fn();
    (terminal as unknown as { resize: typeof resize }).resize = resize;
    fitAddon.activate(terminal);
    expect(fitAddon.fit()).toEqual({ applied: true, cols: 99, rows: 37 });
    expect(resize).toHaveBeenCalledWith(99, 37);
  });

  it('names a collapsed container as no-parent-box', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'both'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.fit()).toEqual({ applied: false, reason: 'no-parent-box' });
  });

  it('names a NaN container as no-parent-box too (same guard, same stale grid)', () => {
    vi.stubGlobal('window', makeNaNWindowStub(parentEl, 'both'));
    fitAddon.activate(makeTerminalStub(elementEl));
    expect(fitAddon.fit()).toEqual({ applied: false, reason: 'no-parent-box' });
  });

  it('names an unmeasured cell as zero-cell', () => {
    // A render service mid-swap (the WebGL addon attaching or being disposed)
    // or a font not yet applied. THE state behind the reveal-width incident's
    // sibling failure mode: a fit taken here silently keeps the old grid.
    vi.stubGlobal('window', makeWindowStub(parentEl));
    const terminal = makeTerminalStub(elementEl);
    (terminal as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } })
      ._core._renderService.dimensions.css.cell = { width: 0, height: 0 };
    fitAddon.activate(terminal);
    expect(fitAddon.fit()).toEqual({ applied: false, reason: 'zero-cell' });
  });

  it('names a detached terminal as no-element', () => {
    vi.stubGlobal('window', makeWindowStub(parentEl));
    // Never activated, so there is no terminal at all - the same branch a
    // terminal disposed mid-replay takes.
    expect(fitAddon.fit()).toEqual({ applied: false, reason: 'no-element' });
  });

  it('names non-finite proposed dimensions, distinct from a missing parent box', () => {
    // The padding reads can be NaN of their own while the parent box is valid,
    // and Math.max propagates that rather than clamping it. This used to be
    // fit()'s private isNaN guard, invisible to proposeDimensions().
    vi.stubGlobal('window', {
      getComputedStyle: (element: unknown) => ({
        getPropertyValue: (prop: string): string => {
          if (element === parentEl) {
            if (prop === 'width') return String(PARENT_WIDTH);
            if (prop === 'height') return '600';
          }
          // The terminal element answers '' for padding, as a computed style
          // can before layout.
          return '';
        },
      }),
    });
    const terminal = makeTerminalStub(elementEl);
    const resize = vi.fn();
    (terminal as unknown as { resize: typeof resize }).resize = resize;
    fitAddon.activate(terminal);
    expect(fitAddon.fit()).toEqual({ applied: false, reason: 'non-finite-dims' });
    expect(resize).not.toHaveBeenCalled();
    // And the lossy public view still collapses it to undefined, so the two
    // stay consistent about which inputs are fittable.
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });
});
