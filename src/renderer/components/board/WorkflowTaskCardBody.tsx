import React, { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ListTree } from 'lucide-react';
import type { AppConfig, Task } from '../../../shared/types';
import { routeSteps } from '../../../shared/workflow-route';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { boardWaiting, boardWorkflowSource, isLockedOnBoard, toBoardWorkflow, type BoardWorkflow } from '../../utils/board-workflow';
import { workflowColor } from '../workflows/workflow-graph';
import { WorkflowCardStrip } from '../workflows/WorkflowStrip';
import { TaskCardBody, WorkflowWaitingBar, type TaskCardViewModel } from './task-card-view';

/**
 * A workflow task's card content on the board: the workflow strip on top
 * (its workflow's icon in the workflow's color, the name, the step track, the
 * lock), then the board's own card, whose footer says what a task in To Do
 * waits for. Mounted only for a task in a workflow, so an ordinary card pays
 * for none of these subscriptions.
 *
 * The strip and the footer are memoized on the task row: dnd-kit re-renders
 * every card when a drag starts, and they skip that pass. Measured with
 * `scripts/drag-perf-rig.mjs` (W100 board drag against the same cards with no
 * workflow).
 */

/** The card's workflow, as its summary describes it; null until the summary is loaded. */
export function useBoardWorkflow(task: Task): BoardWorkflow | null {
  const boardProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  // The workflow row and this task's own facts, each kept by reference across a
  // reload that did not change them (`shareSummaries`), so a move elsewhere in
  // the workflow re-renders only the cards it changed.
  const { workflow, facts, homeProjectId } = useWorkflowStore(useShallow(useCallback(
    (state: ReturnType<typeof useWorkflowStore.getState>) => {
      const source = boardWorkflowSource(state.summaries, state.homeSummaries, task, boardProjectId);
      return { workflow: source?.workflow ?? null, facts: source?.facts ?? null, homeProjectId: source?.homeProjectId ?? null };
    },
    [task, boardProjectId],
  )));
  return useMemo(
    () => (workflow && homeProjectId ? toBoardWorkflow({ workflow, facts, homeProjectId }) : null),
    [workflow, facts, homeProjectId],
  );
}

const BoardWorkflowStrip = React.memo(function BoardWorkflowStrip({ task, density }: { task: Task; density: AppConfig['cardDensity'] }) {
  const workflow = useBoardWorkflow(task);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  // The board store keeps an unchanged task's object across reloads, so this
  // recomputes on a real change to the row or the board's columns only.
  const steps = useMemo(() => routeSteps(swimlanes, task), [swimlanes, task]);
  if (!workflow) return null;
  return (
    <div
      className={`${density === 'comfortable' ? '-mx-3 -mt-3' : '-mx-2.5 -mt-2.5'} mb-2 rounded-t-[5px] overflow-hidden`}
      data-workflow-id={workflow.workflowId}
    >
      <WorkflowCardStrip
        icon={<ListTree size={12} strokeWidth={1.75} style={{ color: workflowColor(workflow.colorSlot) }} />}
        label={workflow.title}
        steps={steps}
        lockedTitle={isLockedOnBoard(workflow) ? 'Moved by its workflow' : null}
      />
    </div>
  );
});

/** What a To Do card waits for ("Blocked by #413...", "Queued...", "Paused"). */
const BoardWorkflowFooter = React.memo(function BoardWorkflowFooter({ task }: { task: Task }) {
  const waiting = boardWaiting(useBoardWorkflow(task));
  return waiting ? <WorkflowWaitingBar label={waiting.label} paused={waiting.paused} /> : null;
});

interface WorkflowTaskCardBodyProps {
  task: Task;
  view: TaskCardViewModel;
  density: AppConfig['cardDensity'];
}

export function WorkflowTaskCardBody({ task, view, density }: WorkflowTaskCardBodyProps) {
  const inToDo = useBoardStore((state) => state.swimlanes.find((lane) => lane.id === task.swimlane_id)?.role === 'todo');
  return (
    <>
      <BoardWorkflowStrip task={task} density={density} />
      <TaskCardBody task={task} view={view} density={density} idleFooter={inToDo ? <BoardWorkflowFooter task={task} /> : undefined} />
    </>
  );
}
