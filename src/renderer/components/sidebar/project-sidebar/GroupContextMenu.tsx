import { useRef, useEffect } from 'react';
import { Pencil, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import type { ProjectGroup } from '../../../../shared/types';

export interface GroupContextMenuProps {
  position: { x: number; y: number };
  group: ProjectGroup;
  isFirst: boolean;
  isLast: boolean;
  onRename: (group: ProjectGroup) => void;
  onMoveUp: (group: ProjectGroup) => void;
  onMoveDown: (group: ProjectGroup) => void;
  onDelete: (group: ProjectGroup) => void;
  onClose: () => void;
}

export function GroupContextMenu({
  position,
  group,
  isFirst,
  isLast,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
  onClose,
}: GroupContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const menuStyle: React.CSSProperties = {
    left: Math.min(position.x, window.innerWidth - 200),
    top: Math.min(position.y, window.innerHeight - 220),
  };

  return (
    <div
      ref={containerRef}
      className="fixed bg-surface-raised border border-edge rounded-md shadow-lg z-50 py-1 min-w-[160px]"
      style={menuStyle}
    >
      <button
        onClick={() => {
          onRename(group);
          onClose();
        }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors text-left"
      >
        <Pencil size={14} className="text-fg-faint" />
        Rename
      </button>

      <button
        onClick={() => {
          if (isFirst) return;
          onMoveUp(group);
          onClose();
        }}
        disabled={isFirst}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <ArrowUp size={14} className="text-fg-faint" />
        Move up
      </button>

      <button
        onClick={() => {
          if (isLast) return;
          onMoveDown(group);
          onClose();
        }}
        disabled={isLast}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <ArrowDown size={14} className="text-fg-faint" />
        Move down
      </button>

      <div className="border-t border-edge my-1" />

      <button
        onClick={() => {
          onDelete(group);
          onClose();
        }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-400 hover:bg-red-400/10 transition-colors text-left"
      >
        <Trash2 size={14} />
        Delete
      </button>
    </div>
  );
}
