import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2, Inbox, Pencil, Archive, Copy, GitCompare, Workflow as WorkflowIcon } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import type { Task, Swimlane } from '../../../shared/types';
import { placeContextMenu, type MenuPlacement } from './context-menu-placement';
import { Tooltip } from '../Tooltip';

/**
 * Inline context menu shown on right-click of a task card. Offers
 * copy-id, edit, show-changes (if worktree exists), move-to (for
 * every non-archived non-ghost target lane), send-to-backlog,
 * archive, and delete.
 *
 * Positions itself at the click coordinates, then measures its rendered size
 * before paint and moves inside the window, 8px from each edge: a workflow
 * task's menu (its workflow rows plus every Move to row) is taller than any
 * fixed guess. A menu taller than the window scrolls. Closes on outside click
 * or Escape. The parent owns the `position` prop and the `onClose` callback.
 *
 * A row the task cannot take (a workflow's lock) stays in place, disabled,
 * with the reason as its tooltip: controls never come and go with state. The
 * whole row dims, its text, icon and dot together, as one unavailable item.
 */

const ROW_CLASS = 'w-full px-3 py-1.5 text-sm text-left flex items-center gap-2 text-fg-secondary';
const LIVE_ROW_CLASS = `${ROW_CLASS} hover:bg-surface-hover/40`;
const DISABLED_ROW_CLASS = `${ROW_CLASS} opacity-40 cursor-not-allowed`;

export function TaskContextMenu({
  position,
  task,
  swimlanes,
  onEdit,
  onShowChanges,
  onMoveTo,
  onSendToBacklog,
  onArchive,
  onDelete,
  onClose,
  leading,
  moveRefusal,
  sendAwayRefusal,
  onNewWorkflow,
  testId = 'task-context-menu',
}: {
  /** Root `data-testid`, so each host can address its own instance. */
  testId?: string;
  /** Extra item(s) above the copy-id row, with a divider after. The Agent Monitor
   *  puts "Open on board" here so it can reuse this whole menu rather than
   *  maintaining a second, thinner one that drifts from the board's. */
  leading?: React.ReactNode;
  position: { x: number; y: number };
  task: Task;
  swimlanes: Swimlane[];
  onEdit: () => void;
  onShowChanges: () => void;
  onMoveTo: (targetSwimlaneId: string) => void;
  onSendToBacklog: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Why a Move to row is refused (a workflow's lock); null leaves it live. */
  moveRefusal?: (targetSwimlaneId: string) => string | null;
  /** Why Backlog and Archive are refused: each would take the task out of its workflow. */
  sendAwayRefusal?: string | null;
  /** New workflow from this task, offered on a To Do card that is in no workflow. */
  onNewWorkflow?: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [onClose]);

  const moveTargets = swimlanes.filter(
    (lane) => lane.id !== task.swimlane_id && !lane.is_archived && !lane.is_ghost,
  );

  // The press point by value: `position` is a new object on each render of the host.
  const { x: pointerX, y: pointerY } = position;
  const [placement, setPlacement] = useState<MenuPlacement>({ left: pointerX, top: pointerY, maxHeight: undefined });
  // Measured before paint, so the menu never shows at the press point first.
  // `offset*` sizes, not the bounding rect: the entrance animation scales the
  // menu, and a rect read on mount would be the scaled-down size.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const borderHeight = menu.offsetHeight - menu.clientHeight;
    setPlacement(placeContextMenu(
      { x: pointerX, y: pointerY },
      { width: menu.offsetWidth, height: menu.scrollHeight + borderHeight },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [pointerX, pointerY]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[180px] overlay-popover-in"
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        overflowY: placement.maxHeight === undefined ? undefined : 'auto',
        transformOrigin: 'top left',
      }}
      data-dismissable-layer
      data-testid={testId}
    >
      {leading && (
        <>
          {leading}
          <div className="border-t border-edge my-1" />
        </>
      )}
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(`Task #${task.display_id}`);
          useToastStore.getState().addToast({ message: `Copied Task ID #${task.display_id}` });
          onClose();
        }}
        className="w-full px-3 py-1.5 text-sm font-mono text-fg-faint hover:text-fg-secondary transition-colors flex items-center gap-2 cursor-pointer"
        data-testid="context-copy-task-id"
      >
        <Copy size={14} />
        Task #{task.display_id}
      </button>
      <div className="border-t border-edge my-1" />
      <button
        type="button"
        onClick={() => { onEdit(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="context-edit-task"
      >
        <Pencil size={14} className="text-fg-faint" />
        Edit
      </button>

      {task.worktree_path && (
        <button
          type="button"
          onClick={() => { onShowChanges(); onClose(); }}
          className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
          data-testid="context-show-changes"
        >
          <GitCompare size={14} className="text-fg-faint" />
          Changes
        </button>
      )}

      {moveTargets.length > 0 && (
        <>
          <div className="border-t border-edge my-1" />
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Move to
          </div>
          {moveTargets.map((lane) => {
            const refusal = moveRefusal?.(lane.id) ?? null;
            return (
              <Tooltip key={lane.id} label={refusal ?? ''}>
                <button
                  type="button"
                  onClick={() => { if (refusal) return; onMoveTo(lane.id); onClose(); }}
                  aria-disabled={refusal ? true : undefined}
                  className={refusal ? DISABLED_ROW_CLASS : LIVE_ROW_CLASS}
                  data-testid="context-move-to"
                >
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: lane.color }}
                  />
                  {lane.name}
                </button>
              </Tooltip>
            );
          })}
        </>
      )}

      <div className="border-t border-edge my-1" />

      {onNewWorkflow && (
        <button
          type="button"
          onClick={() => { onNewWorkflow(); onClose(); }}
          className={LIVE_ROW_CLASS}
          data-testid="context-new-workflow"
        >
          <WorkflowIcon size={14} className="text-fg-faint" />
          New workflow
        </button>
      )}
      <Tooltip label={sendAwayRefusal ?? ''}>
        <button
          type="button"
          onClick={() => { if (sendAwayRefusal) return; onSendToBacklog(); }}
          aria-disabled={sendAwayRefusal ? true : undefined}
          className={sendAwayRefusal ? DISABLED_ROW_CLASS : LIVE_ROW_CLASS}
          data-testid="context-send-to-backlog"
        >
          <Inbox size={14} className="text-fg-faint" />
          Backlog
        </button>
      </Tooltip>
      <Tooltip label={sendAwayRefusal ?? ''}>
        <button
          type="button"
          onClick={() => { if (sendAwayRefusal) return; onArchive(); onClose(); }}
          aria-disabled={sendAwayRefusal ? true : undefined}
          className={sendAwayRefusal ? DISABLED_ROW_CLASS : LIVE_ROW_CLASS}
          data-testid="context-archive-task"
        >
          <Archive size={14} className="text-fg-faint" />
          Archive
        </button>
      </Tooltip>

      <button
        type="button"
        onClick={() => { onDelete(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-red-400 text-left hover:bg-red-400/10 flex items-center gap-2"
        data-testid="context-delete-task"
      >
        <Trash2 size={14} />
        Delete
      </button>
    </div>
  );
}
