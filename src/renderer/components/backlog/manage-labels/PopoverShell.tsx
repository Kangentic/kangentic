import React from 'react';
import { OverlayPopover } from '../../OverlayPopover';

/**
 * Shared absolute-positioned popover wrapper for LabelsPopover and
 * PrioritiesPopover. Positions itself below the trigger button and
 * constrains its height with internal scrolling.
 *
 * Doesn't handle outside-click / Escape - each caller owns those
 * listeners because they also bind the open state itself.
 */
export function PopoverShell({
  open,
  popoverRef,
  children,
}: {
  open: boolean;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <OverlayPopover
      open={open}
      popoverRef={popoverRef}
      transformOrigin="top left"
      // popover-inflow-ok: LabelsPopover and PrioritiesPopover mount only in the
      // ViewToggle toolbar row, which sits ABOVE the board/backlog content wells
      // (AppLayout's `flex-1 min-h-0 overflow-hidden`), so there is no clipping
      // ancestor. Portal + fixed if this ever moves inside a scroller.
      className="absolute left-0 top-full mt-1 z-50 bg-surface-raised border border-edge rounded-lg shadow-xl w-[320px] max-h-[420px] overflow-y-auto"
    >
      {children}
    </OverlayPopover>
  );
}
