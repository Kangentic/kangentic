import React, { useState, useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MoreHorizontal } from 'lucide-react';
import { SidebarActivityCounts } from './SidebarActivityCounts';
import type { Project } from '../../../../shared/types';

export interface ProjectListItemProps {
  project: Project;
  isActive: boolean;
  isRenaming: boolean;
  thinkingCount: number;
  idleCount: number;
  isGrouped: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, project: Project) => void;
  onRename: (id: string, name: string) => void;
  onCancelRename: () => void;
}

export function ProjectListItem({
  project,
  isActive,
  isRenaming,
  thinkingCount,
  idleCount,
  isGrouped,
  onSelect,
  onContextMenu,
  onRename,
  onCancelRename,
}: ProjectListItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const [editName, setEditName] = useState(project.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      setEditName(project.name);
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming, project.name]);

  const handleSubmitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== project.name) {
      onRename(project.id, trimmed);
    } else {
      onCancelRename();
    }
  };

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  const activityLabel = thinkingCount > 0 || idleCount > 0
    ? `${thinkingCount} thinking, ${idleCount} idle`
    : null;
  const rowTitle = [
    project.path,
    activityLabel,
    'Right-click for options',
  ].filter(Boolean).join('\n');

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(project.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(project.id); }}
      onContextMenu={(e) => onContextMenu(e, project)}
      title={rowTitle}
      data-testid={`project-row-${project.id}`}
      className={`group w-full text-left py-2.5 text-sm transition-colors border-l-2 cursor-pointer outline-none px-3 ${
        isGrouped ? 'pl-7' : ''
      } ${
        isActive
          ? 'border-accent bg-surface-hover text-fg'
          : 'border-transparent text-fg-muted hover:bg-surface-hover/50 hover:text-fg-secondary'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleSubmitRename}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') handleSubmitRename();
              if (e.key === 'Escape') {
                setEditName(project.name);
                onCancelRename();
              }
            }}
            className="flex-1 min-w-0 text-sm font-medium bg-transparent border-b border-accent text-fg outline-none px-0.5"
          />
        ) : (
          <span className="truncate font-medium flex-1 min-w-0">{project.name}</span>
        )}
        <SidebarActivityCounts thinkingCount={thinkingCount} idleCount={idleCount} />
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(e, project);
          }}
          className={`flex-shrink-0 p-1 rounded transition-[opacity,color,background-color] outline-none ${
            isActive
              ? 'opacity-100 text-fg-muted hover:text-fg hover:bg-surface-hover'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/60'
          }`}
          title="More options (or right-click row)"
          data-testid={`project-menu-${project.id}`}
          aria-label={`Open menu for ${project.name}`}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}
