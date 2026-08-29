import type { ReactNode } from 'react';

interface IconSlotProps {
  /** Box width and height in px. Pass what the glyph inside already draws at, so
   *  adopting a slot changes no layout: the slot is a hit target, not a resize. */
  size: number;
  /** Appended after the base classes (e.g. `shrink-0` in a flex row). */
  className?: string;
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
 *  1. The contents are `pointer-events: none`, so hits land on this `<span>` rather than
 *     on whatever glyph currently occupies it.
 *  2. Every branch of a swapping icon returns THIS component at the same position, so
 *     React reconciles one `<span>` in place across the swap - the DOM node survives even
 *     when the icon inside changes element type entirely (a lucide glyph to an
 *     `ActivityMark`, say). Only its attributes update.
 *
 * That is why the fix belongs HERE and not on the button: scoping the neutralization to
 * the glyph works inside a clickable that has other interactive children, where
 * neutralizing the whole clickable's children is not available. `MonitorCard`'s state
 * glyph is exactly that case.
 *
 * `size` is per-branch on purpose. The branches of a real icon rarely draw at one size
 * (the Stop control is a 20px mark but an 18px lucide glyph at rest), and forcing them to
 * agree would resize the control in some states. Passing each branch's existing size keeps
 * the rendering identical to before while still handing every branch the same stable node.
 */
export function IconSlot({ size, className, children }: IconSlotProps) {
  return (
    <span
      className={`grid place-items-center [&>*]:pointer-events-none ${className ?? ''}`}
      style={{ width: size, height: size }}
      data-icon-slot=""
    >
      {children}
    </span>
  );
}
