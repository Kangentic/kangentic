import React, { useEffect, useMemo, useRef } from 'react';
import { Columns3, ListTodo, Plus } from 'lucide-react';
import { CountBadge } from '../CountBadge';
import { SegmentedControl } from '../SegmentedControl';
import { ToolbarSearchFilter } from '../ToolbarSearchFilter';
import { ImportPopover } from '../backlog/ImportPopover';
import { LabelsPopover } from '../backlog/manage-labels/LabelsPopover';
import { PrioritiesPopover } from '../backlog/manage-labels/PrioritiesPopover';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';
import {
  BACKLOG_TOOLBAR_COLLAPSE,
  BOARD_TOOLBAR_COLLAPSE,
  TOOLBAR_ROW_CONTAINER_CLASS,
} from './toolbar-collapse';

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

  // Per branch, because the two carry different content and so run out of room at
  // genuinely different widths: backlog has two actions where board has one, and
  // New Task is wider than Add column. The derivation is in toolbar-collapse.ts.
  const collapse = activeView === 'board' ? BOARD_TOOLBAR_COLLAPSE : BACKLOG_TOOLBAR_COLLAPSE;

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
    // `@container` + `min-w-0`: every control below sheds its text on a container
    // query against THIS row, so the ladder reads the space the row actually has
    // (sidebar already subtracted) rather than the window width. The whole ladder,
    // and why it is not the task-detail header's measurement hook, is in
    // toolbar-collapse.ts.
    <div
      className={`flex items-center px-4 pt-2 pb-2 border-b border-edge min-w-0 ${TOOLBAR_ROW_CONTAINER_CLASS}`}
      data-testid="view-toggle"
    >
      {/* `ground="raised"`: this sits on the app ground, not in a form row, so the
          thumb takes `surface-raised` (lighter than its track in every theme)
          rather than the `surface-hover` fill the settings-row variant shares
          with `Select`. See the token note in SegmentedControl. */}
      <SegmentedControl
        ground="raised"
        ariaLabel="View"
        testId="view-toggle-group"
        className="shrink-0"
        labelClassName={collapse.viewSwitcherLabel}
        value={activeView}
        onChange={setActiveView}
        options={[
          {
            value: 'board' as const,
            label: 'Board',
            testId: 'view-toggle-board',
            // Columns-against-list is the least self-evident glyph pair on this
            // row, and at the last step it is all that is left of the switcher.
            title: 'Board',
            // The icon is the label's replacement, not an addition, so it carries
            // the inverse of the label's container query. Its `h-5` restores the
            // 20px content height the label's line box had, so the option keeps
            // its padding-derived 34px once the text goes. Without it the content
            // is the 16px glyph and the option derives 30px instead.
            icon: <span className={collapse.viewSwitcherIcon}><Columns3 size={16} /></span>,
          },
          {
            value: 'backlog' as const,
            label: 'Backlog',
            testId: 'view-toggle-backlog',
            title: 'Backlog',
            // The option's accessible name is set from `ariaLabel`, so the badge
            // below contributes nothing to it. Spell the count out here or it is
            // lost to a screen reader at every width, not just the collapsed one.
            ariaLabel: backlogItems.length > 0 ? `Backlog, ${backlogItems.length} items` : 'Backlog',
            icon: <span className={collapse.viewSwitcherIcon}><ListTodo size={16} /></span>,
            // The count stays through every step: it is the one thing the switcher
            // says that an icon cannot.
            trailing: backlogItems.length > 0
              ? <CountBadge count={backlogItems.length} variant={activeView === 'backlog' ? 'accent' : 'muted'} />
              : undefined,
          },
        ]}
      />

      <div className={collapse.divider} />

      <div className="flex items-center gap-1.5 shrink-0">
        <LabelsPopover collapse={collapse.filterControl} />
        <PrioritiesPopover collapse={collapse.filterControl} />
      </div>

      <div className={collapse.divider} />

      {/* Keyed per view: without a `key`, React reconciles ONE
          `ToolbarSearchFilter` instance across the view swap instead of
          unmounting it, so its Filter button's `transition-colors` (fill
          and border both change when `hasActiveFilters` differs between the
          two views' independent filter sets) interpolates from the old
          view's palette instead of painting the new one immediately. */}
      {activeView === 'board' ? (
        <ToolbarSearchFilter
          key="board-search"
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
          filterCollapse={collapse.filterControl}
        />
      ) : (
        <ToolbarSearchFilter
          key="backlog-search"
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
          filterCollapse={collapse.filterControl}
        />
      )}

      {/* Keyed per view for the reason above. Here the surviving node is the
          action button itself, so its colours cross-fade from the old view's
          palette while its label, padding, and icon size jump instantly. */}
      {/* `ml-2`, not `ml-auto`. An auto margin absorbs free space BEFORE
          `flex-grow` distributes it, so `ml-auto` here would stop the search
          field growing at all. The search's own `flex-1` is what pushes this
          cluster to the right now. */}
      {activeView === 'board' ? (
        <div key="board-actions" className="ml-2 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => openBoardManager(null, true)}
            title="Add column"
            aria-label="Add column"
            className={`flex items-center gap-1.5 py-1.5 text-sm font-medium rounded-md text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors whitespace-nowrap ${collapse.primaryAction.button}`}
            data-testid="add-column-button"
          >
            <Plus size={16} className="shrink-0" />
            <span className={collapse.primaryAction.label}>Add column</span>
          </button>
        </div>
      ) : (
        <div key="backlog-actions" className="ml-2 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={openNewDialog}
            title="New Task"
            aria-label="New Task"
            className={`flex items-center gap-1.5 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors whitespace-nowrap ${collapse.primaryAction.button}`}
            data-testid="new-backlog-task-btn"
          >
            <Plus size={14} className="shrink-0" />
            <span className={collapse.primaryAction.label}>New Task</span>
          </button>
          <ImportPopover onOpenImportDialog={setImportSource} collapse={collapse.filterControl} />
        </div>
      )}
    </div>
  );
});
