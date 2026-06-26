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
