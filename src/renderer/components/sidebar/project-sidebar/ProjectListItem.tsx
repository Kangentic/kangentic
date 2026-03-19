import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Trash2, GripVertical, Folder, FolderOpen,
  Loader2, Mail, Settings,
} from 'lucide-react';
import type { Project } from '../../../../shared/types';

/** Show last 3 path segments, e.g. "Users/dev/my-project" */
export function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/');
  return '.../' + parts.slice(-3).join('/');
}

export interface ProjectListItemProps {
  project: Project;
  isActive: boolean;
  thinkingCount: number;
  idleCount: number;
  isGrouped: boolean;
  onSelect: (id: string) => void;
  onOpenSettings: (e: React.MouseEvent, project: Project) => void;
  onOpenInExplorer: (e: React.MouseEvent, project: Project) => void;
  onDeleteClick: (e: React.MouseEvent, project: Project) => void;
  onContextMenu: (e: React.MouseEvent, project: Project) => void;
}

export function ProjectListItem({
  project,
  isActive,
  thinkingCount,
  idleCount,
  isGrouped,
  onSelect,
  onOpenSettings,
  onOpenInExplorer,
  onDeleteClick,
  onContextMenu,
}: ProjectListItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    opacity: isDragging ? 0.4 : 1,
  };

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
      className={`group w-full text-left py-2 text-sm transition-colors border-l-2 cursor-pointer outline-none px-3 ${
        isGrouped ? 'pl-7' : ''
      } ${
        isActive
          ? 'border-accent bg-surface-hover text-fg'
          : 'border-transparent text-fg-muted hover:bg-surface-hover/50 hover:text-fg-secondary'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="flex-shrink-0">
            <Folder size={16} className={`${isActive ? 'text-accent-fg' : 'text-fg-faint'} group-hover:hidden`} />
            <GripVertical size={16} className={`${isActive ? 'text-accent-fg' : 'text-fg-faint'} hidden group-hover:block cursor-grab`} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{project.name}</span>
              {idleCount > 0 && (
                <span
                  className="flex items-center gap-1 text-xs tabular-nums flex-shrink-0 text-amber-400"
                  title={`${idleCount} idle. Needs attention`}
                >
                  <Mail size={12} />
                  {idleCount}
                </span>
              )}
              {thinkingCount > 0 && (
                <span
                  className="flex items-center gap-1 text-xs tabular-nums text-green-400 flex-shrink-0"
                  title={`${thinkingCount} thinking`}
                >
                  <Loader2 size={12} className="animate-spin" />
                  {thinkingCount}
                </span>
              )}
            </div>
            <div
              className="truncate text-xs text-fg-faint mt-0.5"
              title={project.path}
            >
              {shortenPath(project.path)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={(e) => onOpenInExplorer(e, project)}
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-fg-disabled hover:text-fg-tertiary hover:bg-edge-input/50 transition-all"
            title="Open in file explorer"
          >
            <FolderOpen size={16} />
          </button>
          <button
            onClick={(e) => onOpenSettings(e, project)}
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-fg-disabled hover:text-fg-tertiary hover:bg-edge-input/50 transition-all"
            title="Project settings"
            data-testid={`project-settings-${project.id}`}
          >
            <Settings size={16} />
          </button>
          <button
            onClick={(e) => onDeleteClick(e, project)}
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-fg-disabled hover:text-red-400 hover:bg-red-400/10 transition-all"
            title="Delete project"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
