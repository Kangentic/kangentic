import React from 'react';
import { CountBadge } from '../CountBadge';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';

export const ViewToggle = React.memo(function ViewToggle() {
  const activeView = useBoardStore((state) => state.activeView);
  const setActiveView = useBoardStore((state) => state.setActiveView);
  const backlogCount = useBacklogStore((state) => state.items.length);

  return (
    <div className="flex items-center gap-1 px-4 pt-2" data-testid="view-toggle">
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
  );
});
