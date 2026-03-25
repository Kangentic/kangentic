import React, { useRef, useEffect } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { Swimlane } from '../../../shared/types';

interface BacklogContextMenuProps {
  position: { x: number; y: number };
  swimlanes: Swimlane[];
  onMoveToBoard: (swimlaneId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function BacklogContextMenu({
  position,
  swimlanes,
  onMoveToBoard,
  onEdit,
  onDelete,
  onClose,
}: BacklogContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [onClose]);

  const targets = swimlanes.filter(
    (lane) => lane.role !== 'done' && !lane.is_archived && !lane.is_ghost,
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
      {/* Move to Board submenu */}
      {targets.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Move to Board
          </div>
          {targets.map((lane) => (
            <button
              key={lane.id}
              type="button"
              onClick={() => { onMoveToBoard(lane.id); onClose(); }}
              className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
              data-testid="context-move-to-board"
            >
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: lane.color }}
              />
              {lane.name}
            </button>
          ))}
          <div className="border-t border-edge my-1" />
        </>
      )}

      <button
        type="button"
        onClick={() => { onEdit(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="context-edit-item"
      >
        <Pencil size={14} className="text-fg-faint" />
        Edit
      </button>

      <div className="border-t border-edge my-1" />

      <button
        type="button"
        onClick={() => { onDelete(); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-red-400 text-left hover:bg-red-400/10 flex items-center gap-2"
        data-testid="context-delete-item"
      >
        <Trash2 size={14} />
        Delete
      </button>
    </div>
  );
}
