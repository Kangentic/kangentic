import React, { useEffect, useRef } from 'react';
import { Trans } from '@lingui/react/macro';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { OverlayPopover } from '../OverlayPopover';
import type { Swimlane } from '../../../shared/types';

interface PromotePopoverProps {
  triggerRef: React.RefObject<HTMLElement | null>;
  swimlanes: Swimlane[];
  onSelect: (swimlaneId: string) => void;
  onClose: () => void;
}

export function PromotePopover({ triggerRef, swimlanes, onSelect, onClose }: PromotePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Portal + fixed: the selection toolbar mounts this inside the backlog content
  // well, which clips. It once mounted in a DataTable `<td>` too, which is
  // `overflow-hidden` and clipped an in-flow popover to one ~40px row.
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, {
    mode: 'dropdown',
    strategy: 'fixed',
  });

  // Close on click outside
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

  // Close on Escape
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

  const targets = swimlanes.filter(
    (lane) => lane.role !== 'done' && !lane.is_archived && !lane.is_ghost
  );

  return (
    <OverlayPopover
      open
      popoverRef={popoverRef}
      style={popoverStyle}
      portal
      transformOrigin="top center"
      className="fixed z-[2147483646] bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[160px]"
      data-testid="promote-popover"
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
        <Trans>Move to</Trans>
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
