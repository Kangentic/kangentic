import { useRef, useState } from 'react';
import { SquareArrowRight, Trash2, Pencil } from 'lucide-react';
import { PromotePopover } from '../PromotePopover';
import { Tooltip } from '../../Tooltip';
import type { useBoardStore } from '../../../stores/board-store';

/**
 * Per-row action group in the BacklogView table: move to board (via
 * PromotePopover anchored to the button), edit, delete. Owns its own
 * popover open state.
 */
export function BacklogRowActions({
  itemId,
  swimlanes,
  onMoveToBoard,
  onEdit,
  onDelete,
}: {
  itemId: string;
  swimlanes: ReturnType<typeof useBoardStore.getState>['swimlanes'];
  onMoveToBoard: (itemId: string, swimlaneId: string) => void;
  onEdit: (itemId: string) => void;
  onDelete: (itemId: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const moveButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex items-center justify-end gap-1 relative" onClick={(event) => event.stopPropagation()}>
      <div className="relative">
        <Tooltip label="Move to board" enabled={!showPicker}>
          <button
            ref={moveButtonRef}
            type="button"
            onClick={() => setShowPicker(!showPicker)}
            className="p-1.5 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
            aria-label="Move to board"
            data-testid="move-to-board-btn"
          >
            <SquareArrowRight size={15} />
          </button>
        </Tooltip>
        {showPicker && (
          <PromotePopover
            triggerRef={moveButtonRef}
            swimlanes={swimlanes}
            onSelect={(swimlaneId) => {
              setShowPicker(false);
              onMoveToBoard(itemId, swimlaneId);
            }}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
      <Tooltip label="Edit item">
        <button
          type="button"
          onClick={() => onEdit(itemId)}
          className="p-1.5 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
          aria-label="Edit item"
          data-testid="edit-item-btn"
        >
          <Pencil size={14} />
        </button>
      </Tooltip>
      <Tooltip label="Delete item">
        <button
          type="button"
          onClick={() => onDelete(itemId)}
          className="p-1.5 text-fg-disabled hover:text-red-400 hover:bg-surface-hover/40 rounded transition-colors"
          aria-label="Delete item"
          data-testid="delete-item-btn"
        >
          <Trash2 size={15} />
        </button>
      </Tooltip>
    </div>
  );
}
