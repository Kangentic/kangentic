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
 * API-compatible: activate(), dispose(), fit(), proposeDimensions().
 */
import type { Terminal, ITerminalAddon } from '@xterm/xterm';

export interface ITerminalDimensions {
  rows: number;
  cols: number;
}

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;
const DEFAULT_SCROLLBAR_WIDTH = 14;

export class FitAddon implements ITerminalAddon {
  private _terminal: Terminal | undefined;

  public activate(terminal: Terminal): void {
    this._terminal = terminal;
  }

  public dispose(): void {
    this._terminal = undefined;
  }

  public fit(): void {
    const dims = this.proposeDimensions();
    if (!dims || !this._terminal || isNaN(dims.cols) || isNaN(dims.rows)) {
      return;
    }
    // Always call resize(). xterm.Terminal.resize() internally no-ops
    // when dimensions haven't changed, which is the correct behavior.
    // The official addon has its own same-dimension guard that skips
    // resize() entirely (including renderService.clear()), which forces
    // callers to use perturbation tricks to bypass it.
    this._terminal.resize(dims.cols, dims.rows);
  }

  public proposeDimensions(): ITerminalDimensions | undefined {
    if (!this._terminal || !this._terminal.element || !this._terminal.element.parentElement) {
      return undefined;
    }

    // xterm 6.0 doesn't expose terminal.dimensions publicly.
    // Access cell dimensions via the same private API the official addon uses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (this._terminal as any)._core;
    const renderDimensions = core._renderService.dimensions;
    const cellWidth: number = renderDimensions.css.cell.width;
    const cellHeight: number = renderDimensions.css.cell.height;

    if (cellWidth === 0 || cellHeight === 0) {
      return undefined;
    }

    const scrollbarWidth = this._terminal.options.scrollback === 0
      ? 0
      : (this._terminal.options.overviewRuler?.width ?? DEFAULT_SCROLLBAR_WIDTH);

    const parentStyle = window.getComputedStyle(this._terminal.element.parentElement);
    const parentHeight = parseInt(parentStyle.getPropertyValue('height'));
    const parentWidth = Math.max(0, parseInt(parentStyle.getPropertyValue('width')));

    const elementStyle = window.getComputedStyle(this._terminal.element);
    const paddingVertical = parseInt(elementStyle.getPropertyValue('padding-top'))
      + parseInt(elementStyle.getPropertyValue('padding-bottom'));
    const paddingHorizontal = parseInt(elementStyle.getPropertyValue('padding-right'))
      + parseInt(elementStyle.getPropertyValue('padding-left'));

    const availableHeight = parentHeight - paddingVertical;
    const availableWidth = parentWidth - paddingHorizontal - scrollbarWidth;

    return {
      cols: Math.max(MINIMUM_COLS, Math.floor(availableWidth / cellWidth)),
      rows: Math.max(MINIMUM_ROWS, Math.floor(availableHeight / cellHeight)),
    };
  }
}
