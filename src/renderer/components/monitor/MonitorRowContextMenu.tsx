/**
 * Right-click menu on a monitor row.
 *
 * This is the BOARD's `TaskContextMenu`, not a second menu. A monitor row is a
 * kanban card as far as the user is concerned, so it offers the same actions in
 * the same order - copy id, Edit, Changes, Move to, Backlog, Archive, Delete -
 * plus "Open on board" in the menu's `leading` slot. Rebuilding a thinner
 * lookalike would guarantee the two drift the first time an item is added.
 *
 * What differs is only WHERE the actions land: every mutation carries the row's
 * own `projectId` (the monitor spans projects, so the open board is usually not
 * the right one), and the reads come from the per-project bundle rather than the
 * board store. Both are the same seams the monitor's task-detail host uses.
 *
 * The menu renders only once the bundle resolves, because `TaskContextMenu`
 * needs the real `Task` and that project's swimlanes for its Move-to list.
 */

import { useEffect, useState } from 'react';
import { ExternalLink, SquareTerminal } from 'lucide-react';
import type { MonitorSessionRow, Swimlane, Task } from '../../../shared/types';
import { TaskContextMenu } from '../board/TaskContextMenu';
import { useSessionStore } from '../../stores/session-store';
import { useMonitorStore } from '../../stores/monitor-store';
import { useToastStore } from '../../stores/toast-store';
import { requestMonitorDetail } from './MonitorDetailLayer';

interface MonitorRowContextMenuProps {
  row: MonitorSessionRow;
  position: { x: number; y: number };
  onOpenOnBoard: (row: MonitorSessionRow) => void;
  onClose: () => void;
}

export function MonitorRowContextMenu({
  row,
  position,
  onOpenOnBoard,
  onClose,
}: MonitorRowContextMenuProps) {
  const [resolved, setResolved] = useState<{ task: Task; swimlanes: Swimlane[] } | null>(null);

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
      {row.isCommandTerminal ? 'Show in project' : 'Open on board'}
    </button>
  );

  // A Command Terminal has no task, so the task actions below are meaningless for
  // it - only the leading item applies. Rendering the full menu would offer Edit
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

  return (
    <TaskContextMenu
      testId="monitor-row-menu"
      position={position}
      task={resolved.task}
      swimlanes={resolved.swimlanes}
      leading={openOnBoard}
      onClose={onClose}
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
        void window.electronAPI.tasks
          .move({ taskId: row.taskId, targetSwimlaneId, targetPosition: 0 }, row.projectId)
          .then(refreshRows)
          .catch((error) => {
            useToastStore.getState().addToast({
              message: `Failed to move "${row.taskTitle}": ${error instanceof Error ? error.message : 'Unknown error'}`,
              variant: 'warning',
            });
          });
      }}
      onSendToBacklog={() => {
        void window.electronAPI.tasks.delete(row.taskId, row.projectId).then(refreshRows);
      }}
      onArchive={() => {
        const doneLane = resolved.swimlanes.find((lane) => lane.role === 'done');
        if (!doneLane) return;
        void window.electronAPI.tasks
          .move({ taskId: row.taskId, targetSwimlaneId: doneLane.id, targetPosition: 0 }, row.projectId)
          .then(refreshRows);
      }}
      onDelete={() => {
        void window.electronAPI.tasks.delete(row.taskId, row.projectId).then(refreshRows);
      }}
    />
  );
}
