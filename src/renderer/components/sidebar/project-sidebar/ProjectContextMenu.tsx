import React, { useRef, useEffect } from 'react';
import { FolderTree, Folder } from 'lucide-react';
import type { Project, ProjectGroup } from '../../../../shared/types';

export interface ProjectContextMenuProps {
  position: { x: number; y: number };
  project: Project;
  groups: ProjectGroup[];
  onMoveToGroup: (projectId: string, groupId: string) => void;
  onRemoveFromGroup: (projectId: string) => void;
  onClose: () => void;
}

export function ProjectContextMenu({
  position,
  project,
  groups,
  onMoveToGroup,
  onRemoveFromGroup,
  onClose,
}: ProjectContextMenuProps) {
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

  const availableGroups = groups.filter((group) => group.id !== project.group_id);
  const isGrouped = !!project.group_id;

  if (availableGroups.length === 0 && !isGrouped) return null;

  return (
    <div
      ref={containerRef}
      className="fixed bg-surface-raised border border-edge rounded-md shadow-lg z-50 py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
    >
      {availableGroups.length > 0 && (
        <>
          <div className="px-3 py-1 text-xs text-fg-disabled">Move to</div>
          {availableGroups.map((group) => (
            <button
              key={group.id}
              onClick={() => {
                onMoveToGroup(project.id, group.id);
                onClose();
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors text-left"
            >
              <FolderTree size={14} className="text-fg-faint" />
              {group.name}
            </button>
          ))}
        </>
      )}
      {isGrouped && (
        <>
          {availableGroups.length > 0 && <div className="border-t border-edge my-1" />}
          <button
            onClick={() => {
              onRemoveFromGroup(project.id);
              onClose();
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors text-left"
          >
            <Folder size={14} className="text-fg-faint" />
            Remove from group
          </button>
        </>
      )}
    </div>
  );
}
