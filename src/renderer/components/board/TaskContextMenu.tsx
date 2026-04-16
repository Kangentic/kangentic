import React, { useEffect, useRef } from 'react';
import { Trash2, Inbox, Pencil, Archive, Copy, GitCompare } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';
import type { Task, Swimlane } from '../../../shared/types';

/**
 * Inline context menu shown on right-click of a task card. Offers
 * copy-id, edit, show-changes (if worktree exists), move-to (for
 * every non-archived non-ghost target lane), send-to-backlog,
 * archive, and delete.
 *
 * Positions itself at the click coordinates, clamped to stay fully
 * visible in the viewport. Closes on outside click or Escape. The
 * parent owns the `position` prop and the `onClose` callback.
 */
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
}: {
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

  const menuStyle: React.CSSProperties = {
    left: Math.min(position.x, window.innerWidth - 200),
    top: Math.min(position.y, window.innerHeight - 300),
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[180px]"
      style={menuStyle}
    >
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
          {moveTargets.map((lane) => (
            <button
              key={lane.id}
              type="button"
              onClick={() => { onMoveTo(lane.id); onClose(); }}
              className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
              data-testid="context-move-to"
            >
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: lane.color }}
              />
              {lane.name}
            </button>
          ))}
        </>
      )}

      <div className="border-t border-edge my-1" />

      <button
        type="button"
        onClick={() => { onSendToBacklog(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="context-send-to-backlog"
      >
        <Inbox size={14} className="text-fg-faint" />
        Backlog
      </button>
      <button
        type="button"
        onClick={() => { onArchive(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="context-archive-task"
      >
        <Archive size={14} className="text-fg-faint" />
        Archive
      </button>

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
