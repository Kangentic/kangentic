import React, { useMemo } from 'react';
import { Folder } from 'lucide-react';
import type { AppConfig, Task, WorkflowViewTask } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { findBoardTask } from '../../utils/board-task-index';
import { TaskCardBody, TaskCardCompactBody, WorkflowWaitingBar, taskCardFrameClass, useTaskCardViewModel } from '../board/task-card-view';
import { WorkflowCardStrip, WorkflowStripLabel, type OutsideRouteColumn } from './WorkflowStrip';

/**
 * A workflow task's card on the canvas: the board's own card content
 * (`task-card-view.tsx`, so the two cannot drift) under the workflow strip,
 * at a fixed height per density so the layout never jumps when a card's
 * content changes. A task in Done is the Done column's compact card.
 */

export const CANVAS_CARD_HEIGHT: Record<AppConfig['cardDensity'], number> = {
  compact: 128,
  default: 204,
  comfortable: 224,
};
/** The strip over the Done column's compact card (title, a line, labels, when it finished), measured at 127. */
export const CANVAS_DONE_CARD_HEIGHT = 132;

/** A selected card's border, on every card: 2px inside the card, in the muted grey. */
const SELECTED_BORDER_CLASS = '!border-2 !border-fg-muted/75';

/** A card's height on the canvas: one per density, and the Done card's. Naming its project costs nothing, since the name sits in the strip. */
export function canvasCardHeight(task: Pick<WorkflowViewTask, 'place'>, density: AppConfig['cardDensity']): number {
  return task.place === 'done' ? CANVAS_DONE_CARD_HEIGHT : CANVAS_CARD_HEIGHT[density];
}

/**
 * The card's project, in the strip's left side (board 17, folded into the
 * strip as the phone draws it): shown on every card once any task of the
 * workflow is on another board, and on none while they all share one, where
 * the name would say nothing.
 */
function ProjectLabel({ name }: { name: string }) {
  return (
    <WorkflowStripLabel
      icon={<Folder size={12} className="text-fg-muted" />}
      label={name}
      className="gap-1.5 text-fg-tertiary"
      testId="workflow-card-project"
    />
  );
}

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
    workflow_id: null,
    workflow_project_id: null,
    route_start_swimlane_id: planned?.route_start_swimlane_id ?? null,
    route_last_swimlane_id: planned?.route_last_swimlane_id ?? null,
    skipped_swimlane_ids: planned?.skipped_swimlane_ids ?? [],
    canvas_x: viewTask.canvasX,
    canvas_y: viewTask.canvasY,
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

/** Where a task off its route is: To Do until it starts, Done once it finishes. A task at work is on its route. */
function outsideRouteOf(viewTask: WorkflowViewTask): OutsideRouteColumn | null {
  if (viewTask.place === 'planned' || viewTask.place === 'todo') return TO_DO_COLUMN;
  if (viewTask.place === 'done') return DONE_COLUMN;
  return null;
}

const TO_DO_COLUMN: OutsideRouteColumn = { role: 'todo', name: 'To Do' };
const DONE_COLUMN: OutsideRouteColumn = { role: 'done', name: 'Done' };

interface WorkflowCanvasCardProps {
  viewTask: WorkflowViewTask;
  selected: boolean;
  /** The workflow runs: the card moves by its workflow, not by hand. */
  locked: boolean;
  /** What the footer says while the task waits in To Do ("Blocked by #413...", "Queued...", "Paused"). */
  waiting: WorkflowWaiting | null;
  /** The task's board, named while the workflow spans boards; null while it is on one. */
  projectName: string | null;
  /**
   * A task on another board: that board's Done column color, which its Done
   * border wears. Null on the home board, whose live color the canvas sets as
   * `--workflow-done-color`.
   */
  doneColor: string | null;
}

/** Why a workflow task in To Do has not started. */
export interface WorkflowWaiting {
  label: string;
  paused: boolean;
}

export const WorkflowCanvasCard = React.memo(function WorkflowCanvasCard({ viewTask, selected, locked, waiting, projectName, doneColor }: WorkflowCanvasCardProps) {
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
  const height = canvasCardHeight(viewTask, view.cardDensity);

  // The column is the track's own marker, so the strip names no column; its
  // left side holds the project while the workflow spans boards, else nothing.
  const strip = (
    <WorkflowCardStrip
      leading={projectName !== null ? <ProjectLabel name={projectName} /> : null}
      steps={viewTask.steps}
      outsideRoute={outsideRouteOf(viewTask)}
      lockedTitle={locked ? 'Moved by its workflow' : null}
    />
  );

  if (viewTask.place === 'done') {
    // A 1px border in the board's own Done column color, which the canvas sets
    // as `--workflow-done-color`, so finished work stands out and follows the
    // column (Final 1). A task on another board sets the variable to its own
    // board's color here, on the card, since that board's Done column is not
    // the open one's. Selected, it takes every card's 2px border instead; the
    // body's padding gives the extra pixel back, so its text does not move.
    // The board's own Done cards are drawn elsewhere and keep their look.
    const frameClass = selected ? SELECTED_BORDER_CLASS : 'border border-[color:var(--workflow-done-color)]';
    const bodyPadding = selected ? 'px-[9px] py-[5px]' : 'px-2.5 py-1.5';
    return (
      <div
        className={`flex flex-col overflow-hidden bg-surface-raised/60 rounded-md select-none transition-colors ${frameClass}`}
        style={doneColor !== null ? { height, '--workflow-done-color': doneColor } as React.CSSProperties : { height }}
        data-workflow-task-key={viewTask.key}
        data-selected={selected}
        data-testid="workflow-canvas-card"
      >
        {strip}
        <div className={`${bodyPadding} min-h-0 overflow-hidden`}>
          <TaskCardCompactBody task={task} view={view} />
        </div>
      </div>
    );
  }

  const idleFooter = waiting ? <WorkflowWaitingBar label={waiting.label} paused={waiting.paused} /> : undefined;

  // Selected: a 2px border inside the card (boards 1, 10, 17). The padding and
  // the header's inset give back the extra pixel, so nothing inside the card
  // moves. A planned card draws like any To Do card: what says it is not
  // created yet is its missing #id (Final 3).
  const comfortable = view.cardDensity === 'comfortable';
  const borderClass = selected
    ? `${SELECTED_BORDER_CLASS} ${comfortable ? '!p-[11px]' : '!p-[9px]'}`
    : '';
  const headerInset = selected
    ? (comfortable ? '-mx-[11px] -mt-[11px]' : '-mx-[9px] -mt-[9px]')
    : (comfortable ? '-mx-3 -mt-3' : '-mx-2.5 -mt-2.5');

  return (
    <div
      className={`flex flex-col overflow-hidden ${taskCardFrameClass(view, view.cardDensity)} select-none transition-colors ${borderClass}`}
      style={{ height }}
      data-workflow-task-key={viewTask.key}
      data-selected={selected}
      data-testid="workflow-canvas-card"
    >
      <div className={`${headerInset} mb-2`}>{strip}</div>
      <TaskCardBody task={task} view={view} density={view.cardDensity} hideDisplayId={planned} idleFooter={idleFooter} fill />
    </div>
  );
});
