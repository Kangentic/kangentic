import type { HTMLAttributes, ReactNode } from 'react';

interface IconSlotProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'style' | 'children' | 'title'> {
  /** Box width and height in px. ONE value for the whole icon, not one per branch:
   *  see the `size` note below for why a constant box is the point. */
  size: number;
  /** Appended after the base classes (e.g. `shrink-0` in a flex row). */
  className?: string;
  /**
   * Treat `size` as a minimum width rather than a fixed one, for a branch that can
   * outgrow it: the Workflows tab swaps its count pill for the running mark, and a
   * 2-digit pill is wider than the 18px both share below 10. Height stays fixed.
   */
  grow?: boolean;
  children: ReactNode;
}

/**
 * A fixed-size box that keeps the POINTER TARGET stable while the icon inside it swaps.
 *
 * Chromium drops a click outright when the node that received `mousedown` is destroyed
 * before `mouseup`. An icon driven by session activity can be replaced at any instant by
 * a push from the main process, so a press landing on the glyph races a state change it
 * has no relationship to: the handler never runs, and the user sees nothing happen until
 * they click a second time. It shipped twice - as "a button on a background window needs
 * two clicks" and again as "the first Stop click never registers" - and both times it
 * read as a focus bug, because the click event simply never exists to trace.
 *
 * Two properties do the work, and both are load-bearing:
 *
 *  1. `[&>*]:pointer-events-none` sets the property on the slot's DIRECT children. Since
 *     `pointer-events` inherits, the whole subtree below them is non-hit-testable too -
 *     unless some descendant sets its own explicit value, which would silently punch a
 *     hole in the guarantee. Hits therefore land on this `<span>` rather than on whatever
 *     glyph currently occupies it.
 *  2. Wrap ONCE, around the icon the branching produced - never separately inside each
 *     branch. One `<span>` at one JSX position is what lets React reconcile the same DOM
 *     node across the swap, even when the icon inside changes element type entirely (a
 *     lucide glyph to an `ActivityMark`, say). Only its attributes update. Wrapping per
 *     branch happens to work, but it puts the invariant back in every future branch's
 *     hands, and a single branch that forgets the wrapper silently restores the bug.
 *
 * That is why the fix belongs HERE and not on the button: scoping the neutralization to
 * the glyph works inside a clickable that has other interactive children, where
 * neutralizing the whole clickable's children is not available. `MonitorCard`'s state
 * glyph is exactly that case.
 *
 * `size` is per ICON, not per branch. The branches of a real icon rarely draw at one size
 * (the Stop control is a 20px mark but an 18px lucide glyph at rest), and letting the box
 * follow each branch would resize the control every time the state flipped - the jitter
 * this component exists to remove, since a box that changes size is also a box the
 * pointer can fall out of. So the slot takes the largest size the icon draws at and holds
 * it across every state: the glyph inside keeps its own size, and a smaller branch simply
 * sits centred in a slightly larger box. Adopting a slot therefore CAN grow a given
 * branch's footprint by a pixel or two versus an unwrapped glyph. That is deliberate.
 * `grow` relaxes this for width only. It makes `size` a minimum, for a branch such as a
 * 2-digit count pill that outgrows the rest, so the box widens for that branch while its
 * height holds.
 *
 * One trap. The slot neutralizes the element it wraps, which for an `<ActivityMark>` is
 * that component's `<svg>` root - the very node `ActivityMark` documents as having to
 * stay hit-testable, because a `Tooltip` around it opens only while the element itself
 * can receive the pointer (see `TaskCard`, which relies on exactly that). A mark inside a
 * slot must therefore label itself with `aria-label`, and its tip goes on the SLOT, not
 * the mark: the slot forwards the pointer, focus and `aria-description` props a
 * `Tooltip` clones onto its child, so `<Tooltip><IconSlot>...</IconSlot></Tooltip>` opens
 * on the span that does take the pointer (the Agent Monitor's card does this). A Tooltip
 * around the mark itself would be silently inert, with no test to catch it.
 */
export function IconSlot({ size, className, grow = false, children, ...rest }: IconSlotProps) {
  return (
    <span
      {...rest}
      className={`grid place-items-center [&>*]:pointer-events-none ${className ?? ''}`}
      style={grow ? { minWidth: size, height: size } : { width: size, height: size }}
    >
      {children}
    </span>
  );
}
