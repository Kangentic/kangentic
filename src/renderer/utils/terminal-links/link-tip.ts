/**
 * The tip a terminal link shows on hover: what each link hotkey does with it, and
 * for an OSC 8 link whose text is not its URL, the URL it opens.
 *
 * One action is the one-row label tip every control shows. Two actions (the
 * default browser and the Kangentic browser, `link-actions.ts`) are two rows,
 * the plainer click first, each with its key chips at the right. A destination
 * line sits above them, muted and cut short past 480px, with a rule between.
 *
 * `Tooltip` (components/Tooltip.tsx) wraps one DOM element and places itself on that element's
 * box. A terminal link has no element: it is a range of cells xterm paints, and xterm reports the
 * hover from outside React. So this draws the same label tip by hand, with Tooltip's classes, its
 * dwell, its placement and its one-tip-at-a-time slot (`utils/tooltip.ts`), pointed at the cells
 * of the row under the pointer. It is still the one tooltip look (`one-tooltip.md`).
 *
 * It never takes Escape: in a terminal that key is the agent's interrupt, so the tip closes on it
 * and lets it through.
 */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { CLICK_TOKEN } from '../../../shared/keybindings';
import { IS_MAC, formatComboSegments } from '../keybindings';
import {
  KEY_CHIP_CLASS,
  LABEL_TIP_CLASS,
  LABEL_TIP_ROW_CLASS,
  LABEL_TIP_TEXT_CLASS,
  TIP_BASE_CLASS,
  TIP_KEYS_CLASS,
  TOOLTIP_DWELL_MS,
  claimTip,
  isTipWarm,
  placeTip,
  releaseTip,
  type TipAnchor,
} from '../tooltip';
import type { CellRange } from './buffer-line-text';
import type { LinkAction, LinkTarget } from './link-actions';

/** A URL (printed or OSC 8) opens in a browser; a printed path shows in the file manager. */
export type TerminalLinkKind = 'url' | 'path';

/** What xterm hands a link's `hover`, plus which kind of link it is. */
export interface LinkHover {
  event: Pick<MouseEvent, 'clientY'>;
  range: CellRange;
  kind: TerminalLinkKind;
  /** An OSC 8 link's address, which its cells may not read as. Absent for a printed link. */
  osc8Uri?: string;
}

/** One row of the tip: what the click does, and its key chips. */
export interface LinkTipRow {
  label: string;
  keys: string[];
  /** The browser the row opens, for a URL link. */
  target?: LinkTarget;
}

/** Everything the tip says. */
export interface LinkTipContent {
  /** The URL an OSC 8 link opens, when its text does not already say it. */
  destination: string | null;
  rows: LinkTipRow[];
}

/** Where the terminal's cells sit on screen, in viewport pixels. */
export interface CellGrid {
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  rows: number;
  cols: number;
  /** 0-based buffer row at the top of the viewport. */
  viewportY: number;
}

/**
 * The cells the link covers on the row under the pointer. A wrapped link spans several rows, and
 * a tip over its first row could sit far from the pointer. Null when that row is off screen.
 */
export function linkRowAnchor(range: CellRange, grid: CellGrid, pointerClientY: number): TipAnchor | null {
  if (grid.cellWidth <= 0 || grid.cellHeight <= 0) return null;
  const pointerViewportRow = Math.floor((pointerClientY - grid.top) / grid.cellHeight);
  // Buffer rows in a range are 1-based.
  const pointerBufferRow = grid.viewportY + pointerViewportRow + 1;
  const bufferRow = Math.min(Math.max(pointerBufferRow, range.start.y), range.end.y);
  const viewportRow = bufferRow - 1 - grid.viewportY;
  if (viewportRow < 0 || viewportRow >= grid.rows) return null;
  const firstColumn = bufferRow === range.start.y ? range.start.x : 1;
  const lastColumn = bufferRow === range.end.y ? range.end.x : grid.cols;
  const top = grid.top + viewportRow * grid.cellHeight;
  return {
    left: grid.left + (firstColumn - 1) * grid.cellWidth,
    width: (lastColumn - firstColumn + 1) * grid.cellWidth,
    top,
    bottom: top + grid.cellHeight,
  };
}

const TARGET_LABELS: Record<LinkTarget, MessageDescriptor> = {
  'default-browser': msg`Open in default browser`,
  'kangentic-browser': msg`Open in Kangentic browser`,
};
const SHOW_IN_FOLDER = msg`Show in folder`;
/** A printed path opens on Ctrl or Cmd click, whatever the link hotkeys are. */
const PATH_COMBO = `Mod+${CLICK_TOKEN}`;

function withoutTrailingSlash(text: string): string {
  return text.endsWith('/') ? text.slice(0, -1) : text;
}

/**
 * The URL an OSC 8 link's tip shows above its actions, or null when the cells
 * already read as that URL (a trailing slash aside). `cellText` is what the link's
 * cells show.
 */
export function osc8Destination(uri: string, cellText: string): string | null {
  return withoutTrailingSlash(cellText.trim()) === withoutTrailingSlash(uri) ? null : uri;
}

/**
 * The tip's words. A path shows in its folder; a URL lists the actions its link
 * hotkeys offer, in the plan's order. Null when there is nothing to say: a URL
 * with no link hotkey bound.
 */
export function linkTipContent(
  kind: TerminalLinkKind,
  actions: readonly LinkAction[],
  destination: string | null,
  isMac: boolean = IS_MAC,
): LinkTipContent | null {
  if (kind === 'path') {
    return { destination: null, rows: [{ label: i18n._(SHOW_IN_FOLDER), keys: formatComboSegments(PATH_COMBO, isMac) }] };
  }
  if (actions.length === 0) return null;
  return {
    destination,
    rows: actions.map((action) => ({
      label: i18n._(TARGET_LABELS[action.target]),
      keys: formatComboSegments(action.combo, isMac),
      target: action.target,
    })),
  };
}

/** The stacked shape: a destination line, a rule, then the rows. The rule runs edge to edge, so the padding is the parts'. */
const STACK_TIP_CLASS = 'flex w-max max-w-[min(480px,calc(100vw-16px))] flex-col bg-fg leading-4 text-surface';
const DESTINATION_CLASS = 'truncate px-2 py-1 text-tooltip-muted';
const RULE_CLASS = 'h-px shrink-0 bg-tooltip-chip-edge/40';
const ROWS_CLASS = 'grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-1 px-2 py-1';
const ROW_KEYS_CLASS = 'flex items-center gap-0.5 justify-self-end';

/** The part of an xterm `Terminal` the tip reads. */
export interface LinkTipTerminal {
  readonly element: HTMLElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: { readonly viewportY: number } };
}

export interface TerminalLinkTip {
  /** The pointer is on a link: show its tip after the dwell, or at once while tips are warm. */
  show(hover: LinkHover): void;
  /** xterm left the link. Closes the tip on the next tick unless the same link comes straight back. */
  leave(): void;
  /** The terminal is gone. Closes the tip and ignores every later hover. */
  dispose(): void;
}

// The address too: an agent can repaint a different OSC 8 link over the same cells.
function isSameLink(first: LinkHover, second: LinkHover): boolean {
  return first.kind === second.kind
    && first.osc8Uri === second.osc8Uri
    && first.range.start.x === second.range.start.x
    && first.range.start.y === second.range.start.y
    && first.range.end.x === second.range.end.x
    && first.range.end.y === second.range.end.y;
}

function gridOf(terminal: LinkTipTerminal, element: HTMLElement): CellGrid | null {
  const screen = element.querySelector('.xterm-screen');
  if (screen === null || terminal.cols <= 0 || terminal.rows <= 0) return null;
  // xterm sizes the screen element to exactly cols by rows cells.
  const rect = screen.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    cellWidth: rect.width / terminal.cols,
    cellHeight: rect.height / terminal.rows,
    rows: terminal.rows,
    cols: terminal.cols,
    viewportY: terminal.buffer.active.viewportY,
  };
}

/**
 * One per terminal. Its element must exist: call after `terminal.open()`.
 *
 * The pointer's time on one link is a VISIT. A busy agent repaints its screen many times a second,
 * and a repaint over the link's row makes xterm's Linkifier leave the link and hover it again in the
 * same tick. So a leave ends the visit only on the next tick, and a hover of the same link before
 * then carries on with the visit, its dwell and its tip. Without that, the dwell restarted on every
 * repaint and the tip never showed while an agent worked. A cold close (a press, the wheel, Escape)
 * keeps the tip shut for the rest of the visit, as a press on any trigger does.
 */
export function createTerminalLinkTip(
  terminal: LinkTipTerminal,
  describe: (hover: LinkHover) => LinkTipContent | null,
): TerminalLinkTip {
  let visit: LinkHover | null = null;
  let visitClosed = false;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let tipElement: HTMLDivElement | null = null;
  let removeWindowListeners: (() => void) | null = null;
  let disposed = false;

  const clearDwell = (): void => {
    if (dwellTimer === null) return;
    clearTimeout(dwellTimer);
    dwellTimer = null;
  };

  const clearLeave = (): void => {
    if (leaveTimer === null) return;
    clearTimeout(leaveTimer);
    leaveTimer = null;
  };

  /** Takes the tip off the page. `warm` for a leave or a replacement, so the next tip opens at once. */
  const removeTip = (warm: boolean): void => {
    if (tipElement === null) return;
    removeWindowListeners?.();
    removeWindowListeners = null;
    tipElement.remove();
    tipElement = null;
    releaseTip(closeAsReplaced, warm, performance.now());
  };

  const endVisit = (warm: boolean): void => {
    clearDwell();
    clearLeave();
    visit = null;
    visitClosed = false;
    removeTip(warm);
  };

  /** Shut for the rest of this visit. */
  const closeCold = (): void => {
    clearDwell();
    if (visit !== null) visitClosed = true;
    removeTip(false);
  };

  // Another tip taking the slot is a warm close, and this one stays shut until the pointer leaves.
  const closeAsReplaced = (): void => {
    clearDwell();
    if (visit !== null) visitClosed = true;
    removeTip(true);
  };

  const render = (hover: LinkHover, mode: 'cold' | 'warm'): void => {
    const element = terminal.element;
    if (disposed || visitClosed || element === undefined || !element.isConnected) return;
    const grid = gridOf(terminal, element);
    const anchor = grid === null ? null : linkRowAnchor(hover.range, grid, hover.event.clientY);
    if (anchor === null) return;
    const content = describe(hover);
    if (content === null || content.rows.length === 0) return;
    const ownerDocument = element.ownerDocument;
    const ownerWindow = ownerDocument.defaultView ?? window;

    claimTip(closeAsReplaced);
    const tip = ownerDocument.createElement('div');
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('data-tooltip', '');
    tip.setAttribute('data-testid', 'terminal-link-tip');
    const entrance = mode === 'cold' ? ' overlay-popover-in' : '';

    const rowLabel = (entry: LinkTipRow): HTMLSpanElement => {
      const text = ownerDocument.createElement('span');
      text.textContent = entry.label;
      if (entry.target) text.setAttribute('data-link-target', entry.target);
      return text;
    };

    const keyChips = (keys: readonly string[], className: string): HTMLSpanElement => {
      const chips = ownerDocument.createElement('span');
      chips.className = className;
      chips.setAttribute('data-tooltip-part', 'keys');
      for (const key of keys) {
        const chip = ownerDocument.createElement('kbd');
        chip.className = KEY_CHIP_CLASS;
        chip.textContent = key;
        chips.append(chip);
      }
      return chips;
    };

    if (content.destination === null && content.rows.length === 1) {
      // One action: the label tip every control shows.
      const [only] = content.rows;
      tip.setAttribute('data-shape', 'label');
      tip.className = `${TIP_BASE_CLASS} ${LABEL_TIP_CLASS}${entrance}`;
      const row = ownerDocument.createElement('span');
      row.className = LABEL_TIP_ROW_CLASS;
      const text = rowLabel(only);
      text.className = LABEL_TIP_TEXT_CLASS;
      row.append(text, keyChips(only.keys, TIP_KEYS_CLASS));
      tip.append(row);
    } else {
      tip.setAttribute('data-shape', 'stack');
      tip.className = `${TIP_BASE_CLASS} ${STACK_TIP_CLASS}${entrance}`;
      if (content.destination !== null) {
        const destination = ownerDocument.createElement('div');
        destination.className = DESTINATION_CLASS;
        destination.setAttribute('data-tooltip-part', 'destination');
        destination.textContent = content.destination;
        const rule = ownerDocument.createElement('div');
        rule.className = RULE_CLASS;
        rule.setAttribute('aria-hidden', 'true');
        tip.append(destination, rule);
      }
      const rows = ownerDocument.createElement('div');
      rows.className = ROWS_CLASS;
      for (const entry of content.rows) {
        rows.append(rowLabel(entry), keyChips(entry.keys, ROW_KEYS_CLASS));
      }
      tip.append(rows);
    }
    ownerDocument.body.append(tip);
    tipElement = tip;

    // offsetWidth/offsetHeight, not the rect: a cold tip enters from a scaled transform.
    const placement = placeTip(
      anchor,
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight },
    );
    tip.style.left = `${placement.left}px`;
    tip.style.top = `${placement.top}px`;
    tip.style.transformOrigin = placement.side === 'above' ? 'bottom center' : 'top center';
    tip.dataset.side = placement.side;

    // What closes any tip, as Tooltip's TipLayer does, except that Escape is never stopped.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) closeCold();
    };
    const handleScroll = (event: Event): void => {
      const target = event.target;
      if (target === ownerDocument || (target instanceof Node && target.contains(element))) closeCold();
    };
    ownerWindow.addEventListener('keydown', handleKeyDown, true);
    ownerWindow.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    ownerWindow.addEventListener('resize', closeCold);
    ownerWindow.addEventListener('blur', closeCold);
    removeWindowListeners = () => {
      ownerWindow.removeEventListener('keydown', handleKeyDown, true);
      ownerWindow.removeEventListener('scroll', handleScroll, true);
      ownerWindow.removeEventListener('resize', closeCold);
      ownerWindow.removeEventListener('blur', closeCold);
    };
  };

  // A press closes the tip, as a press on any trigger does, and so does the wheel, which moves the
  // cells out from under it. Both go with the element when the terminal is disposed.
  terminal.element?.addEventListener('mousedown', closeCold, { capture: true });
  terminal.element?.addEventListener('wheel', closeCold, { capture: true, passive: true });

  return {
    show: (hover) => {
      if (disposed) return;
      if (visit !== null && isSameLink(visit, hover)) {
        // The same link back after a repaint: the visit, its dwell and its tip carry on.
        clearLeave();
        return;
      }
      // A new link ends the last visit at once, so moving from one link to the next opens warm.
      endVisit(true);
      visit = hover;
      if (isTipWarm(performance.now())) {
        render(hover, 'warm');
        return;
      }
      dwellTimer = setTimeout(() => {
        dwellTimer = null;
        render(hover, 'cold');
      }, TOOLTIP_DWELL_MS);
    },
    leave: () => {
      if (visit === null || leaveTimer !== null) return;
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        endVisit(true);
      }, 0);
    },
    dispose: () => {
      disposed = true;
      endVisit(false);
    },
  };
}
