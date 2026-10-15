/**
 * The pure half of `Tooltip` (components/Tooltip.tsx): its timing, where it sits, what a
 * screen reader hears, and the one-tip-at-a-time state every instance shares.
 *
 * No DOM imports, so the unit tier and the UI spec read the same numbers the component runs on.
 */

/** Hover dwell before a cold tip opens. Long enough that sweeping across a row of icons shows nothing. */
export const TOOLTIP_DWELL_MS = 400;
/** After a tip closes by pointer leave or blur, the next trigger's tip opens at once for this long. */
export const TOOLTIP_WARM_MS = 300;
/** Gap between the trigger and the tip. */
export const TIP_OFFSET = 8;
/** Minimum distance the tip keeps from the window edge. */
export const VIEWPORT_PADDING = 8;

export interface TipAnchor {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface TipSize {
  width: number;
  height: number;
}

export interface TipPlacement {
  left: number;
  top: number;
  side: 'above' | 'below';
}

function clamp(value: number, low: number, high: number): number {
  // `high` falls below `low` for a tip wider than the window; the low edge wins, since a tip
  // that starts off-screen is unreadable from its first character rather than its last.
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

/**
 * Centred over the trigger, then clamped inside the window. Above unless there is no room, so
 * the tip does not cover the next control down in a stack; below as the fallback, pulled up
 * only if even that would leave the window.
 *
 * Centred-then-clamped rather than edge-aligned the way `usePopoverPosition` places menus: a
 * menu anchored to a trigger's edge reads as belonging to it, while a tip reads as belonging to
 * whatever it points at, so it stays centred until the window forces it sideways.
 */
export function placeTip(anchor: TipAnchor, size: TipSize, viewport: TipSize): TipPlacement {
  const left = clamp(
    anchor.left + anchor.width / 2 - size.width / 2,
    VIEWPORT_PADDING,
    viewport.width - size.width - VIEWPORT_PADDING,
  );
  const above = anchor.top - TIP_OFFSET - size.height;
  if (above >= VIEWPORT_PADDING) return { left, top: above, side: 'above' };
  const below = anchor.bottom + TIP_OFFSET;
  const lowest = viewport.height - VIEWPORT_PADDING - size.height;
  return { left, top: Math.max(VIEWPORT_PADDING, Math.min(below, lowest)), side: 'below' };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the tip's label only repeats the name the trigger already announces. */
export function repeatsTriggerName(label: string, triggerName: string | undefined): boolean {
  return triggerName !== undefined && normalize(label) === normalize(triggerName);
}

/**
 * What a screen reader hears beyond the trigger's own name: the label (unless it only repeats
 * that name), the live shortcut, and the detail line. Empty when the tip adds nothing, as on an
 * icon button whose name is its tip and which has no shortcut.
 */
export function tipDescription(parts: { label: string; readLabel: boolean; combo: string; detail?: string }): string {
  const first = parts.readLabel
    ? (parts.combo === '' ? parts.label : `${parts.label} (${parts.combo})`)
    : parts.combo;
  return [first, parts.detail ?? ''].filter((part) => part !== '').join('\n');
}

/** Whether a control shows why it is off: it is disabled and has a reason. An empty reason is none. */
export function showsDisabledReason(disabled: boolean | undefined, disabledReason: string | null | undefined): boolean {
  return disabled === true && disabledReason !== undefined && disabledReason !== null && disabledReason !== '';
}

/**
 * The text a control's tip shows: the reason it is off while that applies, otherwise its own tip.
 * '' when there is neither, which holds the tip shut.
 */
export function tipLabel(parts: { disabled?: boolean; disabledReason?: string | null; tip?: string }): string {
  if (showsDisabledReason(parts.disabled, parts.disabledReason)) return parts.disabledReason ?? '';
  return parts.tip ?? '';
}

// hmr-safe: the close function of the tip on screen, so the next one can replace it (one tip at
// a time). A Fast Refresh forgets it, so a tip still showing is not replaced by the next one: a
// hover tip closes at pointer leave, and a keyboard-focus tip stays beside the next until blur.
// Dev-only and cosmetic.
let shownTipClose: (() => void) | null = null;
// hmr-safe: a 300ms warm window; a Fast Refresh at worst makes the next tip wait out its dwell once.
let lastWarmCloseAt = Number.NEGATIVE_INFINITY;

/** Whether the next tip opens at once: one is showing, or one closed by leave or blur just now. */
export function isTipWarm(now: number): boolean {
  return shownTipClose !== null || now - lastWarmCloseAt < TOOLTIP_WARM_MS;
}

/** Record `close` as the tip on screen, closing whichever tip held that place. */
export function claimTip(close: () => void): void {
  const previous = shownTipClose;
  if (previous !== null && previous !== close) previous();
  shownTipClose = close;
}

/**
 * Forget `close` as the tip on screen. `warm` starts the warm window: true for a close by
 * pointer leave, blur or replacement, false for Escape, a press, a scroll or a resize, after
 * which the next tip waits its full dwell again.
 */
export function releaseTip(close: () => void, warm: boolean, now: number): void {
  if (shownTipClose !== close) return;
  shownTipClose = null;
  if (warm) lastWarmCloseAt = now;
}

/** Test seam: forget every tip and every close. */
export function resetTipStateForTests(): void {
  shownTipClose = null;
  lastWarmCloseAt = Number.NEGATIVE_INFINITY;
}
