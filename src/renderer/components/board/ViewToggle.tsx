import React, { useEffect, useMemo, useRef } from 'react';
import { Plus } from 'lucide-react';
import { CountBadge } from '../CountBadge';
import { SegmentedControl } from '../SegmentedControl';
import { ToolbarSearchFilter } from '../ToolbarSearchFilter';
import { ImportPopover } from '../backlog/ImportPopover';
import { LabelsPopover } from '../backlog/manage-labels/LabelsPopover';
import { PrioritiesPopover } from '../backlog/manage-labels/PrioritiesPopover';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';

export const ViewToggle = React.memo(function ViewToggle() {
  const activeView = useBoardStore((state) => state.activeView);
  const setActiveView = useBoardStore((state) => state.setActiveView);
  const openBoardManager = useBoardStore((state) => state.openBoardManager);

  // Board search/filter state (shared with KanbanBoard.tasksPerLane).
  const boardTasks = useBoardStore((state) => state.tasks);
  const boardSearchQuery = useBoardStore((state) => state.boardSearchQuery);
  const setBoardSearchQuery = useBoardStore((state) => state.setBoardSearchQuery);
  const boardSearchFocusNonce = useBoardStore((state) => state.boardSearchFocusNonce);
  const boardPriorityFilters = useBoardStore((state) => state.priorityFilters);
  const boardLabelFilters = useBoardStore((state) => state.labelFilters);
  const toggleBoardPriority = useBoardStore((state) => state.togglePriorityFilter);
  const toggleBoardLabel = useBoardStore((state) => state.toggleLabelFilter);
  const clearBoardFilters = useBoardStore((state) => state.clearBoardFilters);

  // Backlog search/filter state (shared with BacklogView.filteredItems) + actions.
  const backlogItems = useBacklogStore((state) => state.items);
  const backlogSearchQuery = useBacklogStore((state) => state.backlogSearchQuery);
  const setBacklogSearchQuery = useBacklogStore((state) => state.setBacklogSearchQuery);
  const backlogPriorityFilters = useBacklogStore((state) => state.backlogPriorityFilters);
  const backlogLabelFilters = useBacklogStore((state) => state.backlogLabelFilters);
  const toggleBacklogPriority = useBacklogStore((state) => state.toggleBacklogPriorityFilter);
  const toggleBacklogLabel = useBacklogStore((state) => state.toggleBacklogLabelFilter);
  const clearBacklogFilters = useBacklogStore((state) => state.clearBacklogFilters);
  const openNewDialog = useBacklogStore((state) => state.openNewDialog);
  const setImportSource = useBacklogStore((state) => state.setImportSource);

  const priorities = useConfigStore((state) => state.config.backlog.priorities);
  const labelColors = useConfigStore((state) => state.config.backlog.labelColors);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const boardLabels = useMemo(() => {
    const labelSet = new Set<string>();
    for (const task of boardTasks) {
      for (const label of (task.labels ?? [])) labelSet.add(label);
    }
    return [...labelSet].sort();
  }, [boardTasks]);

  // Backlog filter spans backlog + board labels (a label may live on either).
  const backlogLabels = useMemo(() => {
    const labelSet = new Set<string>();
    for (const item of backlogItems) {
      for (const label of item.labels) labelSet.add(label);
    }
    for (const task of boardTasks) {
      for (const label of (task.labels ?? [])) labelSet.add(label);
    }
    return [...labelSet].sort();
  }, [backlogItems, boardTasks]);

  // Plain Ctrl+F (owned by useSearchPalette, routed through AppLayout) bumps the
  // focus nonce so the board search takes focus without a cross-component ref.
  // Track the last-handled nonce: this effect also re-runs on every activeView
  // change, so without the guard a backlog->board switch would re-steal focus on
  // an unchanged nonce. Only act when the nonce itself actually advanced.
  const lastHandledFocusNonce = useRef(0);
  useEffect(() => {
    if (
      boardSearchFocusNonce > 0 &&
      boardSearchFocusNonce !== lastHandledFocusNonce.current &&
      activeView === 'board'
    ) {
      lastHandledFocusNonce.current = boardSearchFocusNonce;
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [boardSearchFocusNonce, activeView]);

  return (
    <div className="flex items-center px-4 pt-2 pb-2 border-b border-edge" data-testid="view-toggle">
      {/* `ground="raised"`: this sits on the app ground, not in a form row, so the
          thumb takes `surface-raised` (lighter than its track in every theme)
          rather than the `surface-hover` fill the settings-row variant shares
          with `Select`. See the token note in SegmentedControl. */}
      <SegmentedControl
        ground="raised"
        ariaLabel="View"
        testId="view-toggle-group"
        value={activeView}
        onChange={setActiveView}
        options={[
          { value: 'board' as const, label: 'Board', testId: 'view-toggle-board' },
          {
            value: 'backlog' as const,
            label: 'Backlog',
            testId: 'view-toggle-backlog',
            trailing: backlogItems.length > 0
              ? <CountBadge count={backlogItems.length} variant={activeView === 'backlog' ? 'accent' : 'muted'} />
              : undefined,
          },
        ]}
      />

      <div className="w-px h-5 bg-edge/50 mx-2.5" />

      <div className="flex items-center gap-1.5">
        <LabelsPopover />
        <PrioritiesPopover />
      </div>

      <div className="w-px h-5 bg-edge/50 mx-2.5" />

      {activeView === 'board' ? (
        <ToolbarSearchFilter
          searchValue={boardSearchQuery}
          onSearchChange={setBoardSearchQuery}
          searchPlaceholder="Search board..."
          searchInputRef={searchInputRef}
          searchTestId="board-search"
          searchClearTestId="board-search-clear"
          filterTestId="board-filter-btn"
          priorities={priorities}
          priorityFilters={boardPriorityFilters}
          onTogglePriority={toggleBoardPriority}
          allLabels={boardLabels}
          labelColors={labelColors}
          labelFilters={boardLabelFilters}
          onToggleLabel={toggleBoardLabel}
          onClearFilters={clearBoardFilters}
        />
      ) : (
        <ToolbarSearchFilter
          searchValue={backlogSearchQuery}
          onSearchChange={setBacklogSearchQuery}
          searchPlaceholder="Search backlog..."
          searchTestId="backlog-search"
          searchClearTestId="backlog-search-clear"
          filterTestId="backlog-filter-btn"
          priorities={priorities}
          priorityFilters={backlogPriorityFilters}
          onTogglePriority={toggleBacklogPriority}
          allLabels={backlogLabels}
          labelColors={labelColors}
          labelFilters={backlogLabelFilters}
          onToggleLabel={toggleBacklogLabel}
          onClearFilters={clearBacklogFilters}
        />
      )}

      {activeView === 'board' ? (
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => openBoardManager(null, true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
            data-testid="add-column-button"
          >
            <Plus size={16} />
            <span>Add column</span>
          </button>
        </div>
      ) : (
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={openNewDialog}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors"
            data-testid="new-backlog-task-btn"
          >
            <Plus size={14} />
            New Task
          </button>
          <ImportPopover onOpenImportDialog={setImportSource} />
        </div>
      )}
    </div>
  );
});
