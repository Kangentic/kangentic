import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { CountBadge } from '../CountBadge';
import { LabelsPopover } from '../backlog/manage-labels/LabelsPopover';
import { PrioritiesPopover } from '../backlog/manage-labels/PrioritiesPopover';
import { EditColumnDialog } from '../dialogs/EditColumnDialog';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';

export const ViewToggle = React.memo(function ViewToggle() {
  const activeView = useBoardStore((state) => state.activeView);
  const setActiveView = useBoardStore((state) => state.setActiveView);
  const backlogCount = useBacklogStore((state) => state.items.length);

  const [showCreateDialog, setShowCreateDialog] = useState(false);

  return (
    <div className="flex items-center px-4 pt-2 pb-2 border-b border-edge" data-testid="view-toggle">
      <div className="flex items-center gap-0.5 bg-surface/50 rounded-lg p-0.5 border border-edge/30">
        <button
          type="button"
          onClick={() => setActiveView('board')}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
            activeView === 'board'
              ? 'bg-surface-raised text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
          }`}
          data-testid="view-toggle-board"
        >
          Board
        </button>
        <button
          type="button"
          onClick={() => setActiveView('backlog')}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5 ${
            activeView === 'backlog'
              ? 'bg-surface-raised text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
          }`}
          data-testid="view-toggle-backlog"
        >
          Backlog
          {backlogCount > 0 && (
            <CountBadge count={backlogCount} variant={activeView === 'backlog' ? 'accent' : 'muted'} />
          )}
        </button>
      </div>

      <div className="w-px h-5 bg-edge/50 mx-2.5" />

      <div className="flex items-center gap-1.5">
        <LabelsPopover />
        <PrioritiesPopover />
      </div>

      {activeView === 'board' && (
        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
          data-testid="add-column-button"
        >
          <Plus size={16} />
          <span>Add column</span>
        </button>
      )}

      {showCreateDialog && (
        <EditColumnDialog
          mode="create"
          onClose={() => setShowCreateDialog(false)}
        />
      )}
    </div>
  );
});
