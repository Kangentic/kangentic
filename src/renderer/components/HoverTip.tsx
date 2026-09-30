/**
 * A hover label that cannot be clipped by whatever it happens to sit inside.
 *
 * The app's hover text has been native `title` almost everywhere, which is
 * unstyled and slow to appear. The one place that needed better - the Knowledge
 * Graph's camera legend - grew its own absolutely-positioned chip and
 * immediately hit both failure modes an in-flow tooltip has:
 *
 *  - **Clipping.** It lived under a `overflow-hidden` canvas wrapper, so a tip
 *    centred over a control near the left edge was cut in half.
 *  - **The containing-block trap.** Switching it to `position: fixed` in place
 *    would NOT have fixed that: its parent card carries `backdrop-blur`, and
 *    `backdrop-filter` establishes a containing block for fixed descendants, so
 *    "fixed" would still have been measured against the card. A body portal is
 *    the only thing that reliably escapes both.
 *
 * Positioning is centred-then-CLAMPED rather than edge-aligned the way
 * `usePopoverPosition` does it for menus. A menu anchored to a trigger's edge
 * reads as belonging to it; a tooltip reads as belonging to whatever it points
 * at, so it stays centred until the viewport forces it sideways, and only then
 * slides the minimum needed to fit.
 *
 * The label is ALSO rendered `sr-only` inside the trigger, always. A mapping
 * that exists only while a pointer is over it does not exist at all to someone
 * not using one, and the portal content is mounted only while open.
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/** Gap between the trigger and the tip. */
const TIP_OFFSET = 8;
/** Minimum distance the tip keeps from the viewport edge. */
const VIEWPORT_PADDING = 8;

function clamp(value: number, low: number, high: number): number {
  // `high` can fall below `low` for a tip wider than the viewport; the low edge
  // wins there, since a tip that starts off-screen is unreadable from the first
  // character rather than the last.
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

export function HoverTip({
  label,
  children,
  className,
  testId,
}: {
  label: string;
  children: ReactNode;
  /** Applied to the trigger wrapper, which is an inline-flex span. */
  className?: string;
  testId?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  // Hidden rather than unpositioned for the first commit: the tip has to be in
  // the DOM to be measured, and painting it at 0,0 first would flash it in the
  // corner of the screen on every hover.
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    // Closing resets the style in the handler that closes, so the next open
    // starts hidden again; this effect only measures an open tip.
    if (!open) return;
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;

    const anchor = trigger.getBoundingClientRect();
    // `offsetWidth`/`offsetHeight`, not the rect: the tip animates in from a
    // scaled transform, and a rect measured mid-animation reads short.
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;

    const centred = anchor.left + anchor.width / 2 - width / 2;
    const above = anchor.top - height - TIP_OFFSET;
    setStyle({
      position: 'fixed',
      left: clamp(centred, VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
      // Below only when there is genuinely no room above, so the tip does not
      // cover the next control down in a stack of them.
      top: above >= VIEWPORT_PADDING ? above : anchor.bottom + TIP_OFFSET,
    });
  }, [open, label]);

  const close = (): void => {
    setOpen(false);
    setStyle({ visibility: 'hidden' });
  };

  return (
    <span
      ref={triggerRef}
      className={className}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={close}
      // Focus too, so a sighted keyboard user tabbing to the wrapped control
      // sees what a pointer user sees. React's focus events bubble from it.
      onFocus={() => setOpen(true)}
      onBlur={close}
    >
      {children}
      <span className="sr-only">{label}</span>
      {open
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              data-testid={testId}
              style={style}
              className="pointer-events-none z-[2147483646] whitespace-nowrap rounded border border-edge bg-surface-raised px-2 py-1 text-[11px] leading-none text-fg shadow-lg"
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
