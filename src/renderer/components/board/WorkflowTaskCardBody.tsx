import React, { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CirclePause, ListTree, Loader2 } from 'lucide-react';
import type { AppConfig, Task } from '../../../shared/types';
import { routeSteps } from '../../../shared/workflow-route';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { boardWaiting, boardWorkflowSource, isLockedOnBoard, toBoardWorkflow, type BoardWorkflow } from '../../utils/board-workflow';
import { workflowColor } from '../workflows/workflow-graph';
import { WorkflowCardStrip } from '../workflows/WorkflowStrip';
import { CardStatusBar, TaskCardBody, type TaskCardViewModel } from './task-card-view';

/**
 * A workflow task's card content on the board: the workflow strip on top
 * (its workflow's icon in the workflow's color, the name, the step track, the
 * lock), then the board's own card, whose footer says what a task in To Do
 * waits for. Mounted only for a task in a workflow, so an ordinary card pays
 * for none of these subscriptions.
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

interface WorkflowTaskCardBodyProps {
  task: Task;
  view: TaskCardViewModel;
  density: AppConfig['cardDensity'];
}

export function WorkflowTaskCardBody({ task, view, density }: WorkflowTaskCardBodyProps) {
  const workflow = useBoardWorkflow(task);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  // The board store keeps an unchanged task's object across reloads, so this
  // recomputes on a real change to the row or the board's columns only.
  const steps = useMemo(() => routeSteps(swimlanes, task), [swimlanes, task]);
  const inToDo = useMemo(
    () => swimlanes.find((lane) => lane.id === task.swimlane_id)?.role === 'todo',
    [swimlanes, task.swimlane_id],
  );

  if (!workflow) return <TaskCardBody task={task} view={view} density={density} />;

  const waiting = inToDo ? boardWaiting(workflow) : null;
  const idleFooter = waiting ? (
    <CardStatusBar testId="workflow-status-bar" title={waiting.label}>
      {waiting.paused
        ? <CirclePause size={12} className="shrink-0" />
        : <Loader2 size={12} className="animate-spin shrink-0" />}
      <span className="truncate">{waiting.label}</span>
    </CardStatusBar>
  ) : undefined;

  return (
    <>
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
      <TaskCardBody task={task} view={view} density={density} idleFooter={idleFooter} />
    </>
  );
}
