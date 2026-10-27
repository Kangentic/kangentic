import React, { useEffect, useRef } from 'react';
import { Trash2, FolderOpen, Copy, GitCompare, RotateCcw, MessageSquare } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useToastStore } from '../../stores/toast-store';
import type { Task, Swimlane } from '../../../shared/types';

/**
 * Inline context menu shown on right-click of an archived task card, in the
 * Done lane preview and in the Completed Tasks dialog. Offers copy-id, open
 * (read-only detail), view conversation and show changes (the detail on its
 * Conversation or Changes tab, which read the task's sessions and commits, so
 * they need no worktree), restore-to (for every non-Done non-archived non-ghost
 * target lane), and delete (the host confirms first).
 *
 * Positions itself at the click coordinates, clamped to stay fully
 * visible in the viewport. Closes on outside click or Escape.
 */
export function ArchivedTaskContextMenu({
  position,
  task,
  swimlanes,
  onOpen,
  onViewConversation,
  onShowChanges,
  onRestoreTo,
  onDelete,
  onClose,
}: {
  position: { x: number; y: number };
  task: Task;
  swimlanes: Swimlane[];
  onOpen: () => void;
  onViewConversation: () => void;
  onShowChanges: () => void;
  onRestoreTo: (targetSwimlaneId: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const menuRef = useRef<HTMLDivElement>(null);
  const displayId = task.display_id;

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

  const restoreTargets = swimlanes.filter(
    (lane) => lane.role !== 'done' && !lane.is_archived && !lane.is_ghost,
  );

  const menuStyle: React.CSSProperties = {
    left: Math.min(position.x, window.innerWidth - 200),
    top: Math.min(position.y, window.innerHeight - 300),
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[180px] overlay-popover-in"
      style={{ ...menuStyle, transformOrigin: 'top left' }}
      data-dismissable-layer
    >
      <button
        type="button"
        onClick={() => {
          // The copied text stays English: it is pasted as an identifier, not read as UI.
          navigator.clipboard.writeText(`Task #${task.display_id}`);
          useToastStore.getState().addToast({ title: t`Task ID copied`, message: `#${task.display_id}`, variant: 'info' });
          onClose();
        }}
        className="w-full px-3 py-1.5 text-sm font-mono text-fg-faint hover:text-fg-secondary transition-colors flex items-center gap-2 cursor-pointer"
        data-testid="archived-context-copy-task-id"
      >
        <Copy size={14} />
        <Trans>Task #{displayId}</Trans>
      </button>
      <div className="border-t border-edge my-1" />
      <button
        type="button"
        onClick={() => { onOpen(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="archived-context-open-task"
      >
        <FolderOpen size={14} className="text-fg-faint" />
        <Trans context="Action">Open</Trans>
      </button>
      <button
        type="button"
        onClick={() => { onViewConversation(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="archived-context-view-conversation"
      >
        <MessageSquare size={14} className="text-fg-faint" />
        <Trans>View conversation</Trans>
      </button>

      <button
        type="button"
        onClick={() => { onShowChanges(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="archived-context-show-changes"
      >
        <GitCompare size={14} className="text-fg-faint" />
        <Trans>Show changes</Trans>
      </button>

      {restoreTargets.length > 0 && (
        <>
          <div className="border-t border-edge my-1" />
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint flex items-center gap-1.5">
            <RotateCcw size={11} />
            <Trans>Restore to</Trans>
          </div>
          {restoreTargets.map((lane) => (
            <button
              key={lane.id}
              type="button"
              onClick={() => { onRestoreTo(lane.id); onClose(); }}
              className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
              data-testid="archived-context-restore-to"
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
        onClick={() => { onDelete(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-red-400 text-left hover:bg-red-400/10 flex items-center gap-2"
        data-testid="archived-context-delete-task"
      >
        <Trash2 size={14} />
        <Trans>Delete</Trans>
      </button>
    </div>
  );
}
