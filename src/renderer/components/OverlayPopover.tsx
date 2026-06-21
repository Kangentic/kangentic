import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayPhase } from '../hooks/useOverlayPhase';

/**
 * Shared presence + motion wrapper for in-app popovers, dropdowns, and context
 * menus. Gives every small overlay the same origin-aware grow/fade (the
 * `overlay-popover-in` / `overlay-popover-out` tokens) and, crucially, keeps the
 * element mounted through its exit animation - the `{open && <div>}` popovers it
 * replaces unmount instantly with no exit motion.
 *
 * It does NOT own positioning: callers pass `style` / `className` (e.g. from
 * `usePopoverPosition`) and an optional `popoverRef` used for outside-click
 * detection and measurement. The element mounts synchronously while `open` so
 * those measurements see it on the same commit.
 */

interface OverlayPopoverProps {
  /** Whether the popover should be shown. Toggling false plays the exit animation. */
  open: boolean;
  /** Forwarded to the popover element (outside-click detection / positioning). */
  popoverRef?: React.RefObject<HTMLDivElement | null>;
  /** Positioning / layout classes for the popover element. */
  className?: string;
  /** Inline positioning style (e.g. from usePopoverPosition). */
  style?: React.CSSProperties;
  /**
   * transform-origin for the grow-from-trigger scale. Default 'top center' so a
   * downward dropdown unfolds from its trigger. Use 'top left' for left-anchored
   * menus, or a coordinate for a context menu at the cursor.
   */
  transformOrigin?: string;
  /**
   * Render into a `document.body` portal so the popover escapes a clipping
   * ancestor (a window frame's `overflow-hidden`). Use with a fixed positioning
   * strategy (`usePopoverPosition({ strategy: 'fixed' })`), since the default
   * trigger-relative offsets are meaningless once detached from the trigger.
   */
  portal?: boolean;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  onMouseUp?: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  role?: string;
  'data-testid'?: string;
  children: React.ReactNode;
}

export function OverlayPopover({ open, ...rest }: OverlayPopoverProps) {
  const [closing, setClosing] = useState(false);
  // A key that changes on every open so the content remounts and replays its
  // enter animation, rather than reusing a stale phase from a prior open.
  const [openCount, setOpenCount] = useState(0);
  const [previousOpen, setPreviousOpen] = useState(open);

  // Adjust derived state synchronously during render (React restarts the render
  // before committing), so the element mounts on the same commit `open` flips
  // true and positioning hooks measure it immediately.
  if (open !== previousOpen) {
    setPreviousOpen(open);
    setClosing(!open);
    if (open) setOpenCount((previousOpenCount) => previousOpenCount + 1);
  }

  if (!open && !closing) return null;

  return (
    <OverlayPopoverContent
      key={openCount}
      closing={!open}
      onExited={() => setClosing(false)}
      {...rest}
    />
  );
}

type OverlayPopoverContentProps = Omit<OverlayPopoverProps, 'open'> & {
  closing: boolean;
  onExited: () => void;
};

function OverlayPopoverContent({
  closing,
  onExited,
  popoverRef,
  className = '',
  style,
  transformOrigin = 'top center',
  portal = false,
  children,
  ...domProps
}: OverlayPopoverContentProps) {
  const { contentClassName, onAnimationEnd, requestClose } = useOverlayPhase(onExited, {
    variant: 'popover',
  });

  useEffect(() => {
    if (closing) requestClose();
  }, [closing, requestClose]);

  // The popover only renders while it should be seen (entering / visible /
  // exiting). Drop any `visibility: hidden` a positioning hook returns for its
  // closed state, or the exit animation would play invisibly. The hook's
  // imperative top/left/right (set on the last open measure) persist on the
  // element, so the exit animates from the correct spot.
  const positionStyle: React.CSSProperties = { ...style };
  delete positionStyle.visibility;

  const element = (
    <div
      ref={popoverRef}
      style={{ transformOrigin, ...positionStyle }}
      className={`${className} ${contentClassName}`}
      onAnimationEnd={onAnimationEnd}
      {...domProps}
    >
      {children}
    </div>
  );

  // Portaled popovers escape any ancestor `overflow: hidden` (e.g. a window
  // frame); they must be positioned with `position: fixed` (the caller's hook).
  return portal ? createPortal(element, document.body) : element;
}
