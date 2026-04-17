import React, { useState, useRef, useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Pill } from '../../Pill';
import type { ProjectGroup } from '../../../../shared/types';

export interface GroupHeaderProps {
  group: ProjectGroup;
  projectCount: number;
  isRenaming: boolean;
  onToggleCollapsed: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onContextMenu: (event: React.MouseEvent, group: ProjectGroup) => void;
  onCancelRename: () => void;
}

export function GroupHeader({
  group,
  projectCount,
  isRenaming,
  onToggleCollapsed,
  onRename,
  onContextMenu,
  onCancelRename,
}: GroupHeaderProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.id}` });
  const [editName, setEditName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      setEditName(group.name);
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming, group.name]);

  const handleSubmitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(group.id, trimmed);
    } else {
      onCancelRename();
    }
  };

  const handleRowClick = (event: React.MouseEvent) => {
    if (isRenaming) return;
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-group-actions]')) return;
    onToggleCollapsed(group.id);
  };

  return (
    <div
      ref={setNodeRef}
      onClick={handleRowClick}
      onContextMenu={(event) => onContextMenu(event, group)}
      data-testid={`project-group-${group.id}`}
      className={`group flex items-center gap-1.5 px-3 py-2 border-l-2 border-t cursor-pointer bg-surface-hover/20 hover:bg-surface-hover/40 transition-colors ${
        isOver ? 'border-l-accent bg-accent/10 border-t-accent/50' : 'border-l-transparent border-t-edge/50'
      }`}
    >
      {/* Chevron indicator */}
      <span className="flex-shrink-0 p-0.5 text-fg-muted">
        {group.is_collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </span>

      {isRenaming ? (
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSubmitRename}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') handleSubmitRename();
            if (e.key === 'Escape') {
              setEditName(group.name);
              onCancelRename();
            }
          }}
          className="flex-1 min-w-0 text-xs font-semibold uppercase tracking-wider bg-transparent border-b border-accent text-fg outline-none px-0.5"
        />
      ) : (
        <span
          className="flex-1 min-w-0 text-xs font-semibold uppercase tracking-wider text-fg-muted truncate select-none"
        >
          {group.name}
          {group.is_collapsed && (
            <Pill size="sm" as="span" className="ml-1.5 align-middle bg-surface-hover text-[11px] text-fg-faint font-normal normal-case tracking-normal">
              {projectCount} {projectCount === 1 ? 'project' : 'projects'}
            </Pill>
          )}
        </span>
      )}

      <button
        type="button"
        data-group-actions
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onContextMenu(e, group);
        }}
        className="flex-shrink-0 p-1 rounded text-fg-disabled hover:text-fg-muted hover:bg-surface-hover/60 transition-[opacity,color,background-color] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        title="Group options (or right-click)"
        data-testid={`group-menu-${group.id}`}
        aria-label={`Open menu for group ${group.name}`}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}
