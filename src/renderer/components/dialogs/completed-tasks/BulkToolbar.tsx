import { useRef, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { Swimlane } from '../../../../shared/types';
import { RestorePopover } from './RestorePopover';

/**
 * Floating toolbar shown at the bottom of the CompletedTasksDialog
 * when one or more rows are selected. Offers bulk Restore (via a
 * RestorePopover) and bulk Delete.
 */
export function BulkToolbar({
  selectedCount,
  swimlanes,
  onRestore,
  onDelete,
}: {
  selectedCount: number;
  swimlanes: Swimlane[];
  onRestore: (swimlaneId: string) => void;
  onDelete: () => void;
}) {
  const [showRestorePicker, setShowRestorePicker] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={toolbarRef} className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 bg-surface-raised border border-edge rounded-lg shadow-xl px-4 py-2.5 flex items-center gap-4">
      <span className="text-sm text-fg-muted font-medium tabular-nums">
        {selectedCount} selected
      </span>
      <div className="w-px h-5 bg-edge" />
      <button
        type="button"
        onClick={() => setShowRestorePicker(!showRestorePicker)}
        className="flex items-center gap-1.5 text-sm text-fg-secondary hover:text-fg px-2 py-1 rounded hover:bg-surface-hover/40 transition-colors"
        data-testid="bulk-restore-btn"
      >
        <RotateCcw size={14} />
        Restore
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-surface-hover/40 transition-colors"
        data-testid="bulk-delete-btn"
      >
        <Trash2 size={14} />
        Delete
      </button>
      {showRestorePicker && (
        <RestorePopover
          triggerRef={toolbarRef}
          swimlanes={swimlanes}
          onSelect={(swimlaneId) => {
            setShowRestorePicker(false);
            onRestore(swimlaneId);
          }}
          onClose={() => setShowRestorePicker(false)}
        />
      )}
    </div>
  );
}
