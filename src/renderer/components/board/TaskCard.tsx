import React, { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Trash2 } from 'lucide-react';
import { TaskChangesDialog } from '../dialogs/TaskChangesDialog';
import { SendToBacklogDialog } from './SendToBacklogDialog';
import { sendToBacklogAsksFirst } from '../../utils/send-to-backlog-confirm';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import { taskDetailSurfaceFor } from '../../utils/task-progress';
import type { Task } from '../../../shared/types';
import { TaskContextMenu } from './TaskContextMenu';
import { ArchivedTaskContextMenu } from './ArchivedTaskContextMenu';
import { TaskCardBody, TaskCardCompactBody, taskCardFrameClass, useTaskCardViewModel } from './task-card-view';
import { WorkflowTaskCardBody } from './WorkflowTaskCardBody';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { RESTING_TRANSFORM } from './resting-transform';
import { OpenWorkflowMenuItem } from './workflow-menu-items';
import { useWorkflowStore } from '../../stores/workflow-store';
import { sendAwayRefusal, type BoardWorkflow } from '../../utils/board-workflow';
import { boardWorkflowNow, refusedBoardMove } from '../../utils/workflow-refusal';
import { automationsSwitchRefusal } from '../../../shared/automation-manifest';
import { describeIpcError } from '../../lib/ipc-error';
import { runSessionToggle, sessionToggleRowFor, type SessionToggleDirection } from '../../utils/session-toggle';

interface TaskCardProps {
  task: Task;
  isDragOverlay?: boolean;
  compact?: boolean;
  onDelete?: (taskId: string) => void;
}

/**
 * The board's card: a sortable root with the card menu and its dialogs around
 * the shared card content (`task-card-view.tsx`), which the Workflows canvas
 * draws too.
 */
const TaskCardInner = function TaskCard({ task, isDragOverlay, compact, onDelete }: TaskCardProps) {
  const view = useTaskCardViewModel(task);
  const { displayState } = view;
  const setDetailTaskId = useSessionStore((s) => s.setDetailTaskId);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: 'task' },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform) ?? RESTING_TRANSFORM,
    transition: transition || undefined,
    opacity: isDragging ? 0.4 : 1,
    contain: 'layout style paint',
  };

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmSendToBacklog, setConfirmSendToBacklog] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showChanges, setShowChanges] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    if (isDragOverlay) return;
    e.stopPropagation();
    // A task with nothing session-shaped to show opens straight into edit mode
    // (the window then starts in the edit form). The window-manager bridge
    // reads this intent. Decided by the SAME classifier the detail body paints
    // from, lane included, so the card and the window cannot disagree: a To Do
    // task edits whatever stale row the store may still hold for it (#661),
    // and a task whose window would show a terminal opens in view mode. The
    // lane is read at click time, like the other handlers below, rather than
    // subscribed: it costs nothing across a hundred memoized cards.
    const laneRole = useBoardStore.getState().swimlanes
      .find((lane) => lane.id === task.swimlane_id)?.role ?? null;
    setDetailTaskId(task.id, {
      initialEdit: taskDetailSurfaceFor(displayState.kind, laneRole) === 'inert' && !task.archived_at,
    });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isDragOverlay) return;
    // Compact cards normally have no menu, but archived compact cards
    // (DoneSwimlane preview list) get an archived-specific menu.
    if (compact && !task.archived_at) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleSendToBacklog = async () => {
    setContextMenu(null);
    setConfirmSendToBacklog(false);
    const taskTitle = task.title;
    await useBacklogStore.getState().demoteTask({ taskId: task.id });
    useToastStore.getState().addToast({
      message: `Sent "${taskTitle}" to backlog`,
      variant: 'info',
    });
  };

  const handleMoveTo = async (targetSwimlaneId: string) => {
    const { swimlanes: currentSwimlanes, tasks: currentTasks, moveTask } = useBoardStore.getState();
    const targetName = currentSwimlanes.find((lane) => lane.id === targetSwimlaneId)?.name ?? 'column';
    const laneTasks = currentTasks.filter(
      (boardTask) => boardTask.swimlane_id === targetSwimlaneId,
    );
    await moveTask({ taskId: task.id, targetSwimlaneId, targetPosition: laneTasks.length }, false, useProjectStore.getState().currentProject?.id ?? null);
    // If a confirmation dialog was triggered, moveTask returns early without
    // moving. Don't show a success toast in that case.
    if (useBoardStore.getState().pendingMoveConfirm) return;
    useToastStore.getState().addToast({
      message: `Moved "${task.title}" to ${targetName}`,
      variant: 'success',
    });
  };

  const handleArchive = async () => {
    const { swimlanes: currentSwimlanes, tasks: currentTasks, archiveTask } = useBoardStore.getState();
    const doneLane = currentSwimlanes.find((lane) => lane.role === 'done');
    if (!doneLane) return;
    const taskTitle = task.title;
    const taskId = task.id;
    archiveTask(taskId);
    const laneTasks = currentTasks.filter(
      (boardTask) => boardTask.swimlane_id === doneLane.id,
    );
    await window.electronAPI.tasks.move({ taskId, targetSwimlaneId: doneLane.id, targetPosition: laneTasks.length }, useProjectStore.getState().currentProject?.id ?? null);
    useToastStore.getState().addToast({
      message: `Archived "${taskTitle}"`,
      variant: 'info',
    });
  };

  const handleContextDelete = async (dontAskAgain: boolean) => {
    if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
    const session = useSessionStore.getState()._sessionByTaskId.get(task.id);
    if (session) {
      await useSessionStore.getState().killSession(session.id);
    }
    await useBoardStore.getState().deleteTask(task.id);
    setConfirmDelete(false);
  };

  // The menu's workflow and lane facts, read when it opens rather than
  // subscribed: an ordinary card pays nothing, and an open menu is a moment, not
  // a view. The session row reads the display kind the card already holds.
  const menuWorkflow = contextMenu && task.workflow_id ? boardWorkflowNow(task) : null;
  const menuLaneRole = contextMenu
    ? useBoardStore.getState().swimlanes.find((lane) => lane.id === task.swimlane_id)?.role ?? null
    : null;
  const offersNewWorkflow = !!contextMenu && !task.workflow_id && !task.archived_at && menuLaneRole === 'todo';
  const menuSessionToggle = contextMenu ? sessionToggleRowFor(displayState.kind, menuLaneRole, task) : null;

  const openTaskWorkflow = (workflow: BoardWorkflow) => {
    useBoardStore.getState().setActiveView('workflows');
    useWorkflowStore.getState().openWorkflow(workflow.homeProjectId, workflow.workflowId, task.id);
  };

  // The card's strip appears or clears as the update lands. A refusal (only a
  // workflow task, which never offers the row) or a lost write says why.
  const handleToggleAutomations = () => {
    const disable = !task.automations_disabled;
    useBoardStore.getState().updateTask({ id: task.id, automations_disabled: disable }).catch((error: unknown) => {
      useToastStore.getState().addToast({
        message: `Could not ${disable ? 'disable' : 'enable'} automations for "${task.title}": ${describeIpcError(error)}`,
        variant: 'warning',
      });
    });
  };

  // No window to close: the card's status bar shows the pause through the
  // store's optimistic write, and the board reload picks up the task row main
  // rewrote (its session pointer), as the task detail's board host does.
  const handleToggleSession = (direction: SessionToggleDirection) => {
    void runSessionToggle({
      taskId: task.id,
      direction,
      projectId: useProjectStore.getState().currentProject?.id ?? null,
      onSucceeded: () => { void useBoardStore.getState().loadBoard(); },
    });
  };

  const handleNewWorkflow = async () => {
    const created = await useWorkflowStore.getState().createWorkflow(task.id);
    if (created) useBoardStore.getState().setActiveView('workflows');
  };

  if (compact) {
    return (
      <>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          data-task-id={task.id}
          className={`bg-surface-raised/60 border border-edge/50 rounded-md px-2.5 py-1.5 cursor-grab active:cursor-grabbing select-none hover:border-edge-input transition-colors group/card ${
            isDragOverlay ? 'shadow-xl' : ''
          }`}
        >
          <TaskCardCompactBody
            task={task}
            view={view}
            trailing={onDelete && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
                className="p-2 rounded-full text-fg-disabled hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover/card:opacity-100 transition-all flex-shrink-0"
              >
                <Trash2 size={14} />
              </button>
            )}
          />
        </div>

        {contextMenu && task.archived_at && (
          <ArchivedTaskContextMenu
            position={contextMenu}
            task={task}
            swimlanes={useBoardStore.getState().swimlanes}
            onOpen={() => setDetailTaskId(task.id)}
            onShowChanges={() => setShowChanges(true)}
            onRestoreTo={(targetSwimlaneId) => {
              useBoardStore.getState().unarchiveTask({ id: task.id, targetSwimlaneId });
            }}
            onDelete={() => {
              if (onDelete) onDelete(task.id);
            }}
            onClose={() => setContextMenu(null)}
          />
        )}

        {showChanges && (
          <TaskChangesDialog task={task} onClose={() => setShowChanges(false)} />
        )}
      </>
    );
  }

  const boardDensity = view.cardDensity;

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        data-task-id={task.id}
        className={`${taskCardFrameClass(view, boardDensity)} cursor-grab active:cursor-grabbing select-none transition-colors ${isDragOverlay ? 'shadow-xl' : ''}`}
      >
        {task.workflow_id
          // The drag overlay and the flying card are copies: their strip shows, and does nothing.
          ? <WorkflowTaskCardBody task={task} view={view} density={boardDensity} interactive={!isDragOverlay} />
          : <TaskCardBody task={task} view={view} density={boardDensity} />}
      </div>

      {contextMenu && (
        <TaskContextMenu
          position={contextMenu}
          task={task}
          swimlanes={useBoardStore.getState().swimlanes}
          navigationItem={menuWorkflow && (
            <OpenWorkflowMenuItem workflow={menuWorkflow} onOpen={() => openTaskWorkflow(menuWorkflow)} onClose={() => setContextMenu(null)} />
          )}
          onToggleAutomations={automationsSwitchRefusal(task) === null ? handleToggleAutomations : undefined}
          sessionToggle={menuSessionToggle
            ? { ...menuSessionToggle, onToggle: () => handleToggleSession(menuSessionToggle.direction) }
            : undefined}
          moveRefusal={menuWorkflow ? (laneId) => refusedBoardMove(task, laneId, useBoardStore.getState().swimlanes) : undefined}
          sendAwayRefusal={sendAwayRefusal(menuWorkflow, task)}
          onNewWorkflow={offersNewWorkflow ? handleNewWorkflow : undefined}
          onEdit={() => setDetailTaskId(task.id, { initialEdit: true })}
          onShowChanges={() => setShowChanges(true)}
          onMoveTo={handleMoveTo}
          onSendToBacklog={() => {
            setContextMenu(null);
            if (sendToBacklogAsksFirst(task, useConfigStore.getState().config.skipDeleteConfirm)) {
              setConfirmSendToBacklog(true);
            } else {
              handleSendToBacklog();
            }
          }}
          onArchive={handleArchive}
          onDelete={() => {
            setContextMenu(null);
            const skipConfirm = useConfigStore.getState().config.skipDeleteConfirm;
            if (skipConfirm) {
              handleContextDelete(false);
            } else {
              setConfirmDelete(true);
            }
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {showChanges && (
        <TaskChangesDialog task={task} onClose={() => setShowChanges(false)} />
      )}

      {confirmSendToBacklog && (
        <SendToBacklogDialog
          title={task.title}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
            handleSendToBacklog();
          }}
          onCancel={() => setConfirmSendToBacklog(false)}
        />
      )}

      {confirmDelete && (
        <DeleteTaskDialog title={task.title} onConfirm={handleContextDelete} onCancel={() => setConfirmDelete(false)} />
      )}
    </>
  );
};

export const TaskCard = React.memo(TaskCardInner);
