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

    const availableHeight = parentHeight - paddingVertical;
    const availableWidth = parentWidth - paddingHorizontal - scrollbarWidth;

    const cols = Math.max(MINIMUM_COLS, Math.floor(availableWidth / cellWidth));
    const rows = Math.max(MINIMUM_ROWS, Math.floor(availableHeight / cellHeight));
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
