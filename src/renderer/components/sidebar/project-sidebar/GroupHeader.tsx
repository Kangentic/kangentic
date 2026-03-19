import React, { useState, useRef, useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  ChevronDown, ChevronRight, Pencil, Trash2,
  ArrowUp, ArrowDown,
} from 'lucide-react';
import { Pill } from '../../Pill';
import type { ProjectGroup } from '../../../../shared/types';

export interface GroupHeaderProps {
  group: ProjectGroup;
  projectCount: number;
  isFirst: boolean;
  isLast: boolean;
  onToggleCollapsed: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (group: ProjectGroup) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

export function GroupHeader({
  group,
  projectCount,
  isFirst,
  isLast,
  onToggleCollapsed,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
}: GroupHeaderProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.id}` });
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSubmitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(group.id, trimmed);
    }
    setIsEditing(false);
  };

  const handleRowClick = (event: React.MouseEvent) => {
    if (isEditing) return;
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('[data-group-actions]')) return;
    onToggleCollapsed(group.id);
  };

  return (
    <div
      ref={setNodeRef}
      onClick={handleRowClick}
      className={`group flex items-center gap-1.5 px-3 py-2 border-l-2 border-t cursor-pointer bg-surface-hover/20 hover:bg-surface-hover/40 transition-colors ${
        isOver ? 'border-l-accent bg-accent/10 border-t-accent/50' : 'border-l-transparent border-t-edge/50'
      }`}
      data-testid={`project-group-${group.id}`}
    >
      {/* Chevron indicator */}
      <span className="flex-shrink-0 p-0.5 text-fg-muted">
        {group.is_collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </span>

      {isEditing ? (
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSubmitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmitRename();
            if (e.key === 'Escape') {
              setEditName(group.name);
              setIsEditing(false);
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

      <div data-group-actions className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onMoveUp(group.id)}
          disabled={isFirst}
          className="p-1.5 rounded-full text-fg-disabled hover:text-fg-tertiary hover:bg-edge-input/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move group up"
        >
          <ArrowUp size={16} />
        </button>
        <button
          onClick={() => onMoveDown(group.id)}
          disabled={isLast}
          className="p-1.5 rounded-full text-fg-disabled hover:text-fg-tertiary hover:bg-edge-input/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move group down"
        >
          <ArrowDown size={16} />
        </button>
        <button
          onClick={() => {
            setEditName(group.name);
            setIsEditing(true);
          }}
          className="p-1.5 rounded-full text-fg-disabled hover:text-fg-tertiary hover:bg-edge-input/50 transition-all"
          title="Rename group"
        >
          <Pencil size={16} />
        </button>
        <button
          onClick={() => onDelete(group)}
          className="p-1.5 rounded-full text-fg-disabled hover:text-red-400 hover:bg-red-400/10 transition-all"
          title="Delete group"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
