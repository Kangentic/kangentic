import { useRef } from 'react';
import { Eye, RotateCcw, Trash2 } from 'lucide-react';
import type { Swimlane } from '../../../../shared/types';
import { Tooltip } from '../../Tooltip';
import { RestorePopover } from './RestorePopover';

/**
 * Per-row action group in the CompletedTasksDialog: view detail,
 * restore (via popover anchored to the row's button), delete.
 *
 * Owns its own button ref so the RestorePopover can position itself
 * relative to this row rather than the whole toolbar.
 */
export function RowActions({
  taskId,
  swimlanes,
  restorePopoverId,
  onToggleRestore,
  onCloseRestore,
  onRestore,
  onDelete,
  onViewDetail,
}: {
  taskId: string;
  swimlanes: Swimlane[];
  restorePopoverId: string | null;
  onToggleRestore: (taskId: string) => void;
  onCloseRestore: () => void;
  onRestore: (taskId: string, swimlaneId: string) => void;
  onDelete: (taskId: string) => void;
  onViewDetail: (taskId: string) => void;
}) {
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const isOpen = restorePopoverId === taskId;

  return (
    <div className="flex items-center justify-end gap-1.5 relative" onClick={(event) => event.stopPropagation()}>
      <Tooltip label="View details">
        <button
          type="button"
          onClick={() => onViewDetail(taskId)}
          className="p-2 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
          aria-label="View details"
          data-testid="view-task-btn"
        >
          <Eye size={16} />
        </button>
      </Tooltip>
      <div className="relative">
        {/* Shut while its own column menu is open. */}
        <Tooltip label="Restore to board" enabled={!isOpen}>
          <button
            ref={restoreButtonRef}
            type="button"
            onClick={() => onToggleRestore(taskId)}
            className="p-2 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/40 rounded transition-colors"
            aria-label="Restore to board"
            data-testid="restore-task-btn"
          >
            <RotateCcw size={16} />
          </button>
        </Tooltip>
        {isOpen && (
          <RestorePopover
            triggerRef={restoreButtonRef}
            swimlanes={swimlanes}
            onSelect={(swimlaneId) => onRestore(taskId, swimlaneId)}
            onClose={onCloseRestore}
          />
        )}
      </div>
      <Tooltip label="Delete task">
        <button
          type="button"
          onClick={() => onDelete(taskId)}
          className="p-2 text-fg-disabled hover:text-red-400 hover:bg-surface-hover/40 rounded transition-colors"
          aria-label="Delete task"
          data-testid="delete-task-btn"
        >
          <Trash2 size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
