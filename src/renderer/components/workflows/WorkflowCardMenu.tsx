import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Swimlane, Task, WorkflowViewTask } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { describeIpcError, asSentence } from '../../lib/ipc-error';
import { boardMoveRefusal, boardWorkflowOf, sendAwayRefusal } from '../../utils/board-workflow';
import { findBoardTask } from '../../utils/board-task-index';
import { useTaskDisplayKind } from '../../utils/task-progress';
import { runSessionToggle, sessionToggleRowFor } from '../../utils/session-toggle';
import { toggleTaskAutomations } from '../../utils/task-automations';
import { openTaskFromNotification } from '../../utils/open-task-from-notification';
import { TaskContextMenu } from '../board/TaskContextMenu';
import { resyncBoardAfterMonitorWrite } from '../monitor/resync-board-after-monitor-write';

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
  // A click on a toast about the task opens it, on the task's own board.
  const openTask = () => openTaskFromNotification(viewTask.projectId, taskId);
  const reportMoved = (targetName: string) => {
    useToastStore.getState().addToast({
      title: 'Task moved',
      message: `"${task.title}" is now in ${targetName}.`,
      variant: 'success',
      onOpen: openTask,
    });
  };
  const reportMoveFailure = (error: unknown) => {
    useToastStore.getState().addToast({
      title: "Couldn't move task",
      message: `"${task.title}": ${asSentence(describeIpcError(error))}`,
      variant: 'warning',
      onOpen: openTask,
    });
  };

  const moveTo = (targetSwimlaneId: string) => {
    const targetName = swimlanes.find((lane) => lane.id === targetSwimlaneId)?.name ?? 'column';
    if (onThisBoard) {
      const { tasks, moveTask } = useBoardStore.getState();
      const position = tasks.filter((candidate) => candidate.swimlane_id === targetSwimlaneId).length;
      void moveTask({ taskId, targetSwimlaneId, targetPosition: position }, false, currentProjectId).then((result) => {
        if (result.ok && !useBoardStore.getState().pendingMoveConfirm) reportMoved(targetName);
      });
      return;
    }
    void window.electronAPI.tasks.move({ taskId, targetSwimlaneId, targetPosition: 0 }, viewTask.projectId)
      .then(() => reportMoved(targetName))
      .catch(reportMoveFailure)
      // Main sends no push for a move from this window, and a warm switch reads
      // that project's snapshot, so bring its board up to date as the Agent
      // Monitor's menu does. It runs however the move settles, because a move
      // can commit and then fail.
      .finally(() => resyncBoardAfterMonitorWrite(viewTask.projectId));
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
          // Main rewrites the task's session pointer, so bring the task's own
          // board up to date, as the Agent Monitor's menu does. It runs however
          // the toggle settles, because a pause clears the pointer before it
          // stops the agent, and the stop can still fail. Decided when the call
          // lands, not at the click: the user may have switched boards
          // meanwhile, and then the board to reload is the open one and the
          // snapshot to drop is the task's.
          void runSessionToggle({
            taskId,
            direction: sessionToggleRow.direction,
            projectId: viewTask.projectId,
          }).finally(() => resyncBoardAfterMonitorWrite(viewTask.projectId));
        },
      } : undefined}
      // Holds this task out of its workflow, or lets the workflow take it again.
      onToggleAutomations={() => { void toggleTaskAutomations(task, viewTask.projectId); }}
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
