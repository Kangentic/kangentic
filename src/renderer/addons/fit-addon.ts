/**
 * Custom FitAddon for xterm.js. Drop-in replacement for @xterm/addon-fit.
 *
 * Differences from the official addon:
 * - No same-dimension guard in fit(). Always calls terminal.resize(),
 *   letting xterm's own internal guard handle no-ops. Eliminates the need
 *   for perturbation tricks (resize to rows-1 then fit) that cause race
 *   conditions with ResizeObserver in resizable containers.
 * - No _renderService.clear() before resize. The upstream master has
 *   already removed this call.
 *
 * API-compatible: activate(), dispose(), fit(), proposeDimensions(). fit()
 * additionally RETURNS its outcome (see FitOutcome); every existing caller
 * ignores it, so that is source-compatible. describeProposedDimensions() is an
 * addition beyond that surface, not part of the compatible one.
 */
import type { Terminal, ITerminalAddon } from '@xterm/xterm';

export interface ITerminalDimensions {
  rows: number;
  cols: number;
}

/** Why a fit declined to resize. Each maps to one guard in
 *  describeProposedDimensions(); see the comments there. */
export type FitBailReason =
  /** No terminal, no element, or the element is not in a parent yet. */
  | 'no-element'
  /** The render service has not measured a cell yet (mid renderer swap, or
   *  before the font has been applied). */
  | 'zero-cell'
  /** The parent box measures 0 or NaN: a collapsed or mid-transition container. */
  | 'no-parent-box'
  /** The proposed grid came out NaN (a computed style returned '' or 'auto'). */
  | 'non-finite-dims';

/**
 * The outcome of a fit, made explicit so callers can tell "resized to N columns"
 * apart from "declined, the grid still holds whatever it held".
 *
 * fit() used to return void, and all four bails above were silent. That is a
 * real diagnostic hole rather than a theoretical one: a bailed fit before a
 * scrollback replay writes a frame sized for the PTY's width into a grid that
 * kept some older width, and because xterm never reflows the ALTERNATE buffer,
 * those wraps are permanent. From the outside that is indistinguishable from a
 * fit that ran and genuinely proposed the narrower width, and the two need
 * opposite repairs. See useTerminal's reload fit traces.
 */
export type FitOutcome =
  | { applied: true; cols: number; rows: number }
  | { applied: false; reason: FitBailReason };

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
/** proposeFontSizeForGrid rounds down to this step. */
export const CONFORM_FONT_STEP_PX = 0.25;
/** Below this, a held grid is not shown scaled: the caller keeps its own fit. */
export const CONFORM_MIN_FONT_PX = 4;

type FitInputs =
  | { applied: true; cellWidth: number; cellHeight: number; availableWidth: number; availableHeight: number }
  | { applied: false; reason: FitBailReason };

/** A cell's CSS size, as the renderer measured it at some font. */
export interface CellSize {
  width: number;
  height: number;
}
/** Scrollbar gutter assumed only before `.xterm-viewport` has been laid out, so
 *  `offsetWidth - clientWidth` cannot be measured yet. Matches the global
 *  `::-webkit-scrollbar` width in `index.css` (the width the browser actually
 *  reserves); `tests/unit/fit-addon.test.ts` pins the two together. */
export const FALLBACK_SCROLLBAR_WIDTH = 8;

export class FitAddon implements ITerminalAddon {
  private _terminal: Terminal | undefined;

  public activate(terminal: Terminal): void {
    this._terminal = terminal;
  }

  public dispose(): void {
    this._terminal = undefined;
  }

  public fit(): FitOutcome {
    const outcome = this.describeProposedDimensions();
    if (!outcome.applied || !this._terminal) return outcome;
    // Always call resize(). xterm.Terminal.resize() internally no-ops
    // when dimensions haven't changed, which is the correct behavior.
    // The official addon has its own same-dimension guard that skips
    // resize() entirely (including renderService.clear()), which forces
    // callers to use perturbation tricks to bypass it.
    this._terminal.resize(outcome.cols, outcome.rows);
    return outcome;
  }

  public proposeDimensions(): ITerminalDimensions | undefined {
    const outcome = this.describeProposedDimensions();
    return outcome.applied ? { cols: outcome.cols, rows: outcome.rows } : undefined;
  }

  /**
   * proposeDimensions() with the bail reason kept instead of collapsed to
   * `undefined`. The single implementation of the fit math; proposeDimensions()
   * is the lossy public view of it.
   */
  public describeProposedDimensions(): FitOutcome {
    const inputs = this._measureFitInputs();
    if (!inputs.applied) return inputs;
    const cols = Math.max(MINIMUM_COLS, Math.floor(inputs.availableWidth / inputs.cellWidth));
    const rows = Math.max(MINIMUM_ROWS, Math.floor(inputs.availableHeight / inputs.cellHeight));
    // The padding reads above can be NaN of their own (a computed style that
    // answers '' or 'auto'), which Math.max propagates rather than clamps. This
    // was fit()'s own isNaN guard; it lives here so proposeDimensions() and
    // fit() bail on exactly the same inputs.
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return { applied: false, reason: 'non-finite-dims' };
    }

    return { applied: true, cols, rows };
  }

  /**
   * The largest font size at which a FIXED grid of `cols` by `rows` fits the
   * container, or null when the container cannot be measured or the grid would
   * need type smaller than CONFORM_MIN_FONT_PX.
   *
   * The inverse of describeProposedDimensions(): that one takes the font as
   * given and asks how many cells fit; this one takes the cells as given and
   * asks how big the font can be. A terminal uses it when main HOLDS a grid
   * against its resize (SessionResizeResult.held): the PTY keeps addressing
   * that grid, so the terminal shows exactly that grid, scaled into its pane,
   * rather than its own fit with the PTY's frame wrapped or clipped inside it.
   *
   * A cell scales with the font size linearly enough that one measurement at
   * the current size is the whole calculation; the caller re-measures after
   * applying and steps down if rounding left the grid a pixel over. The result
   * is floored to a quarter pixel so two panes a few pixels apart land on the
   * same size and the texture atlas is not re-rasterized for every subpixel.
   */
  public proposeFontSizeForGrid(cols: number, rows: number, currentFontSize: number): number | null {
    const inputs = this._measureFitInputs();
    if (!inputs.applied || !(cols > 0) || !(rows > 0) || !(currentFontSize > 0)) return null;
    const scale = Math.min(
      inputs.availableWidth / (cols * inputs.cellWidth),
      inputs.availableHeight / (rows * inputs.cellHeight),
    );
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const fontSize = Math.floor((currentFontSize * scale) / CONFORM_FONT_STEP_PX) * CONFORM_FONT_STEP_PX;
    return fontSize >= CONFORM_MIN_FONT_PX ? fontSize : null;
  }

  /** The cell the renderer measures at the terminal's current font, or null before it has one. */
  public measureCell(): CellSize | null {
    const inputs = this._measureFitInputs();
    return inputs.applied ? { width: inputs.cellWidth, height: inputs.cellHeight } : null;
  }

  /**
   * The grid the container would take with the given cell, without applying
   * anything: the same division as describeProposedDimensions over the current
   * box. A held terminal (conformed to another grid at another font) probes main
   * with this, passing the cell it measured at the CONFIGURED font, so the answer
   * is about the grid it would fit on its own, not the one it is showing on
   * main's behalf. The cell is remembered rather than derived from the current
   * one: a cell does not scale linearly with the font (the renderer rounds it to
   * device pixels), and the estimate was off by ten columns in practice.
   */
  public proposeDimensionsForCell(cell: CellSize): ITerminalDimensions | undefined {
    const inputs = this._measureFitInputs();
    if (!inputs.applied || !(cell.width > 0) || !(cell.height > 0)) return undefined;
    const cols = Math.max(MINIMUM_COLS, Math.floor(inputs.availableWidth / cell.width));
    const rows = Math.max(MINIMUM_ROWS, Math.floor(inputs.availableHeight / cell.height));
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
    return { cols, rows };
  }

  /** The inputs both proposals share: the cell the renderer measured and the box left for the grid. */
  private _measureFitInputs(): FitInputs {
    if (!this._terminal || !this._terminal.element || !this._terminal.element.parentElement) {
      return { applied: false, reason: 'no-element' };
    }

    // xterm 6.0 doesn't expose terminal.dimensions publicly.
    // Access cell dimensions via the same private API the official addon uses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (this._terminal as any)._core;
    const renderDimensions = core._renderService.dimensions;
    const cellWidth: number = renderDimensions.css.cell.width;
    const cellHeight: number = renderDimensions.css.cell.height;

    if (cellWidth === 0 || cellHeight === 0) {
      return { applied: false, reason: 'zero-cell' };
    }

    const scrollbarWidth = this._measureScrollbarGutter();

    const parentStyle = window.getComputedStyle(this._terminal.element.parentElement);
    const parentHeight = parseInt(parentStyle.getPropertyValue('height'));
    const parentWidth = Math.max(0, parseInt(parentStyle.getPropertyValue('width')));

    // A collapsed or hidden container (a visibility toggle mid-transition, a
    // tile/untile or reflow race) reports a 0 (or NaN) box. Clamping to
    // MINIMUM_COLS/MINIMUM_ROWS below would still produce a valid-looking 2x1
    // grid that flows all the way to sessions.resize, corrupting the PTY's
    // real width instead of leaving it alone. Bail here instead - the next
    // real resize/refit (once the container has real dimensions again)
    // supplies the true grid. `> 0` also rejects NaN.
    if (!(parentWidth > 0) || !(parentHeight > 0)) {
      return { applied: false, reason: 'no-parent-box' };
    }

    const elementStyle = window.getComputedStyle(this._terminal.element);
    const paddingVertical = parseInt(elementStyle.getPropertyValue('padding-top'))
      + parseInt(elementStyle.getPropertyValue('padding-bottom'));
    const paddingHorizontal = parseInt(elementStyle.getPropertyValue('padding-right'))
      + parseInt(elementStyle.getPropertyValue('padding-left'));

    return {
      applied: true,
      cellWidth,
      cellHeight,
      availableHeight: parentHeight - paddingVertical,
      availableWidth: parentWidth - paddingHorizontal - scrollbarWidth,
    };
  }

  /**
   * The width the browser reserves for the vertical scrollbar, measured off the
   * DOM rather than assumed.
   *
   * xterm's own stylesheet sets `.xterm-viewport { overflow-y: scroll }`, so that
   * gutter is reserved unconditionally: in the alternate screen buffer too, and
   * whether or not there is anything to scroll. Measuring it is what makes a fit
   * DETERMINISTIC, which is the property that matters here - the same container
   * must always produce the same column count, because every distinct column
   * count costs a PTY resize and a full agent repaint.
   *
   * This replaced an alternate-buffer special case that reclaimed the whole
   * gutter, on the premise that a fullscreen TUI has no scrollbar. It has one,
   * and the branch caused two bugs:
   *
   * - The buffer mode flips from `normal` to `alternate` DURING a mount, the
   *   moment the scrollback replay writes the TUI's alt-screen enter. So the
   *   mount fit and the post-replay refit disagreed by two columns on every
   *   open, handing the PTY two widths and making the user watch the agent's
   *   second repaint land. Under Claude Code's `/tui fullscreen` that is every
   *   session, every time.
   * - Reclaiming a gutter the DOM still reserves pushed the grid past the
   *   visible viewport, clipping the right-hand column.
   *
   * The empty strip that reclaim was written to fix was real, but its cause was
   * a mismatch, not the buffer mode: reserving a hardcoded 14px against an
   * 8px gutter leaves 12px blank. Reserving the measured width closes it
   * properly.
   *
   * Do not reintroduce a buffer-mode branch, or any other input that can change
   * after mount - that is precisely what makes a fit non-deterministic.
   */
  private _measureScrollbarGutter(): number {
    const viewport = this._terminal?.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!viewport || viewport.offsetWidth === 0) return FALLBACK_SCROLLBAR_WIDTH;
    return Math.max(0, viewport.offsetWidth - viewport.clientWidth);
  }
}
