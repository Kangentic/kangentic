/**
 * Right-click menu on a monitor row.
 *
 * This is the BOARD's `TaskContextMenu`, not a second menu. A monitor row is a
 * kanban card as far as the user is concerned, so it offers the same actions in
 * the same order - copy id, Edit, Show changes, Pause or Resume session, the
 * automations switch, Move to, Backlog, Archive, Delete - plus "Open on board" in the menu's
 * `navigationItem` slot. Rebuilding a thinner lookalike would guarantee the two
 * drift the first time an item is added. Delete and Backlog ask first with the
 * board card's own dialogs, under the same Don't ask again switch.
 *
 * What differs is only WHERE the actions land: every mutation carries the row's
 * own `projectId` (the monitor spans projects, so the open board is usually not
 * the right one), and the reads come from the per-project bundle rather than the
 * board store. Both are the same seams the monitor's task-detail host uses. The
 * board never sees those writes, so each one ends in
 * `resyncBoardAfterMonitorWrite`.
 *
 * The menu renders only once the bundle resolves, because `TaskContextMenu`
 * needs the real `Task` and that project's swimlanes for its Move-to list.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, SquareTerminal } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { MonitorSessionRow, Swimlane, Task } from '../../../shared/types';
import { TaskContextMenu } from '../board/TaskContextMenu';
import { DeleteTaskDialog } from '../board/DeleteTaskDialog';
import { SendToBacklogDialog } from '../board/SendToBacklogDialog';
import { useSessionStore } from '../../stores/session-store';
import { useMonitorStore } from '../../stores/monitor-store';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';
import { requestMonitorDetail } from './MonitorDetailLayer';
import { resyncBoardAfterMonitorWrite } from './resync-board-after-monitor-write';
import { sendToBacklogAsksFirst } from '../../utils/send-to-backlog-confirm';
import { toggleTaskAutomations } from '../../utils/task-automations';
import { describeIpcError, asSentence } from '../../lib/ipc-error';
import { useTaskDisplayKind } from '../../utils/task-progress';
import { runSessionToggle, sessionToggleRowFor } from '../../utils/session-toggle';
import { openTaskFromNotification } from '../../utils/open-task-from-notification';

interface MonitorRowContextMenuProps {
  row: MonitorSessionRow;
  position: { x: number; y: number };
  onOpenOnBoard: (row: MonitorSessionRow) => void;
  onClose: () => void;
}

/** A menu action that asks before it runs, as the board card's does. */
type PendingConfirm = 'delete' | 'backlog';

export function MonitorRowContextMenu({
  row,
  position,
  onOpenOnBoard,
  onClose,
}: MonitorRowContextMenuProps) {
  const { t } = useLingui();
  const [resolved, setResolved] = useState<{ task: Task; swimlanes: Swimlane[] } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // Read by the menu's own close, in the same click that set it: `TaskContextMenu`
  // runs `onDelete(); onClose();` back to back, before the state above re-renders.
  const pendingConfirmRef = useRef<PendingConfirm | null>(null);
  // The session store holds every project's sessions, so a row of another
  // project resolves its display kind the same way a board card does.
  const displayKind = useTaskDisplayKind(row.taskId);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.monitor?.getTaskDetail(row.projectId, row.taskId)
      .then((bundle) => {
        if (cancelled || !bundle) return;
        setResolved({ task: bundle.task, swimlanes: bundle.swimlanes });
      })
      .catch(() => { /* menu simply does not open; the row click still works */ });
    return () => { cancelled = true; };
  }, [row.projectId, row.taskId]);

  const refreshRows = (): void => { void useMonitorStore.getState().loadSnapshot(); };

  /** Surface a failed task mutation. These actions call the project-stamped IPC
   *  directly rather than through the board store, because the row's project may
   *  not be the open one - which also means they do not inherit the board slice's
   *  rollback-and-toast handling, so each one reports for itself. Without this the
   *  rejection reaches only the global `unhandledrejection` listener and the user
   *  sees an unchanged row with no explanation. The title names the action
   *  ("Couldn't move task"); a click on the card opens the task. */
  const reportActionFailure = (failureTitle: string, error: unknown): void => {
    const taskTitle = row.taskTitle;
    // Main's reason, as written.
    const reason = asSentence(describeIpcError(error));
    useToastStore.getState().addToast({
      title: failureTitle,
      message: t`"${taskTitle}": ${reason}`,
      variant: 'warning',
      onOpen: () => openTaskFromNotification(row.projectId, row.taskId),
    });
  };

  /** Run one write, then refresh the rows and bring the board up to date. The
   *  resync runs however the write settles: a move can commit and then fail,
   *  and the board must still learn the committed half. */
  const runWrite = (failureTitle: string, write: Promise<unknown>): void => {
    void write
      .then(refreshRows)
      .catch((error) => reportActionFailure(failureTitle, error))
      .finally(() => resyncBoardAfterMonitorWrite(row.projectId));
  };

  const deleteTask = (): void => {
    runWrite(t`Couldn't delete task`, window.electronAPI.tasks.delete(row.taskId, row.projectId));
  };

  const sendToBacklog = (): void => {
    runWrite(t`Couldn't send task to backlog`, window.electronAPI.backlog.demote({ taskId: row.taskId }, row.projectId));
  };

  const askFirst = (confirm: PendingConfirm): void => {
    pendingConfirmRef.current = confirm;
    setPendingConfirm(confirm);
  };

  /** The menu's own close. While a dialog is pending the menu only gives way to
   *  it; the host's `onClose` (which unmounts all of this) runs when the dialog
   *  settles. */
  const closeMenu = (): void => {
    if (pendingConfirmRef.current === null) onClose();
  };

  const settleConfirm = (dontAskAgain: boolean, run: (() => void) | null): void => {
    if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
    pendingConfirmRef.current = null;
    run?.();
    onClose();
  };

  const openOnBoard = (
    <button
      type="button"
      onClick={() => { onOpenOnBoard(row); onClose(); }}
      className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2 cursor-pointer"
      data-testid="monitor-menu-open-on-board"
    >
      {row.isCommandTerminal
        ? <SquareTerminal size={14} className="text-fg-faint" />
        : <ExternalLink size={14} className="text-fg-faint" />}
      {row.isCommandTerminal ? <Trans>Show in project</Trans> : <Trans>Open on board</Trans>}
    </button>
  );

  // A Command Terminal has no task, so the task actions below are meaningless for
  // it - only the navigation item applies. Rendering the full menu would offer Edit
  // and Delete for something that does not exist.
  if (row.isCommandTerminal) {
    return (
      <div
        className="fixed z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[200px] overlay-popover-in"
        style={{
          left: Math.min(position.x, window.innerWidth - 220),
          top: Math.min(position.y, window.innerHeight - 100),
          transformOrigin: 'top left',
        }}
        data-dismissable-layer
        data-testid="monitor-row-menu"
        onMouseLeave={onClose}
      >
        {openOnBoard}
      </div>
    );
  }

  if (!resolved) return null;

  // The board card's own dialogs, portaled to the body. Rendered in place they
  // would sit inside the monitor overlay's stacking context (z-42), under any
  // task detail window open in the monitor's own layer (z-43).
  if (pendingConfirm === 'delete') {
    return createPortal(
      <DeleteTaskDialog
        title={resolved.task.title}
        onConfirm={(dontAskAgain) => settleConfirm(dontAskAgain, deleteTask)}
        onCancel={() => settleConfirm(false, null)}
      />,
      document.body,
    );
  }
  if (pendingConfirm === 'backlog') {
    return createPortal(
      <SendToBacklogDialog
        title={resolved.task.title}
        onConfirm={(dontAskAgain) => settleConfirm(dontAskAgain, sendToBacklog)}
        onCancel={() => settleConfirm(false, null)}
      />,
      document.body,
    );
  }

  const laneRole = resolved.swimlanes.find((lane) => lane.id === resolved.task.swimlane_id)?.role ?? null;
  const sessionToggleRow = sessionToggleRowFor(displayKind, laneRole, resolved.task);

  return (
    <TaskContextMenu
      testId="monitor-row-menu"
      position={position}
      task={resolved.task}
      swimlanes={resolved.swimlanes}
      navigationItem={openOnBoard}
      onClose={closeMenu}
      // Stamped with the row's own project, then the rows and the board catch up
      // as after every other write here.
      sessionToggle={sessionToggleRow ? {
        ...sessionToggleRow,
        onToggle: () => {
          void runSessionToggle({
            taskId: row.taskId,
            direction: sessionToggleRow.direction,
            projectId: row.projectId,
            onSucceeded: refreshRows,
          }).finally(() => resyncBoardAfterMonitorWrite(row.projectId));
        },
      } : undefined}
      // Stamped with the row's own project (`toggleTaskAutomations` says where it
      // writes), then the rows catch up.
      onToggleAutomations={() => {
        void toggleTaskAutomations(resolved.task, row.projectId).then((landed) => {
          if (landed) refreshRows();
        });
      }}
      // Opens the detail HERE, in edit mode - the same destination a plain row
      // click uses, so the menu never teleports the user somewhere else.
      onEdit={() => requestMonitorDetail(row.projectId, row.taskId, { initialEdit: true })}
      onShowChanges={() => {
        // `changesOpenTasks` is keyed by taskId (a UUID), so this is safe to set
        // for a task in any project.
        useSessionStore.getState().toggleChangesOpen(row.taskId);
        requestMonitorDetail(row.projectId, row.taskId);
      }}
      onMoveTo={(targetSwimlaneId) => {
        runWrite(t`Couldn't move task`, window.electronAPI.tasks.move({ taskId: row.taskId, targetSwimlaneId, targetPosition: 0 }, row.projectId));
      }}
      // The board card's rule: ask unless the task holds nothing to clean up or
      // the user turned the question off.
      onSendToBacklog={() => {
        if (sendToBacklogAsksFirst(resolved.task, useConfigStore.getState().config.skipDeleteConfirm)) {
          askFirst('backlog');
          return;
        }
        sendToBacklog();
        onClose();
      }}
      onArchive={() => {
        const doneLane = resolved.swimlanes.find((lane) => lane.role === 'done');
        if (!doneLane) return;
        runWrite(t`Couldn't archive task`, window.electronAPI.tasks.move({ taskId: row.taskId, targetSwimlaneId: doneLane.id, targetPosition: 0 }, row.projectId));
      }}
      onDelete={() => {
        if (useConfigStore.getState().config.skipDeleteConfirm) {
          deleteTask();
          return;
        }
        askFirst('delete');
      }}
    />
  );
}
