import React, { useState, useRef } from 'react';
import { SquareArrowOutUpRight } from 'lucide-react';
import { PromotePopover } from './PromotePopover';
import type { Swimlane } from '../../../shared/types';

interface BacklogBulkToolbarProps {
  selectedCount: number;
  swimlanes: Swimlane[];
  onPromote: (swimlaneId: string) => void;
}

export function BacklogBulkToolbar({
  selectedCount,
  swimlanes,
  onPromote,
}: BacklogBulkToolbarProps) {
  const [showPromotePicker, setShowPromotePicker] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={toolbarRef}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 bg-surface-raised border border-edge rounded-lg shadow-xl px-4 py-2.5 flex items-center gap-4"
      data-testid="backlog-bulk-toolbar"
    >
      <span className="text-sm text-fg-muted font-medium tabular-nums">
        {selectedCount} selected
      </span>
      <div className="w-px h-5 bg-edge" />
      <button
        type="button"
        onClick={() => setShowPromotePicker(!showPromotePicker)}
        className="flex items-center gap-1.5 text-sm text-fg-secondary hover:text-fg px-2 py-1 rounded hover:bg-surface-hover/40 transition-colors"
        data-testid="bulk-promote-btn"
      >
        <SquareArrowOutUpRight size={14} />
        Move to Board
      </button>
      {showPromotePicker && (
        <PromotePopover
          triggerRef={toolbarRef}
          swimlanes={swimlanes}
          onSelect={(swimlaneId) => {
            setShowPromotePicker(false);
            onPromote(swimlaneId);
          }}
          onClose={() => setShowPromotePicker(false)}
        />
      )}
    </div>
  );
}
