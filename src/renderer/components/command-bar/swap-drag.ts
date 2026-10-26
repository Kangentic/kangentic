/**
 * Swap two Command Terminals by dragging one by its header onto another's
 * tile. A picture of the pressed terminal, taken on the press, follows the
 * pointer at the size of the smallest tile. The terminals themselves stay live
 * in the panel: over another tile, the dragged one moves into that tile and the
 * terminal there moves into the dragged one's, each refit to the tile it now
 * sits in, so the panel shows the swap as it will be once made. On release the
 * picture goes and the two swap tiles (`swapWindows`), already at their sizes;
 * Escape, a cancel or the window losing focus puts everything back and refits it.
 *
 * The real frames move, never a copy: a second xterm on a live PTY is the bug
 * class terminal ownership exists to prevent, which is also why the thing
 * under the pointer is a picture and not a terminal. The frames are moved with
 * inline styles saved first and put back exactly, since React keeps setting
 * only the style values that change. A preview changes sizes in single steps,
 * never per pointer frame, so each step is a layout change of its own
 * (`terminal-layout-transition.ts`), as the cancel and the commit are: each
 * terminal it resizes keeps its last frame (or, in a tile bigger than it, shows
 * nothing) until its agent has repainted, then draws the new frame once, and
 * sends one resize per step.
 */

import { scheduleWindowTerminalResize } from '../../window-manager/terminal/resize-coalescer';
import { runTerminalLayoutChange, terminalLayoutScopeOf } from '../../utils/terminal-layout-transition';

/** How far the pointer travels before a press on a header becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

/**
 * How long the drag waits for the picture before it previews the swap without
 * one. A capture measured 51 ms; a window that is not compositing may never
 * answer, and the preview must not wait on it.
 */
const PICTURE_WAIT_MS = 300;

/** How far inside the float's edge the grab point stays when the float is cut narrower than its terminal. */
const GRAB_MARGIN_PX = 48;

/** The styles a drag changes on a frame, so it can put back exactly these. */
const MOVED_PROPERTIES = ['left', 'top', 'width', 'height', 'pointerEvents'] as const;
type MovedProperty = typeof MOVED_PROPERTIES[number];

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Tile extends Box {
  windowId: string;
  frame: HTMLElement;
  saved: Record<MovedProperty, string>;
}

/** The picture under the pointer and the part of its terminal it shows. */
interface Float {
  element: HTMLElement;
  /** How far into its terminal the float's cut starts. */
  cutLeft: number;
  cutTop: number;
  /** The dragged terminal's full size, which the picture keeps. */
  terminalWidth: number;
  terminalHeight: number;
}

interface SwapDragOptions {
  /** The terminal under the press. */
  windowId: string;
  /** Every terminal the drag may land on, the pressed one included. */
  windowIds: readonly string[];
  /** Commit a swap of the two windows' tiles. */
  swap: (draggedId: string, targetId: string) => void;
  /** The terminals' background, which fills the landing tile while the drag holds it and the float until its picture arrives. */
  terminalBackground: string;
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
}

function restorePosition(tile: Tile): void {
  tile.frame.style.left = tile.saved.left;
  tile.frame.style.top = tile.saved.top;
  tile.frame.style.width = tile.saved.width;
  tile.frame.style.height = tile.saved.height;
}

function placeAt(element: HTMLElement, box: Box): void {
  element.style.left = `${box.left}px`;
  element.style.top = `${box.top}px`;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
}

/** Refit the terminals in `frames` to the boxes they now have, as a layout change. */
function refitTerminals(frames: readonly HTMLElement[]): void {
  if (frames.length === 0) return;
  runTerminalLayoutChange(terminalLayoutScopeOf(frames[0]), scheduleWindowTerminalResize);
}

/**
 * What the window shows inside `frame` right now, or null when it cannot be
 * read (the web build) or does not answer within PICTURE_WAIT_MS. A picture
 * arriving after that is dropped: by then the preview may have moved the frames.
 */
async function pictureOf(frame: HTMLElement): Promise<string | null> {
  const box = frame.getBoundingClientRect();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PICTURE_WAIT_MS); });
  try {
    return await Promise.race([
      window.electronAPI.window.captureRegion({ x: box.left, y: box.top, width: box.width, height: box.height }),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Where `grab` sits along an edge of `full`, cut to `cut`, keeps it GRAB_MARGIN_PX inside the cut. */
function cutStart(grab: number, cut: number, full: number): number {
  return Math.min(Math.max(0, grab + GRAB_MARGIN_PX - cut), full - cut);
}

/**
 * The thing under the pointer: the dragged terminal cut to the smallest tile's
 * width and height, so it never covers more than one tile and the drop area
 * stays in view. The picture keeps its terminal's size, so the cut is a window
 * onto it around the grab point (the top of a taller terminal, its header
 * included) and nothing moves when the drag starts. Until the picture arrives,
 * or without one, the float shows the terminal's title over its background, so
 * the drag never shows an empty box.
 */
function buildFloat(dragged: Tile, tiles: Iterable<Tile>, grabX: number, grabY: number, background: string): Float {
  let width = dragged.width;
  let height = dragged.height;
  for (const tile of tiles) {
    width = Math.min(width, tile.width);
    height = Math.min(height, tile.height);
  }
  const cutLeft = cutStart(grabX, width, dragged.width);
  const cutTop = cutStart(grabY, height, dragged.height);
  const element = document.createElement('div');
  element.className = 'pointer-events-none absolute overflow-hidden rounded-lg border border-edge shadow-2xl';
  placeAt(element, { left: dragged.left + cutLeft, top: dragged.top + cutTop, width, height });
  element.style.backgroundColor = background;
  element.style.opacity = '0.9';
  element.style.zIndex = '1000';
  element.setAttribute('data-testid', 'command-terminal-swap-float');
  element.setAttribute('aria-hidden', 'true');
  const title = dragged.frame.querySelector('[data-testid="command-bar-label"]')?.textContent ?? '';
  const header = document.createElement('div');
  header.className = 'flex h-[54px] items-center border-b border-edge bg-surface-raised px-4 text-base font-semibold text-fg';
  header.textContent = title;
  element.appendChild(header);
  return { element, cutLeft, cutTop, terminalWidth: dragged.width, terminalHeight: dragged.height };
}

/** The picture at its terminal's own size, placed so the float shows its cut. */
function paintPicture(float: Float, picture: string): void {
  const image = document.createElement('img');
  image.src = picture;
  image.alt = '';
  image.draggable = false;
  image.className = 'absolute max-w-none';
  // Inside the float's 1px border, so the picture's own frame edge lines up with it.
  image.style.left = `${-float.cutLeft - 1}px`;
  image.style.top = `${-float.cutTop - 1}px`;
  image.style.width = `${float.terminalWidth}px`;
  image.style.height = `${float.terminalHeight}px`;
  image.setAttribute('data-testid', 'command-terminal-swap-picture');
  float.element.replaceChildren(image);
}

/**
 * The landing tile while the drag holds it: an empty terminal, its background
 * and nothing else, inside an accent ring. The picture under the pointer shows
 * what lands, so the live terminal already refitting in that tile stays
 * covered rather than showing the same terminal twice. Its own element over the
 * tile, above the live terminal and below the picture, so it never reaches
 * inside a frame and takes no pointer.
 */
function buildLandingMark(background: string): HTMLElement {
  const mark = document.createElement('div');
  mark.className = 'pointer-events-none absolute hidden ring-2 ring-inset ring-accent/60';
  mark.style.backgroundColor = background;
  mark.style.zIndex = '999';
  mark.setAttribute('data-testid', 'command-terminal-swap-landing');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
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
  // Where the overlay sits on screen, read once when the drag starts: the drag
  // moves frames inside it, never the overlay, so a read per move would only
  // force a layout after each preview's style writes.
  let overlayOrigin: { left: number; top: number } | null = null;
  let float: Float | null = null;
  let landingMark: HTMLElement | null = null;
  let targetId: string | null = null;
  // The tile the pointer is over, shown once the picture is in: moving the
  // real frames before the window was read would put them in the picture.
  let pointedId: string | null = null;
  // undefined while the capture is out, then the picture or null.
  let picture: string | null | undefined;
  let finished = false;

  // Taken now, before anything moves, so the picture is the terminal as it was pressed.
  const pressed = frameOf(options.windowId);
  if (pressed) {
    void pictureOf(pressed).then((captured) => {
      picture = captured;
      if (finished) return;
      if (float && captured) paintPicture(float, captured);
      showTarget(pointedId);
    });
  } else {
    picture = null;
  }

  const activate = (): boolean => {
    const read = new Map<string, Tile>();
    for (const id of options.windowIds) {
      const tile = readTile(id);
      if (tile) read.set(id, tile);
    }
    const dragged = read.get(options.windowId);
    const overlay = dragged?.frame.parentElement?.getBoundingClientRect();
    if (!dragged || !overlay || read.size < 2) return false;
    tiles = read;
    overlayOrigin = { left: overlay.left, top: overlay.top };
    // The pointer crosses the terminals all drag long; none of them reacts to it.
    for (const tile of read.values()) tile.frame.style.pointerEvents = 'none';
    const grabX = startX - overlay.left - dragged.left;
    const grabY = startY - overlay.top - dragged.top;
    float = buildFloat(dragged, read.values(), grabX, grabY, options.terminalBackground);
    if (picture) paintPicture(float, picture);
    landingMark = buildLandingMark(options.terminalBackground);
    dragged.frame.parentElement?.append(landingMark, float.element);
    return true;
  };

  const showTarget = (nextTargetId: string | null): void => {
    if (!tiles || picture === undefined || nextTargetId === targetId) return;
    const dragged = tiles.get(options.windowId);
    if (!dragged) return;
    const previous = targetId ? tiles.get(targetId) : undefined;
    const moved: HTMLElement[] = [];
    if (previous) {
      restorePosition(previous);
      moved.push(previous.frame);
    }
    targetId = nextTargetId;
    const next = nextTargetId ? tiles.get(nextTargetId) : undefined;
    if (next) {
      // The swap, shown with the real terminals: each in the other's tile,
      // and the tile the dragged one lands in marked.
      placeAt(dragged.frame, next);
      placeAt(next.frame, dragged);
      moved.push(dragged.frame, next.frame);
      if (landingMark) {
        placeAt(landingMark, next);
        landingMark.classList.remove('hidden');
      }
    } else {
      landingMark?.classList.add('hidden');
      if (previous) {
        restorePosition(dragged);
        moved.push(dragged.frame);
      }
    }
    refitTerminals(moved);
  };

  const onMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;
    if (!tiles) {
      if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;
      if (!activate()) {
        finish(false);
        return;
      }
    }
    const activeTiles = tiles as Map<string, Tile> | null;
    const dragged = activeTiles?.get(options.windowId);
    if (!activeTiles || !dragged || !float || !overlayOrigin) return;
    float.element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    const pointerX = moveEvent.clientX - overlayOrigin.left;
    const pointerY = moveEvent.clientY - overlayOrigin.top;
    let hit: string | null = null;
    for (const tile of activeTiles.values()) {
      if (tile.windowId === options.windowId) continue;
      if (pointerX >= tile.left && pointerX < tile.left + tile.width && pointerY >= tile.top && pointerY < tile.top + tile.height) {
        hit = tile.windowId;
        break;
      }
    }
    pointedId = hit;
    showTarget(hit);
  };

  // Runs once: a blur after the release finds nothing left to finish.
  const finish = (commit: boolean): void => {
    if (finished) return;
    finished = true;
    const activeTiles = tiles;
    // The tile under the pointer, even when the release beat the picture and
    // the preview never showed.
    const landedOn = pointedId;
    const previewed = targetId;
    stop();
    tiles = null;
    targetId = null;
    if (!activeTiles) return;
    for (const tile of activeTiles.values()) restore(tile);
    landingMark?.remove();
    landingMark = null;
    // The live terminals are already where the preview put them, so the picture just goes.
    float?.element.remove();
    float = null;
    const dragged = activeTiles.get(options.windowId);
    if (commit && landedOn) {
      // The commit puts each frame where the preview had it, so a previewed
      // swap needs no refit: its terminals are already at their new sizes. A
      // release that beat the preview (the picture still on its way) is resized
      // by the commit itself, which runs as a layout change for that case.
      const swap = (): void => options.swap(options.windowId, landedOn);
      if (dragged) runTerminalLayoutChange(terminalLayoutScopeOf(dragged.frame), swap);
      else swap();
      return;
    }
    // Put back, so a previewed pair refits to its own tiles again.
    const target = previewed ? activeTiles.get(previewed) : undefined;
    if (dragged && target) refitTerminals([dragged.frame, target.frame]);
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
