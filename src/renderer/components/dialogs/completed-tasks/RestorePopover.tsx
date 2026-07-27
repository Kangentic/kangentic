import React, { useEffect, useRef } from 'react';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { OverlayPopover } from '../../OverlayPopover';
import type { Swimlane } from '../../../../shared/types';

/**
 * Dropdown popover that lists swimlanes where an archived task can be
 * restored (excludes Done, archived, and ghost lanes).
 *
 * Closes on outside click or Escape. Escape capture stops propagation
 * so the parent CompletedTasksDialog doesn't also close.
 */
export function RestorePopover({
  triggerRef,
  swimlanes,
  onSelect,
  onClose,
}: {
  triggerRef: React.RefObject<HTMLElement | null>;
  swimlanes: Swimlane[];
  onSelect: (swimlaneId: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Portal + fixed: this renders into a DataTable `<td>`, which is
  // `overflow-hidden`, so an in-flow absolute popover was clipped to a single
  // ~40px table row. The bulk-toolbar mount is clipped by the dialog's raw body.
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, {
    mode: 'dropdown',
    strategy: 'fixed',
  });

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [onClose, triggerRef]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [onClose]);

  const targets = swimlanes.filter((lane) => lane.role !== 'done' && !lane.is_archived && !lane.is_ghost);

  return (
    <OverlayPopover
      open
      popoverRef={popoverRef}
      style={popoverStyle}
      portal
      transformOrigin="top center"
      className="fixed z-[2147483646] bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[160px]"
      data-testid="restore-popover"
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
        Restore to
      </div>
      {targets.map((lane) => (
        <button
          key={lane.id}
          type="button"
          onClick={() => onSelect(lane.id)}
          className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        >
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: lane.color }}
          />
          {lane.name}
        </button>
      ))}
    </OverlayPopover>
  );
}
