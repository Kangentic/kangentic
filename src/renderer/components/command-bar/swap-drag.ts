/**
 * Swap two Command Terminals by dragging one by its header onto another's
 * tile, the way a board card is dragged: the REAL terminal floats at its
 * current size (tilted, slightly see-through, with a shadow), a ghost marks the
 * tile it would land in, and the terminal already there previews in the
 * dragged one's old tile. On release the two swap tiles (`swapWindows`) and
 * take their new sizes; Escape, a cancel or the window losing focus puts
 * everything back.
 *
 * The real frame moves, never a copy: a second xterm on a live PTY is the bug
 * class terminal ownership exists to prevent. The frames are moved with inline
 * styles saved first and put back exactly, since React keeps setting only the
 * style values that change. PTY resizes are held for the gesture by the
 * manager-resize gate (the displaced terminal changes size under the preview),
 * and the drop's store commit sizes each terminal once.
 */

import { beginManagerResize, endManagerResize } from '../../window-manager/terminal/manager-resize-gate';

/** How far the pointer travels before a press on a header becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

/** The styles a drag changes on a frame, so it can put back exactly these. */
const MOVED_PROPERTIES = ['left', 'top', 'width', 'height', 'transform', 'opacity', 'zIndex', 'pointerEvents', 'transition'] as const;
type MovedProperty = typeof MOVED_PROPERTIES[number];

interface Tile {
  windowId: string;
  frame: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
  saved: Record<MovedProperty, string>;
}

interface SwapDragOptions {
  /** The terminal under the press. */
  windowId: string;
  /** Every terminal the drag may land on, the pressed one included. */
  windowIds: readonly string[];
  /** Commit a swap of the two windows' tiles. */
  swap: (draggedId: string, targetId: string) => void;
}

function frameOf(windowId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="window-frame-${windowId}"]`);
}

function readTile(windowId: string): Tile | null {
  const frame = frameOf(windowId);
  if (!frame) return null;
  const saved = {} as Record<MovedProperty, string>;
  for (const property of MOVED_PROPERTIES) saved[property] = frame.style[property];
  return { windowId, frame, left: frame.offsetLeft, top: frame.offsetTop, width: frame.offsetWidth, height: frame.offsetHeight, saved };
}

function restore(tile: Tile): void {
  for (const property of MOVED_PROPERTIES) tile.frame.style[property] = tile.saved[property];
  tile.frame.classList.remove('shadow-2xl', 'rounded-lg');
}

function restorePosition(tile: Tile): void {
  tile.frame.style.left = tile.saved.left;
  tile.frame.style.top = tile.saved.top;
  tile.frame.style.width = tile.saved.width;
  tile.frame.style.height = tile.saved.height;
}

function placeAt(frame: HTMLElement, tile: Pick<Tile, 'left' | 'top' | 'width' | 'height'>): void {
  frame.style.left = `${tile.left}px`;
  frame.style.top = `${tile.top}px`;
  frame.style.width = `${tile.width}px`;
  frame.style.height = `${tile.height}px`;
}

/**
 * Follow a press on a terminal's header. Does nothing until the pointer moves
 * past the threshold, so a click on the header stays a click.
 */
export function startCommandTerminalSwapDrag(event: React.PointerEvent, options: SwapDragOptions): void {
  if (event.button !== 0 || options.windowIds.length < 2) return;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  let tiles: Map<string, Tile> | null = null;
  let ghost: HTMLElement | null = null;
  let targetId: string | null = null;

  const activate = (): boolean => {
    const read = new Map<string, Tile>();
    for (const id of options.windowIds) {
      const tile = readTile(id);
      if (tile) read.set(id, tile);
    }
    const dragged = read.get(options.windowId);
    if (!dragged || read.size < 2) return false;
    tiles = read;
    beginManagerResize();
    dragged.frame.style.transition = 'none';
    dragged.frame.style.opacity = '0.9';
    dragged.frame.style.zIndex = '1000';
    dragged.frame.style.pointerEvents = 'none';
    dragged.frame.classList.add('shadow-2xl', 'rounded-lg');
    ghost = document.createElement('div');
    ghost.className = 'pointer-events-none absolute hidden rounded-lg border border-edge bg-surface-raised opacity-40';
    ghost.setAttribute('data-testid', 'command-terminal-swap-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    const title = dragged.frame.querySelector('[data-testid="command-bar-label"]')?.textContent ?? '';
    const ghostHeader = document.createElement('div');
    ghostHeader.className = 'flex h-[54px] items-center border-b border-edge px-4 text-base font-semibold text-fg';
    ghostHeader.textContent = title;
    ghost.appendChild(ghostHeader);
    dragged.frame.parentElement?.appendChild(ghost);
    return true;
  };

  const showTarget = (nextTargetId: string | null): void => {
    if (nextTargetId === targetId || !tiles) return;
    const dragged = tiles.get(options.windowId);
    if (!dragged) return;
    const previous = targetId ? tiles.get(targetId) : undefined;
    if (previous) restorePosition(previous);
    targetId = nextTargetId;
    const next = nextTargetId ? tiles.get(nextTargetId) : undefined;
    if (!ghost) return;
    if (!next) {
      ghost.classList.add('hidden');
      return;
    }
    // The terminal already there moves into the dragged one's old tile, and the
    // ghost takes its place.
    placeAt(next.frame, dragged);
    placeAt(ghost, next);
    ghost.classList.remove('hidden');
  };

  const onMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;
    if (!tiles) {
      if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;
      if (!activate()) {
        stop();
        return;
      }
    }
    const activeTiles = tiles as Map<string, Tile> | null;
    const dragged = activeTiles?.get(options.windowId);
    if (!activeTiles || !dragged) return;
    dragged.frame.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) rotate(1.5deg)`;
    const overlay = dragged.frame.parentElement?.getBoundingClientRect();
    if (!overlay) return;
    const pointerX = moveEvent.clientX - overlay.left;
    const pointerY = moveEvent.clientY - overlay.top;
    let hit: string | null = null;
    for (const tile of activeTiles.values()) {
      if (tile.windowId === options.windowId) continue;
      if (pointerX >= tile.left && pointerX < tile.left + tile.width && pointerY >= tile.top && pointerY < tile.top + tile.height) {
        hit = tile.windowId;
        break;
      }
    }
    showTarget(hit);
  };

  // Runs once: a blur after the release finds nothing left to finish.
  const finish = (commit: boolean): void => {
    const activeTiles = tiles;
    const landedOn = targetId;
    stop();
    tiles = null;
    targetId = null;
    if (!activeTiles) return;
    for (const tile of activeTiles.values()) restore(tile);
    ghost?.remove();
    ghost = null;
    if (commit && landedOn) options.swap(options.windowId, landedOn);
    endManagerResize();
  };

  const onUp = (upEvent: PointerEvent): void => {
    if (upEvent.pointerId === pointerId) finish(true);
  };
  const onCancel = (cancelEvent: PointerEvent): void => {
    if (cancelEvent.pointerId === pointerId) finish(false);
  };
  const onBlur = (): void => finish(false);
  // Escape cancels a drag in flight, before the panel or a terminal sees it.
  const onKey = (keyEvent: KeyboardEvent): void => {
    if (keyEvent.key !== 'Escape' || !tiles) return;
    keyEvent.stopImmediatePropagation();
    finish(false);
  };

  function stop(): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('keydown', onKey, true);
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onBlur);
  document.addEventListener('keydown', onKey, true);
}
