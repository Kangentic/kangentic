import type { Swimlane, Task } from '../../shared/types';
import { useProjectStore } from '../stores/project-store';
import { useToastStore } from '../stores/toast-store';
import { useWorkflowStore } from '../stores/workflow-store';
import { boardMoveRefusal, boardWorkflowOf, type BoardWorkflow } from './board-workflow';

/**
 * A board move a workflow's lock refuses, caught before the card moves: the
 * drop and the card menu ask here first, with the same predicate main asks,
 * so a refused card never slides into a column and back. Main still refuses
 * on its own, for every other path.
 */

/** The workflow a board card is in, read at the moment of a click or a drop. */
export function boardWorkflowNow(task: Pick<Task, 'id' | 'workflow_id' | 'workflow_project_id'>): BoardWorkflow | null {
  if (!task.workflow_id) return null;
  const { summaries, homeSummaries } = useWorkflowStore.getState();
  return boardWorkflowOf(summaries, homeSummaries, task, useProjectStore.getState().currentProject?.id ?? null);
}

/** Why the lock refuses this move; null allows it (or the task is in no workflow). */
export function refusedBoardMove(
  task: Pick<Task, 'id' | 'display_id' | 'swimlane_id' | 'workflow_id' | 'workflow_project_id'>,
  targetSwimlaneId: string,
  swimlanes: readonly Pick<Swimlane, 'id' | 'role'>[],
): string | null {
  if (!task.workflow_id || task.swimlane_id === targetSwimlaneId) return null;
  return boardMoveRefusal(boardWorkflowNow(task), task, swimlanes.find((lane) => lane.id === targetSwimlaneId));
}

/**
 * Say why, and show it: the refusal as a toast whose card opens the workflow
 * on this task, and the links overlay on the card, so what it waits on or
 * holds up is on screen without leaving the board. `openWorkflowsView` is the
 * caller's (the board store owns the view switch).
 */
export function showWorkflowRefusal(
  task: Pick<Task, 'id' | 'workflow_id' | 'workflow_project_id'>,
  refusal: string,
  openWorkflowsView: () => void,
): void {
  const workflow = boardWorkflowNow(task);
  useToastStore.getState().addToast({
    title: 'Workflow controls this task',
    message: refusal,
    variant: 'info',
    onOpen: workflow
      ? () => {
        openWorkflowsView();
        useWorkflowStore.getState().openWorkflow(workflow.homeProjectId, workflow.workflowId, task.id);
      }
      : undefined,
  });
  if (workflow) void useWorkflowStore.getState().showLinks(task.id, workflow.homeProjectId, workflow.workflowId);
}
