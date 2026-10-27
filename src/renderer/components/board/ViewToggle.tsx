import React, { useEffect, useMemo, useRef } from 'react';
import { Columns3, ListTodo, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { ActivityMark } from '../ActivityMark';
import { CountBadge } from '../CountBadge';
import { IconSlot } from '../IconSlot';
import { Tooltip } from '../Tooltip';
import { SegmentedControl } from '../SegmentedControl';
import { ToolbarSearchFilter } from '../ToolbarSearchFilter';
import { ImportPopover } from '../backlog/ImportPopover';
import { LabelsPopover } from '../backlog/manage-labels/LabelsPopover';
import { PrioritiesPopover } from '../backlog/manage-labels/PrioritiesPopover';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import {
  BACKLOG_TOOLBAR_COLLAPSE,
  BOARD_TOOLBAR_COLLAPSE,
  TOOLBAR_ROW_CONTAINER_CLASS,
  WORKFLOWS_TOOLBAR_COLLAPSE,
} from './toolbar-collapse';

export const ViewToggle = React.memo(function ViewToggle() {
  const { t } = useLingui();
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

  // The Workflows segment answers two questions, one at a time: how many
  // workflows the project has (the count pill, the same list the picker shows,
  // since main lists only unfinished ones) and whether work is moving on its own
  // (the working mark, in the count's place while any workflow runs). Never
  // both, since a number beside or inside the ring reads as that many running.
  // Loaded per project here, since this row is mounted whenever a project is.
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const workflowCount = useWorkflowStore((state) => (
    state.projectId === currentProjectId ? state.summaries.length : 0
  ));
  const runningWorkflowCount = useWorkflowStore((state) => (
    state.projectId === currentProjectId
      ? state.summaries.filter((summary) => summary.workflow.state === 'running').length
      : 0
  ));
  // "Workflows, 2 running" while any runs. The tip and the spoken name both say
  // it, each as one whole message per shape (running implies a count above zero).
  const workflowsTip = runningWorkflowCount > 0
    ? plural(runningWorkflowCount, { one: 'Workflows, # running', other: 'Workflows, # running' })
    : t`Workflows`;
  let workflowsAriaLabel: string;
  if (runningWorkflowCount > 0) {
    workflowsAriaLabel = t`Workflows, ${plural(workflowCount, { one: '# workflow', other: '# workflows' })}, ${plural(runningWorkflowCount, { one: '# running', other: '# running' })}`;
  } else if (workflowCount > 0) {
    workflowsAriaLabel = plural(workflowCount, { one: 'Workflows, # workflow', other: 'Workflows, # workflows' });
  } else {
    workflowsAriaLabel = t`Workflows`;
  }
  // "Backlog, 21 items": the count a screen reader hears in place of the pill.
  // Raw, as printed before: a `#` would group a count past 999 ("1,234").
  const backlogItemCount = backlogItems.length;
  const backlogItemCountText = String(backlogItemCount);
  const backlogAriaLabel = backlogItemCount > 0
    ? plural(backlogItemCount, { one: `Backlog, ${backlogItemCountText} item`, other: `Backlog, ${backlogItemCountText} items` })
    : t`Backlog`;
  useEffect(() => {
    if (currentProjectId) void useWorkflowStore.getState().loadWorkflows();
  }, [currentProjectId]);
  // A card on this board whose workflow lives in another project names and locks
  // by that project's list. Keyed by the set of homes, so a board reload that
  // changes no home loads nothing.
  const foreignHomes = useMemo(() => {
    const homes = new Set<string>();
    for (const task of boardTasks) {
      if (task.workflow_id && task.workflow_project_id && task.workflow_project_id !== currentProjectId) homes.add(task.workflow_project_id);
    }
    return [...homes].sort().join('\n');
  }, [boardTasks, currentProjectId]);
  useEffect(() => {
    void useWorkflowStore.getState().loadHomeSummaries(foreignHomes ? foreignHomes.split('\n') : []);
  }, [foreignHomes]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Per branch, because the three carry different content and so run out of room at
  // genuinely different widths: backlog has two actions where board has one, New
  // Task is wider than Add column, and Workflows has none. The derivation is in
  // toolbar-collapse.ts.
  const collapse = activeView === 'board'
    ? BOARD_TOOLBAR_COLLAPSE
    : activeView === 'workflows' ? WORKFLOWS_TOOLBAR_COLLAPSE : BACKLOG_TOOLBAR_COLLAPSE;
  // Workflows shares the board's search and filter: its cards are board tasks.
  const boardSearch = activeView !== 'backlog';

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
      activeView !== 'backlog'
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
        ariaLabel={t`View`}
        testId="view-toggle-group"
        className="shrink-0"
        labelClassName={collapse.viewSwitcherLabel}
        optionSpacingClassName={collapse.viewSwitcherSpacing}
        value={activeView}
        onChange={setActiveView}
        options={[
          {
            value: 'board' as const,
            label: t`Board`,
            testId: 'view-toggle-board',
            // Columns-against-list is the least self-evident glyph pair on this
            // row, and at the last step it is all that is left of the switcher.
            tip: t`Board`,
            // The icon is the label's replacement, not an addition, so it carries
            // the inverse of the label's container query. Its `h-5` restores the
            // 20px content height the label's line box had, so the option keeps
            // its padding-derived 34px once the text goes. Without it the content
            // is the 16px glyph and the option derives 30px instead.
            icon: <span className={collapse.viewSwitcherIcon}><Columns3 size={16} /></span>,
          },
          {
            value: 'backlog' as const,
            label: t`Backlog`,
            testId: 'view-toggle-backlog',
            tip: t`Backlog`,
            // The option's accessible name is set from `ariaLabel`, so the badge
            // below contributes nothing to it. Spell the count out here or it is
            // lost to a screen reader at every width, not just the collapsed one.
            ariaLabel: backlogAriaLabel,
            icon: <span className={collapse.viewSwitcherIcon}><ListTodo size={16} /></span>,
            // The count stays through every step: it is the one thing the switcher
            // says that an icon cannot. Tinted from the option's own text tone, so
            // it follows the tab from idle to selected with no variant of its own.
            trailing: backlogItems.length > 0
              ? <CountBadge count={backlogItems.length} variant="tinted" size="pill" testId="view-toggle-backlog-count" />
              : undefined,
          },
          {
            value: 'workflows' as const,
            label: t`Workflows`,
            testId: 'view-toggle-workflows',
            // The ring takes no pointer inside the slot below, so it cannot carry a
            // tip of its own, and the option's tip says what runs. The tip keeps the
            // tab's name, the SegmentedControl exception one-tooltip.md records. At
            // the icon-only steps it is the only label the option has left, as
            // Board's and Backlog's are.
            tip: workflowsTip,
            // The count is spoken while the ring hides it from view.
            ariaLabel: workflowsAriaLabel,
            icon: <span className={collapse.viewSwitcherIcon}><WorkflowIcon size={16} /></span>,
            // One slot for both branches: a running workflow swaps the pill for
            // the picker's Running ring at the sidebar's 16px, an element-type swap
            // that would otherwise eat a click landing mid-swap
            // (.claude/rules/activity-marks.md). The slot holds the pill's 18px, so
            // nothing in the row moves for a count under 10.
            trailing: workflowCount > 0
              ? (
                <IconSlot size={18} grow className="shrink-0">
                  {runningWorkflowCount > 0
                    ? (
                      <span className="inline-flex text-active" data-testid="view-toggle-workflows-running">
                        <ActivityMark mark="agent-working" size={16} aria-label={t({ message: 'Running', context: 'Workflow status' })} />
                      </span>
                    )
                    : <CountBadge count={workflowCount} variant="tinted" size="pill" testId="view-toggle-workflows-count" />}
                </IconSlot>
              )
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
      {boardSearch ? (
        <ToolbarSearchFilter
          key="board-search"
          searchValue={boardSearchQuery}
          onSearchChange={setBoardSearchQuery}
          searchPlaceholder={t`Search board...`}
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
          searchPlaceholder={t`Search backlog...`}
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
          <Tooltip label={t`Add column`}>
            <button
              type="button"
              onClick={() => openBoardManager(null, true)}
              aria-label={t`Add column`}
              className={`flex items-center gap-1.5 py-1.5 text-sm font-medium rounded-md text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors whitespace-nowrap ${collapse.primaryAction.button}`}
              data-testid="add-column-button"
            >
              <Plus size={16} className="shrink-0" />
              <span className={collapse.primaryAction.label}><Trans>Add column</Trans></span>
            </button>
          </Tooltip>
        </div>
      ) : activeView === 'workflows' ? null : (
        <div key="backlog-actions" className="ml-2 flex items-center gap-2 shrink-0">
          <Tooltip label={t`New Task`}>
            <button
              type="button"
              onClick={openNewDialog}
              aria-label={t`New Task`}
              className={`flex items-center gap-1.5 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors whitespace-nowrap ${collapse.primaryAction.button}`}
              data-testid="new-backlog-task-btn"
            >
              <Plus size={14} className="shrink-0" />
              <span className={collapse.primaryAction.label}><Trans>New Task</Trans></span>
            </button>
          </Tooltip>
          <ImportPopover onOpenImportDialog={setImportSource} collapse={collapse.filterControl} />
        </div>
      )}
    </div>
  );
});
