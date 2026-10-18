import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Swimlane, Task, WorkflowViewTask } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { invalidateProject } from '../../stores/project-cache';
import { describeIpcError } from '../../lib/ipc-error';
import { boardMoveRefusal, boardWorkflowOf, sendAwayRefusal } from '../../utils/board-workflow';
import { findBoardTask } from '../../utils/board-task-index';
import { useTaskDisplayKind } from '../../utils/task-progress';
import { runSessionToggle, sessionToggleRowFor } from '../../utils/session-toggle';
import { TaskContextMenu } from '../board/TaskContextMenu';

/**
 * A canvas card's right-click menu (#732 board 1d): the board's own
 * `TaskContextMenu`, so a task has one menu wherever it is right-clicked, with
 * Open on board in its `navigationItem` slot (the Agent Monitor's item, icon and
 * words). Nothing for a card's links: the canvas draws every link.
 *
 * Rendered by the view, outside React Flow. A task on this board acts through
 * the board store, as its board card does. A task on another board reads that
 * board's columns and acts on that project by id, as the Agent Monitor's menu
 * does, so Move to lists the columns the task can actually go to.
 */

interface WorkflowCardMenuProps {
  viewTask: WorkflowViewTask & { task: Task };
  position: { x: number; y: number };
  onClose: () => void;
  onOpenOnBoard: (viewTask: WorkflowViewTask) => void;
  onDelete: (task: Task, projectId: string) => void;
}

export function WorkflowCardMenu({ viewTask, position, onClose, onOpenOnBoard, onDelete }: WorkflowCardMenuProps) {
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const onThisBoard = viewTask.projectId === currentProjectId;
  const taskId = viewTask.task.id;
  const liveTask = useBoardStore((state) => (onThisBoard ? findBoardTask(state.tasks, taskId) : undefined));
  const boardSwimlanes = useBoardStore((state) => state.swimlanes);
  // Subscribed, not read once: a push while the menu is open (the workflow
  // pausing) changes which rows are locked, and the menu must say so.
  const summaries = useWorkflowStore((state) => state.summaries);
  const homeSummaries = useWorkflowStore((state) => state.homeSummaries);
  const [elsewhere, setElsewhere] = useState<{ task: Task; swimlanes: Swimlane[] } | null>(null);
  const displayKind = useTaskDisplayKind(taskId);

  useEffect(() => {
    if (onThisBoard) return undefined;
    let cancelled = false;
    void window.electronAPI.monitor.getTaskDetail(viewTask.projectId, taskId)
      .then((bundle) => { if (!cancelled && bundle) setElsewhere({ task: bundle.task, swimlanes: bundle.swimlanes }); })
      .catch(() => { /* the menu does not open; Open on board still works from the inspector */ });
    return () => { cancelled = true; };
  }, [onThisBoard, viewTask.projectId, taskId]);

  const task = onThisBoard ? liveTask ?? viewTask.task : elsewhere?.task ?? null;
  const swimlanes = onThisBoard ? boardSwimlanes : elsewhere?.swimlanes ?? null;
  if (!task || !swimlanes) return null;

  // This view is the workflow's home, so its summary is in this project's list.
  const workflow = boardWorkflowOf(summaries, homeSummaries, task, currentProjectId);
  const reportFailure = (action: string, error: unknown) => {
    useToastStore.getState().addToast({ message: `Failed to ${action} "${task.title}": ${describeIpcError(error)}`, variant: 'warning' });
  };

  const moveTo = (targetSwimlaneId: string) => {
    const targetName = swimlanes.find((lane) => lane.id === targetSwimlaneId)?.name ?? 'column';
    if (onThisBoard) {
      const { tasks, moveTask } = useBoardStore.getState();
      const position = tasks.filter((candidate) => candidate.swimlane_id === targetSwimlaneId).length;
      void moveTask({ taskId, targetSwimlaneId, targetPosition: position }, false, currentProjectId).then((result) => {
        if (result.ok && !useBoardStore.getState().pendingMoveConfirm) {
          useToastStore.getState().addToast({ message: `Moved "${task.title}" to ${targetName}`, variant: 'success' });
        }
      });
      return;
    }
    void window.electronAPI.tasks.move({ taskId, targetSwimlaneId, targetPosition: 0 }, viewTask.projectId)
      .then(() => useToastStore.getState().addToast({ message: `Moved "${task.title}" to ${targetName}`, variant: 'success' }))
      .catch((error) => reportFailure('move', error));
  };

  const openHere = (initialEdit: boolean) => {
    if (onThisBoard) useSessionStore.getState().setDetailTaskId(taskId, { initialEdit });
    else onOpenOnBoard(viewTask);
  };

  // A workflow task gets the row too, as its task detail does. "Pause session"
  // stays the whole label, so it never reads as pausing the workflow.
  const laneRole = swimlanes.find((lane) => lane.id === task.swimlane_id)?.role ?? null;
  const sessionToggleRow = sessionToggleRowFor(displayKind, laneRole, task);

  return (
    <TaskContextMenu
      testId="workflow-card-menu"
      position={position}
      task={task}
      swimlanes={swimlanes}
      navigationItem={(
        <button
          type="button"
          onClick={() => { onOpenOnBoard(viewTask); onClose(); }}
          className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2 cursor-pointer"
          data-testid="workflow-card-menu-open-on-board"
        >
          <ExternalLink size={14} className="text-fg-faint" />
          Open on board
        </button>
      )}
      sessionToggle={sessionToggleRow ? {
        ...sessionToggleRow,
        onToggle: () => {
          void runSessionToggle({
            taskId,
            direction: sessionToggleRow.direction,
            projectId: viewTask.projectId,
            // A task of another board: drop that project's warm-switch snapshot,
            // which still holds the session pointer main just rewrote, as the
            // Agent Monitor's menu does.
            onSucceeded: onThisBoard
              ? () => { void useBoardStore.getState().loadBoard(); }
              : () => invalidateProject(viewTask.projectId),
          });
        },
      } : undefined}
      moveRefusal={(laneId) => boardMoveRefusal(workflow, task, swimlanes.find((lane) => lane.id === laneId))}
      // Every card here is in a started workflow, so Backlog and Archive are refused.
      sendAwayRefusal={sendAwayRefusal(workflow, task) ?? `Remove #${task.display_id} from its workflow first.`}
      onEdit={() => openHere(true)}
      onShowChanges={() => {
        // Keyed by task id, so safe for a task on any board.
        useSessionStore.getState().toggleChangesOpen(taskId);
        openHere(false);
      }}
      onMoveTo={moveTo}
      onSendToBacklog={() => undefined}
      onArchive={() => undefined}
      onDelete={() => onDelete(task, viewTask.projectId)}
      onClose={onClose}
    />
  );
}
