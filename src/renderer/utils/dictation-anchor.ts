/**
 * Where the dictation chip sits: under the thing the words are actually landing
 * in.
 *
 * It used to anchor to the focused WINDOW and centre horizontally, which put it
 * in the worst possible spot for a split task-detail window. Measured on a real
 * one: frame 538..2022, terminal pane 539..1280, Browser pane 1281..2021 - so
 * the window's centre, 1280, IS the split seam. The chip straddled the divider
 * whichever side the user was dictating into, and its bottom edge landed on the
 * Browser pane's own Clear / Inspect controls.
 *
 * THE TWO ANCHORS.
 *
 * A text input is exact: it is a DOM node and its rect is the field.
 *
 * A terminal anchors to the bottom band of its PANE - the agent's input box -
 * and not to its caret. The caret was tried first, on the measured finding that
 * xterm keeps `.xterm-helper-textarea` positioned on it for IME composition -
 * which is true, and not dependable: an agent TUI hides the cursor, and with it
 * hidden xterm parks that element away from the caret entirely, then snaps it
 * back the moment input arrives. The chip slid across the pane at the start of
 * every utterance as a result. A stable band beats a precise-but-jumpy point,
 * and a TUI keeps its input box at the bottom regardless, so the band lands
 * where the caret would have been anyway - see `TERMINAL_INPUT_RESERVE_PX`.
 *
 * NOTHING MOVES DURING AN UTTERANCE except the pane itself. The anchor is
 * re-measured every frame so a window drag or resize still carries the chip
 * along; what it no longer does is chase a caret.
 */

import { resolveTerminalAnchorElement } from './terminal-anchor-registry';

/** The `<webview>` a guest field lives in, structurally typed so this module
 *  does not pull in the Browser pane's graph.
 *
 *  TWINNED with the identical declaration in `stores/dictation-store.ts`. Kept
 *  separate rather than shared because the store is HMR-PINNED and self-accepts
 *  into `invalidate()`, so giving it an import edge to this module would turn
 *  every edit here into a full dev reload. Change one, change the other. */
interface GuestAnchorHost extends HTMLElement {
  getZoomFactor(): number;
}

/**
 * What the chip anchors TO. Deliberately not `DictationTarget`: that type says
 * where text is WRITTEN, and the two differ for a guest field - writing needs
 * only the `<webview>`, while anchoring needs the field's rect inside it, which
 * costs a cross-process probe and is therefore captured once rather than
 * re-resolved.
 */
export type DictationAnchorTarget =
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'input'; element: Element }
  | {
      kind: 'guest';
      webview: GuestAnchorHost;
      /** The field's rect in the GUEST's viewport coordinates. */
      rect: { left: number; top: number; width: number; height: number };
    };

/**
 * Marks the box a text target's floating chrome must stay inside - the Browser
 * pane, for the note input.
 *
 * Declared rather than derived: there is no generic "which ancestor is this
 * field's pane" question a DOM walk can answer. Clamping to the FIELD instead was tried and is wrong - a field
 * narrower than the chip leaves the chip overhanging it, and a field near a pane
 * edge then spills into the neighbouring pane, which is the bug this whole
 * change exists to remove. Without the marker the chip falls back to the
 * viewport, which keeps it on screen but not off its neighbours.
 */
export const ANCHOR_BOUNDS_ATTRIBUTE = 'data-anchor-bounds';

/**
 * How much of a terminal pane's bottom the chip stays clear of: the agent's
 * input box.
 *
 * Measured off a live Claude TUI rather than guessed. In a 15-row grid the
 * bottom FIVE rows are the input region - a rule, the prompt line, a rule, a
 * blank, and the status line ("auto mode on . 1 shell") - so the chip has to
 * clear five rows, where it used to cover under three. At the default ~17px
 * cell that is 85px.
 *
 * A PIXEL constant rather than rows times a measured cell height, on purpose:
 * the only element that reports the cell size is `.xterm-helper-textarea`, and
 * not depending on anything inside xterm is the entire point of this anchor. It
 * is an approximation either way - the box GROWS with a multi-line draft, so no
 * fixed number clears every state - and being a row out is a cosmetic miss
 * rather than a broken anchor.
 */
const TERMINAL_INPUT_RESERVE_PX = 85;

/** A rect in viewport (CSS pixel) coordinates. */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DictationAnchor {
  /** What the chip attaches to: the field, or a terminal's bottom input band. */
  rect: AnchorRect;
  /** The x the chip centres on: the field's centre, or the pane's. */
  centerX: number;
  /** The box the chip must stay inside, so it never escapes its own pane. */
  bounds: AnchorRect;
}

function toAnchorRect(rect: DOMRect): AnchorRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/** True for a rect that is actually drawn somewhere. */
function isMeasurable(rect: AnchorRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/** The whole viewport, as the bounds of last resort. */
function viewportRect(): AnchorRect {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * Resolve the live anchor for a dictation target, or null when there is nothing
 * on screen to attach to (the target's pane closed mid-utterance, a terminal
 * whose xterm has not mounted). Null is the caller's cue to fall back to a fixed
 * corner rather than guess.
 */
export function resolveDictationAnchor(target: DictationAnchorTarget | null): DictationAnchor | null {
  if (!target) return null;

  if (target.kind === 'guest') {
    // The field lives in another process, so its rect was captured once at press
    // time in the guest's OWN viewport coordinates. Convert to host space here,
    // every frame: the guest-relative offset is stable for the length of an
    // utterance (the user is speaking, not scrolling the page), while the
    // `<webview>`'s own position is not - a window drag moves it, and re-probing
    // the guest 60 times a second to learn that would be absurd.
    if (!target.webview.isConnected) return null;
    const host = toAnchorRect(target.webview.getBoundingClientRect());
    if (!isMeasurable(host)) return null;
    // Guest CSS pixels are scaled by the pane's zoom before they land on screen.
    let zoom = 1;
    try { zoom = target.webview.getZoomFactor() || 1; } catch { zoom = 1; }
    const left = host.left + target.rect.left * zoom;
    const top = host.top + target.rect.top * zoom;
    const rect: AnchorRect = {
      left,
      top,
      right: left + target.rect.width * zoom,
      bottom: top + target.rect.height * zoom,
      width: target.rect.width * zoom,
      height: target.rect.height * zoom,
    };
    // Bounded by the `<webview>` itself, so the chip can never escape the pane
    // the field is inside.
    return { rect, centerX: (rect.left + rect.right) / 2, bounds: host };
  }

  if (target.kind === 'input') {
    if (!target.element.isConnected) return null;
    const rect = toAnchorRect(target.element.getBoundingClientRect());
    if (!isMeasurable(rect)) return null;
    const declared = target.element.closest(`[${ANCHOR_BOUNDS_ATTRIBUTE}]`);
    const declaredRect = declared ? toAnchorRect(declared.getBoundingClientRect()) : null;
    const bounds = declaredRect && isMeasurable(declaredRect) ? declaredRect : viewportRect();
    return { rect, centerX: (rect.left + rect.right) / 2, bounds };
  }

  const container = resolveTerminalAnchorElement(target.sessionId);
  if (!container) return null;
  const bounds = toAnchorRect(container.getBoundingClientRect());
  if (!isMeasurable(bounds)) return null;

  // The bottom band of the PANE, not the cursor.
  //
  // An earlier version anchored to the cursor via `.xterm-helper-textarea`,
  // on the measured finding that xterm keeps that element on the cursor for IME
  // composition. That finding is real but only sometimes true, which makes it a
  // bad anchor: an agent TUI hides the cursor (`\x1b[?25l`), and with it hidden
  // xterm PARKS the textarea away from the caret - measured at `left: 721px;
  // top: 799px` in a 741x829 pane while the caret was on line 2. It then snaps
  // to the real caret the instant input arrives, so the chip visibly slid across
  // the pane at the start of every utterance.
  //
  // The pane edge is stable, always inside the right pane, and depends on
  // nothing internal to xterm.
  //
  // The band it reserves is the agent's INPUT BOX, so the chip sits just above
  // the words being dictated rather than on top of them. Its bottom stays the
  // pane's bottom edge deliberately: that is what makes `placeDictationChip`
  // always flip above. A zero-height line partway up the pane would leave room
  // below it and put the chip back inside the input box.
  const reserved = Math.min(TERMINAL_INPUT_RESERVE_PX, bounds.height);
  const rect: AnchorRect = { ...bounds, top: bounds.bottom - reserved, height: reserved };

  return { rect, centerX: (bounds.left + bounds.right) / 2, bounds };
}

export interface ChipPlacementInput {
  anchor: DictationAnchor;
  chipWidth: number;
  chipHeight: number;
  viewport: { width: number; height: number };
  /** Space between the anchor and the chip. */
  gap: number;
}

export interface ChipPlacement {
  left: number;
  top: number;
  placement: 'below' | 'above';
}

/**
 * Place the chip against its anchor. PURE, so every edge is testable without a
 * DOM.
 *
 * Prefers BELOW, which is what the user reads as "attached to this". Flips above
 * when below would overflow either the anchor's own pane or the viewport - and
 * that flip is the common case, not the exception: a terminal anchors to its
 * pane's bottom edge outright, and the Browser pane's note field sits at the
 * bottom of its own pane, so below rarely has room.
 *
 * Horizontal clamping is to the PANE, so a chip anchored to the terminal can
 * never drift over the Browser pane and cover its controls. Vertical clamping is
 * to the viewport only: a flipped chip is allowed to overhang its pane's top
 * edge, because the alternative is refusing to show it at all in a short pane.
 */
export function placeDictationChip(input: ChipPlacementInput): ChipPlacement {
  const { anchor, chipWidth, chipHeight, viewport, gap } = input;

  const belowTop = anchor.rect.bottom + gap;
  const roomBelow = Math.min(anchor.bounds.bottom, viewport.height);
  const fitsBelow = belowTop + chipHeight <= roomBelow;
  const placement: 'below' | 'above' = fitsBelow ? 'below' : 'above';
  const rawTop = fitsBelow ? belowTop : anchor.rect.top - gap - chipHeight;

  // Clamp low-then-high so a chip taller than the viewport pins to the top edge
  // rather than being pushed off it.
  const top = Math.max(0, Math.min(rawTop, viewport.height - chipHeight));

  const minLeft = Math.max(0, anchor.bounds.left);
  const maxLeft = Math.min(viewport.width, anchor.bounds.right) - chipWidth;
  const rawLeft = anchor.centerX - chipWidth / 2;
  // `maxLeft < minLeft` when the pane is narrower than the chip; the max() then
  // wins and the chip starts at the pane's left edge, overhanging its right.
  const left = Math.max(minLeft, Math.min(rawLeft, maxLeft));

  return { left, top, placement };
}
