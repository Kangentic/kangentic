import React, { useMemo } from 'react';
import { CirclePause, Loader2 } from 'lucide-react';
import type { AppConfig, Task, WorkflowViewTask } from '../../../shared/types';
import { RegistryIcon } from '../../utils/swimlane-icons';
import { useBoardStore } from '../../stores/board-store';
import { CardStatusBar, TaskCardBody, TaskCardCompactBody, taskCardFrameClass, useTaskCardViewModel } from '../board/task-card-view';
import { WorkflowCardStrip } from './WorkflowStrip';

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
export const CANVAS_DONE_CARD_HEIGHT = 120;

export function canvasCardHeight(task: Pick<WorkflowViewTask, 'place'>, density: AppConfig['cardDensity']): number {
  return task.place === 'done' ? CANVAS_DONE_CARD_HEIGHT : CANVAS_CARD_HEIGHT[density];
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

/** The column the strip names: where the task is, or To Do until it starts. */
function stripColumn(viewTask: WorkflowViewTask): { name: string; color: string | null; icon: string | null } {
  if (viewTask.place === 'planned' || viewTask.place === 'todo') return { name: 'To Do', color: null, icon: 'layers' };
  if (viewTask.place === 'done') return { name: 'Done', color: null, icon: 'circle-check-big' };
  const current = viewTask.steps.find((step) => step.state === 'current');
  return current
    ? { name: current.name, color: current.color, icon: current.icon }
    : { name: viewTask.task ? 'Another column' : 'To Do', color: null, icon: null };
}

interface WorkflowCanvasCardProps {
  viewTask: WorkflowViewTask;
  selected: boolean;
  /** The workflow runs: the card moves by its workflow, not by hand. */
  locked: boolean;
  /** What the footer says while the task waits in To Do ("Blocked by #413...", "Queued...", "Paused"). */
  waiting: WorkflowWaiting | null;
}

/** Why a workflow task in To Do has not started. */
export interface WorkflowWaiting {
  label: string;
  paused: boolean;
}

export const WorkflowCanvasCard = React.memo(function WorkflowCanvasCard({ viewTask, selected, locked, waiting }: WorkflowCanvasCardProps) {
  // The board's own live row when the board holds it (this project, not yet
  // archived): every writer keeps the board current, including the ones that
  // never announce a workflow change (an agent's rename, auto-naming, a PR
  // refresh), so the card reads exactly what its board card reads. The
  // workflow's snapshot covers the rest: a task in Done, or on another board.
  const taskId = viewTask.task?.id ?? null;
  const liveTask = useBoardStore((state) => (taskId ? state.tasks.find((candidate) => candidate.id === taskId) : undefined));
  const snapshotTask = useMemo(() => viewTask.task ?? plannedAsTask(viewTask), [viewTask]);
  const task = liveTask ?? snapshotTask;
  const view = useTaskCardViewModel(task);
  const column = stripColumn(viewTask);
  const planned = viewTask.place === 'planned';
  const height = canvasCardHeight(viewTask, view.cardDensity);

  const strip = (
    <WorkflowCardStrip
      icon={<RegistryIcon name={column.icon ?? 'square'} size={12} strokeWidth={1.75} style={{ color: column.color ?? 'var(--color-fg-faint)' }} />}
      label={column.name}
      steps={viewTask.steps}
      lockedTitle={locked ? 'Moved by its workflow' : null}
    />
  );

  const selectionClass = selected
    ? 'ring-2 ring-fg-faint/75'
    : '';

  if (viewTask.place === 'done') {
    return (
      <div
        className={`flex flex-col overflow-hidden bg-surface-raised/60 border border-edge/50 rounded-md select-none hover:border-edge-input transition-colors ${selectionClass}`}
        style={{ height }}
        data-workflow-task-key={viewTask.key}
        data-selected={selected}
        data-testid="workflow-canvas-card"
      >
        {strip}
        <div className="px-2.5 py-1.5 min-h-0 overflow-hidden">
          <TaskCardCompactBody task={task} view={view} />
        </div>
      </div>
    );
  }

  const idleFooter = waiting ? (
    <CardStatusBar testId="workflow-status-bar" title={waiting.label}>
      {waiting.paused
        ? <CirclePause size={12} className="shrink-0" />
        : <Loader2 size={12} className="animate-spin shrink-0" />}
      <span className="truncate">{waiting.label}</span>
    </CardStatusBar>
  ) : undefined;

  return (
    <div
      className={`flex flex-col overflow-hidden ${taskCardFrameClass(view, view.cardDensity)} select-none transition-colors ${planned ? '!border-dashed !border-edge-input' : ''} ${selectionClass}`}
      style={{ height }}
      data-workflow-task-key={viewTask.key}
      data-selected={selected}
      data-testid="workflow-canvas-card"
    >
      <div className={view.cardDensity === 'comfortable' ? '-mx-3 -mt-3 mb-2' : '-mx-2.5 -mt-2.5 mb-2'}>{strip}</div>
      <TaskCardBody task={task} view={view} density={view.cardDensity} hideDisplayId={planned} idleFooter={idleFooter} fill />
    </div>
  );
});
