import React, { useMemo } from 'react';
import type { Task, WorkflowBoardEnds, WorkflowViewTask } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { findBoardTask } from '../../utils/board-task-index';
import { TaskCardBody, TaskCardCompactBody, WorkflowWaitingBar, taskCardFrameClass, useTaskCardViewModel } from '../board/task-card-view';
import { ProjectStripLabel, WorkflowCardStrip } from './WorkflowStrip';

/**
 * A workflow task's card on the canvas: the board's own card content
 * (`task-card-view.tsx`, so the two cannot drift) under the workflow strip,
 * as tall as its content, as a board card is. The layout reads the height
 * React Flow measures and re-spaces a column when a card grows
 * (`canvas-card-heights.ts`). A task in Done is the Done column's compact card.
 */

/**
 * A selected card's border, on every card: the theme's accent at the border's
 * own 1px (sign-off S3, 2026-10-07), the one marked card on the canvas. The
 * cards it is linked to wear no ring: its links' colors say which feeds it and
 * which it feeds (WorkflowEdge.tsx).
 */
const SELECTED_BORDER_CLASS = '!border-accent';

/** A planned task drawn as the To Do card it will become. It has no number and no session. */
export function plannedAsTask(viewTask: WorkflowViewTask): Task {
  const planned = viewTask.planned;
  const now = '1970-01-01T00:00:00.000Z';
  return {
    id: viewTask.key,
    display_id: 0,
    title: viewTask.title,
    description: planned?.description ?? '',
    swimlane_id: '',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    worktree_folder: null,
    worktree_skip_reason: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    head_sha: null,
    pushed_branch: null,
    external_id: null,
    external_source: null,
    external_url: null,
    base_branch: null,
    resolved_base_branch: null,
    use_worktree: null,
    labels: planned?.labels ?? [],
    priority: planned?.priority ?? 0,
    model_override: null,
    effort_override: null,
    agent_override: null,
    permission_mode: null,
    auto_command: null,
    profile_id: null,
    run_mode: 'column_settings',
    automations_disabled: false,
    workflow_id: null,
    workflow_project_id: null,
    route_start_swimlane_id: planned?.route_start_swimlane_id ?? null,
    route_last_swimlane_id: planned?.route_last_swimlane_id ?? null,
    skipped_swimlane_ids: planned?.skipped_swimlane_ids ?? [],
    canvas_x: viewTask.canvasX,
    canvas_y: viewTask.canvasY,
    plan_approval: planned?.plan_approval ?? null,
    attachment_count: 0,
    auto_command_state: null,
    auto_command_text: null,
    auto_command_error: null,
    auto_command_at: null,
    detail_view_state: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

interface WorkflowCanvasCardProps {
  viewTask: WorkflowViewTask;
  selected: boolean;
  /** What the footer says while the task waits in To Do ("Blocked by #413...", "Queued...", "Paused"). */
  waiting: WorkflowWaiting | null;
  /** The task's board, named in its strip on every card. */
  projectName: string;
  /**
   * A task on another board: that board's Done column color, which its Done
   * border wears. Null on the home board, whose live color the canvas sets as
   * `--workflow-done-color`.
   */
  doneColor: string | null;
  /** The task's board's To Do and Done columns, the two ends of its track. */
  ends: WorkflowBoardEnds | null;
}

/** Why a workflow task in To Do has not started. */
export interface WorkflowWaiting {
  label: string;
  paused: boolean;
}

export const WorkflowCanvasCard = React.memo(function WorkflowCanvasCard({ viewTask, selected, waiting, projectName, doneColor, ends }: WorkflowCanvasCardProps) {
  // The board's own live row when the board holds it (this project, not yet
  // archived): every writer keeps the board current, including the ones that
  // never announce a workflow change (an agent's rename, auto-naming, a PR
  // refresh), so the card reads exactly what its board card reads. The
  // workflow's snapshot covers the rest: a task in Done, or on another board.
  const taskId = viewTask.task?.id ?? null;
  const liveTask = useBoardStore((state) => (taskId ? findBoardTask(state.tasks, taskId) : undefined));
  const snapshotTask = useMemo(() => viewTask.task ?? plannedAsTask(viewTask), [viewTask]);
  const task = liveTask ?? snapshotTask;
  const view = useTaskCardViewModel(task);
  const planned = viewTask.place === 'planned';

  // The column is the track's own marker, so the strip names no column; its
  // left side holds the task's project, on every card, on one board or
  // several, so a card has one shape whatever the workflow spans and none
  // changes when a task on another board joins (sign-off 4b).
  const strip = (
    <WorkflowCardStrip
      leading={<ProjectStripLabel name={projectName} testId="workflow-card-project" />}
      steps={viewTask.steps}
      ends={ends}
      place={viewTask.place}
      stallReason={viewTask.stallReason}
    />
  );

  if (viewTask.place === 'done') {
    // A 1px border in the board's own Done column color, which the canvas sets
    // as `--workflow-done-color`, so finished work stands out and follows the
    // column (Final 1). A task on another board sets the variable to its own
    // board's color here, on the card, since that board's Done column is not
    // the open one's. Selected, it wears the accent like every card.
    // The board's own Done cards are drawn elsewhere and keep their look.
    const frameClass = selected ? `border ${SELECTED_BORDER_CLASS}` : 'border border-[color:var(--workflow-done-color)]';
    return (
      <div
        className={`flex flex-col overflow-hidden bg-surface-raised/60 rounded-md select-none transition-colors ${frameClass}`}
        style={doneColor !== null ? { '--workflow-done-color': doneColor } as React.CSSProperties : undefined}
        data-workflow-task-key={viewTask.key}
        data-selected={selected}
        data-testid="workflow-canvas-card"
      >
        {strip}
        <div className="px-2.5 py-1.5">
          <TaskCardCompactBody task={task} view={view} />
        </div>
      </div>
    );
  }

  const idleFooter = waiting ? <WorkflowWaitingBar label={waiting.label} paused={waiting.paused} /> : undefined;

  // The selected card's border is the accent at the border's own 1px, so a
  // card keeps one height selected or not, which the layout stacks the column
  // from. The board's 2px highlight for the active session is left off here:
  // that session's terminal is the bottom panel, which Workflows hides, and a
  // heavier grey border would outweigh the selection. A planned card draws
  // like any To Do card: what says it is not created yet is its missing #id
  // (Final 3).
  const comfortable = view.cardDensity === 'comfortable';
  const headerInset = comfortable ? '-mx-3 -mt-3 mb-2' : '-mx-2.5 -mt-2.5 mb-2';
  const frameClass = taskCardFrameClass(view.isHighlighted ? { ...view, isHighlighted: false } : view, view.cardDensity);

  return (
    <div
      className={`flex flex-col overflow-hidden ${frameClass} select-none transition-colors ${selected ? SELECTED_BORDER_CLASS : ''}`}
      data-workflow-task-key={viewTask.key}
      data-selected={selected}
      data-testid="workflow-canvas-card"
    >
      <div className={headerInset}>{strip}</div>
      <TaskCardBody task={task} view={view} density={view.cardDensity} hideDisplayId={planned} idleFooter={idleFooter} />
    </div>
  );
});
