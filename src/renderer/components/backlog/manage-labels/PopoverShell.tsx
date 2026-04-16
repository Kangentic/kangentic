import React from 'react';

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
  if (!open) return null;
  return (
    <div
      ref={popoverRef}
      className="absolute left-0 top-full mt-1 z-50 bg-surface-raised border border-edge rounded-lg shadow-xl w-[320px] max-h-[420px] overflow-y-auto"
    >
      {children}
    </div>
  );
}
