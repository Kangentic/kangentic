import React, { useEffect, useRef } from 'react';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
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
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, { mode: 'dropdown' });

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
    <div
      ref={popoverRef}
      style={popoverStyle}
      className="absolute z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[160px]"
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
    </div>
  );
}
