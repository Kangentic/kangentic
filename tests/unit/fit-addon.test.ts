/**
 * Unit coverage for FitAddon.proposeDimensions() -- alt-buffer scrollbar reclaim.
 *
 * proposeDimensions() touches:
 *   _terminal.element / .parentElement  (plain objects stubbed below)
 *   _terminal.options.scrollback / overviewRuler?.width
 *   _terminal.buffer?.active?.type  ('normal' | 'alternate')
 *   _terminal._core._renderService.dimensions.css.cell  (private xterm API, plain object)
 *   window.getComputedStyle  (mocked via vi.stubGlobal; jsdom not required)
 *
 * No DOM environment needed: every dependency is a plain-object stub or a
 * vi.stubGlobal('window', ...) mock. All three cases are fully deterministic.
 *
 * Geometry used across all cases:
 *   parentWidth = 800, parentHeight = 600, padding = 0 on terminal element
 *   cellWidth = 8, cellHeight = 16
 *   DEFAULT_SCROLLBAR_WIDTH = 14  (matches the constant in fit-addon.ts)
 *
 * Column derivation:
 *   scrollbarWidth = 0  -> cols = floor(800 / 8) = 100
 *   scrollbarWidth = 14 -> cols = floor((800 - 14) / 8) = floor(786 / 8) = 98
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { FitAddon } from '../../src/renderer/addons/fit-addon';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

/** Pair of parent/element objects that satisfy proposeDimensions()'s early-exit
 *  checks without any real DOM. parentElement is non-null (truthy), so the
 *  guard `!_terminal.element.parentElement` passes. */
function makeElements() {
  const parentEl = {};
  const elementEl = { parentElement: parentEl };
  return { parentEl, elementEl };
}

/** Build a minimal Terminal-shaped stub. The private _core path uses `as any`
 *  in the source, so a plain object satisfies it without type gymnastics. */
function makeTerminalStub(
  elementEl: { parentElement: object },
  bufferType: 'normal' | 'alternate',
  scrollback: number,
): Terminal {
  return {
    element: elementEl,
    options: { scrollback },
    buffer: { active: { type: bufferType } },
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: 8, height: 16 } } },
      },
    },
  } as unknown as Terminal;
}

// ---------------------------------------------------------------------------
// Shared mock-window setup -- returns controlled geometry for both the parent
// element (800x600) and the terminal element (zero padding).
// ---------------------------------------------------------------------------

function makeWindowStub(parentEl: object) {
  return {
    getComputedStyle: (element: unknown) => ({
      getPropertyValue: (prop: string): string => {
        if (element === parentEl) {
          if (prop === 'width') return '800';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FitAddon.proposeDimensions -- alt-buffer scrollbar reclaim', () => {
  let fitAddon: FitAddon;
  const { parentEl, elementEl } = makeElements();

  beforeEach(() => {
    fitAddon = new FitAddon();
    vi.stubGlobal('window', makeWindowStub(parentEl));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normal buffer with scrollback reserves the scrollbar column (baseline behavior)', () => {
    // scrollback > 0 and type === 'normal': scrollbarWidth = DEFAULT_SCROLLBAR_WIDTH (14).
    // availableWidth = 800 - 14 = 786 -> cols = floor(786 / 8) = 98.
    // Verifies pre-existing behavior is not disturbed by the alt-buffer change.
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
    fitAddon.activate(terminal);
    const dims = fitAddon.proposeDimensions();
    expect(dims).toBeDefined();
    expect(dims!.cols).toBe(98);
  });

  it('alternate buffer reclaims the scrollbar column regardless of scrollback', () => {
    // buffer.active.type === 'alternate': inAltBuffer = true -> scrollbarWidth = 0.
    // availableWidth = 800 -> cols = floor(800 / 8) = 100.
    // RED: reverting `|| inAltBuffer` from the condition makes scrollbarWidth = 14,
    //      so cols = 98 and this assertion fails, pinning the fix.
    const terminal = makeTerminalStub(elementEl, 'alternate', 1000);
    fitAddon.activate(terminal);
    const dims = fitAddon.proposeDimensions();
    expect(dims).toBeDefined();
    expect(dims!.cols).toBe(100);
  });

  it('normal buffer with scrollback=0 also reclaims the scrollbar (prior behavior unchanged)', () => {
    // The scrollback === 0 branch pre-dated the alt-buffer change. Verify it still gives
    // scrollbarWidth = 0 -> cols = 100 after our edit.
    const terminal = makeTerminalStub(elementEl, 'normal', 0);
    fitAddon.activate(terminal);
    const dims = fitAddon.proposeDimensions();
    expect(dims).toBeDefined();
    expect(dims!.cols).toBe(100);
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
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
    fitAddon.activate(terminal);
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when the parent height is 0', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'height'));
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
    fitAddon.activate(terminal);
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when both dimensions are 0', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'both'));
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
    fitAddon.activate(terminal);
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('fit() no-ops (never calls terminal.resize) against a collapsed container', () => {
    vi.stubGlobal('window', makeCollapsedWindowStub(parentEl, 'both'));
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
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
  // parseInt turns into NaN, not 0. The guard at fit-addon.ts:88 is written
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
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
    fitAddon.activate(terminal);
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when the parent height computed style is NaN (e.g. \'\')', () => {
    vi.stubGlobal('window', makeNaNWindowStub(parentEl, 'height'));
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
    fitAddon.activate(terminal);
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });

  it('returns undefined when both parent dimensions are NaN', () => {
    vi.stubGlobal('window', makeNaNWindowStub(parentEl, 'both'));
    const terminal = makeTerminalStub(elementEl, 'normal', 1000);
    fitAddon.activate(terminal);
    expect(fitAddon.proposeDimensions()).toBeUndefined();
  });
});
