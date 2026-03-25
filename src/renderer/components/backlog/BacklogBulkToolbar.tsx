import React, { useState, useRef } from 'react';
import { SquareArrowRight, Trash2 } from 'lucide-react';
import { PromotePopover } from './PromotePopover';
import type { Swimlane } from '../../../shared/types';

interface BacklogBulkToolbarProps {
  selectedCount: number;
  swimlanes: Swimlane[];
  onMoveToBoard: (swimlaneId: string) => void;
  onDelete: () => void;
}

export function BacklogBulkToolbar({
  selectedCount,
  swimlanes,
  onMoveToBoard,
  onDelete,
}: BacklogBulkToolbarProps) {
  const [showColumnPicker, setShowColumnPicker] = useState(false);
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
        onClick={() => setShowColumnPicker(!showColumnPicker)}
        className="flex items-center gap-1.5 text-sm text-fg-secondary hover:text-fg px-2 py-1 rounded hover:bg-surface-hover/40 transition-colors"
        data-testid="bulk-move-to-board-btn"
      >
        <SquareArrowRight size={14} />
        Move to Board
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-1.5 text-sm text-fg-secondary hover:text-danger px-2 py-1 rounded hover:bg-surface-hover/40 transition-colors"
        data-testid="bulk-delete-btn"
      >
        <Trash2 size={14} />
        Delete
      </button>
      {showColumnPicker && (
        <PromotePopover
          triggerRef={toolbarRef}
          swimlanes={swimlanes}
          onSelect={(swimlaneId) => {
            setShowColumnPicker(false);
            onMoveToBoard(swimlaneId);
          }}
          onClose={() => setShowColumnPicker(false)}
        />
      )}
    </div>
  );
}
