import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import {
  Folder, ChevronsLeft, FolderPlus, FolderTree, Search, X,
} from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { CountBadge } from '../CountBadge';
import type { Project, ProjectGroup } from '../../../shared/types';
import {
  ProjectListItem,
  GroupHeader,
  ProjectContextMenu,
  GroupContextMenu,
  useSidebarDragDrop,
} from './project-sidebar';

// ─── Main Sidebar ──────────────────────────────────────────────

interface ProjectSidebarProps {
  onToggleSidebar?: () => void;
}

export function ProjectSidebar({ onToggleSidebar }: ProjectSidebarProps) {
  const projects = useProjectStore((s) => s.projects);
  const groups = useProjectStore((s) => s.groups);
  const currentProject = useProjectStore((s) => s.currentProject);
  const openProject = useProjectStore((s) => s.openProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const setProjectGroup = useProjectStore((s) => s.setProjectGroup);
  const createGroup = useProjectStore((s) => s.createGroup);
  const updateGroup = useProjectStore((s) => s.updateGroup);
  const deleteGroup = useProjectStore((s) => s.deleteGroup);
  const reorderGroups = useProjectStore((s) => s.reorderGroups);
  const toggleGroupCollapsed = useProjectStore((s) => s.toggleGroupCollapsed);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionActivity = useSessionStore((s) => s.sessionActivity);
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
  const openProjectByPath = useProjectStore((s) => s.openProjectByPath);

  const renameProject = useProjectStore((s) => s.renameProject);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<ProjectGroup | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const newGroupInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; project: Project } | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<{ position: { x: number; y: number }; group: ProjectGroup } | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const {
    sensors,
    collisionDetection,
    sortableIds,
    sortedGroups,
    groupedProjectsMap,
    ungroupedProjects,
    activeId,
    handleDragStart,
    handleDragEnd,
  } = useSidebarDragDrop(projects, groups, reorderProjects, setProjectGroup);

  const searchTerm = search.trim().toLowerCase();
  const isSearching = searchTerm.length > 0;

  const { filteredGroupedProjects, filteredUngroupedProjects, filteredSortableIds } = useMemo(() => {
    if (!isSearching) {
      return {
        filteredGroupedProjects: groupedProjectsMap,
        filteredUngroupedProjects: ungroupedProjects,
        filteredSortableIds: sortableIds,
      };
    }
    const match = (project: Project) =>
      project.name.toLowerCase().includes(searchTerm) ||
      project.path.toLowerCase().includes(searchTerm);

    const groupedFiltered = new Map<string, Project[]>();
    groupedProjectsMap.forEach((projectList, groupId) => {
      const kept = projectList.filter(match);
      if (kept.length > 0) groupedFiltered.set(groupId, kept);
    });
    const ungroupedFiltered = ungroupedProjects.filter(match);
    const keptIds = new Set<string>();
    groupedFiltered.forEach((projectList) => projectList.forEach((project) => keptIds.add(project.id)));
    ungroupedFiltered.forEach((project) => keptIds.add(project.id));

    return {
      filteredGroupedProjects: groupedFiltered,
      filteredUngroupedProjects: ungroupedFiltered,
      filteredSortableIds: sortableIds.filter((projectId) => keptIds.has(projectId)),
    };
  }, [isSearching, searchTerm, groupedProjectsMap, ungroupedProjects, sortableIds]);

  const totalFilteredCount =
    filteredUngroupedProjects.length +
    Array.from(filteredGroupedProjects.values()).reduce((sum, list) => sum + list.length, 0);

  useEffect(() => {
    if (creatingGroup && newGroupInputRef.current) {
      newGroupInputRef.current.focus();
    }
  }, [creatingGroup]);

  const handleNewProject = async () => {
    const selectedPath = await window.electronAPI.dialog.selectFolder();
    if (!selectedPath) return;

    const project = await openProjectByPath(selectedPath);
    const wasExisting = projects.some(
      (p) => p.path.replace(/\\/g, '/') === selectedPath.replace(/\\/g, '/'),
    );
    useToastStore.getState().addToast({
      message: wasExisting ? `Opened project "${project.name}"` : `Created project "${project.name}"`,
      variant: 'info',
    });
  };

  const handleNewGroup = () => {
    setCreatingGroup(!creatingGroup);
    setNewGroupName('');
  };

  const handleSubmitNewGroup = async () => {
    const trimmed = newGroupName.trim();
    if (trimmed) {
      await createGroup({ name: trimmed });
    }
    setCreatingGroup(false);
    setNewGroupName('');
  };

  const handleOpenSettings = (project: Project) => {
    openProjectSettings(project.path, project.name);
  };

  const handleDeleteClick = (project: Project) => {
    setProjectToDelete(project);
  };

  const handleConfirmDelete = async (_dontAskAgain: boolean) => {
    if (!projectToDelete) return;
    const wasActive = currentProject?.id === projectToDelete.id;
    const name = projectToDelete.name;
    await deleteProject(projectToDelete.id);
    setProjectToDelete(null);
    useToastStore.getState().addToast({
      message: `Deleted project "${name}"`,
      variant: 'info',
    });

    // Auto-select the first remaining project if the deleted one was active
    if (wasActive) {
      const remaining = useProjectStore.getState().projects;
      if (remaining.length > 0) {
        openProject(remaining[0].id);
      }
    }
  };

  const handleConfirmDeleteGroup = async (_dontAskAgain: boolean) => {
    if (!groupToDelete) return;
    await deleteGroup(groupToDelete.id);
    setGroupToDelete(null);
  };

  const handleGroupMoveUp = useCallback((groupId: string) => {
    const index = sortedGroups.findIndex((g) => g.id === groupId);
    if (index <= 0) return;
    const reordered = arrayMove(sortedGroups, index, index - 1);
    reorderGroups(reordered.map((g) => g.id));
  }, [sortedGroups, reorderGroups]);

  const handleGroupMoveDown = useCallback((groupId: string) => {
    const index = sortedGroups.findIndex((g) => g.id === groupId);
    if (index === -1 || index >= sortedGroups.length - 1) return;
    const reordered = arrayMove(sortedGroups, index, index + 1);
    reorderGroups(reordered.map((g) => g.id));
  }, [sortedGroups, reorderGroups]);

  const handleContextMenu = useCallback((event: React.MouseEvent, project: Project) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ position: { x: event.clientX, y: event.clientY }, project });
  }, []);

  const handleGroupContextMenu = useCallback((event: React.MouseEvent, group: ProjectGroup) => {
    event.preventDefault();
    event.stopPropagation();
    setGroupContextMenu({ position: { x: event.clientX, y: event.clientY }, group });
  }, []);

  const handleGroupRenameSubmit = useCallback(async (id: string, name: string) => {
    await updateGroup(id, name);
    setRenamingGroupId(null);
  }, [updateGroup]);

  const handleRenameProject = useCallback((id: string, name: string) => {
    renameProject(id, name);
    setRenamingProjectId(null);
  }, [renameProject]);

  const handleContextMenuMoveToGroup = useCallback((projectId: string, groupId: string) => {
    setProjectGroup(projectId, groupId);
  }, [setProjectGroup]);

  const handleContextMenuRemoveFromGroup = useCallback((projectId: string) => {
    setProjectGroup(projectId, null);
  }, [setProjectGroup]);

  const renderProjectItem = (project: Project, isGrouped: boolean) => {
    const isActive = currentProject?.id === project.id;
    const runningSessions = sessions.filter(
      (s) => s.projectId === project.id && s.status === 'running' && !s.transient,
    );
    const thinkingCount = runningSessions.filter(
      (s) => sessionActivity[s.id] !== 'idle',
    ).length;
    const idleCount = runningSessions.filter(
      (s) => sessionActivity[s.id] === 'idle',
    ).length;
    return (
      <ProjectListItem
        key={project.id}
        project={project}
        isActive={isActive}
        isRenaming={renamingProjectId === project.id}
        thinkingCount={thinkingCount}
        idleCount={idleCount}
        isGrouped={isGrouped}
        onSelect={openProject}
        onContextMenu={handleContextMenu}
        onRename={handleRenameProject}
        onCancelRename={() => setRenamingProjectId(null)}
      />
    );
  };

  return (
    <div className="w-full h-full bg-surface-raised flex flex-col flex-shrink-0">
      <div className="px-3 pt-3 pb-2 border-b border-edge space-y-2">
        <div className="flex items-center gap-2">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-1 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Hide sidebar"
            >
              <ChevronsLeft size={16} />
            </button>
          )}
          <span className="text-xs font-semibold uppercase tracking-wider text-fg-faint">
            Projects
          </span>
          {projects.length > 0 && (
            <CountBadge count={projects.length} variant="muted" size="sm" />
          )}
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearch('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search projects..."
            data-testid="project-sidebar-search"
            className="w-full h-8 bg-surface/50 border border-edge/50 rounded-md text-xs text-fg placeholder-fg-disabled pl-7 pr-7 outline-none focus:border-edge-input transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-disabled hover:text-fg-muted transition-colors"
              data-testid="project-sidebar-search-clear"
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={filteredSortableIds} strategy={rectSortingStrategy}>
            {/* Groups with their projects */}
            {sortedGroups.map((group, groupIndex) => {
              const groupProjects = filteredGroupedProjects.get(group.id) || [];
              if (isSearching && groupProjects.length === 0) return null;
              const forceExpanded = isSearching && groupProjects.length > 0;
              const isExpanded = forceExpanded || !group.is_collapsed;
              return (
                <React.Fragment key={group.id}>
                  <GroupHeader
                    group={group}
                    projectCount={groupProjects.length}
                    isRenaming={renamingGroupId === group.id}
                    onToggleCollapsed={toggleGroupCollapsed}
                    onRename={handleGroupRenameSubmit}
                    onContextMenu={handleGroupContextMenu}
                    onCancelRename={() => setRenamingGroupId(null)}
                  />
                  {isExpanded && groupProjects.length > 0 && (
                    <div>
                      {groupProjects.map((project) => renderProjectItem(project, true))}
                    </div>
                  )}
                  {groupIndex === sortedGroups.length - 1 && filteredUngroupedProjects.length > 0 && isExpanded && groupProjects.length > 0 && (
                    <div className="my-1.5 mx-3 border-b border-fg-disabled/50" />
                  )}
                </React.Fragment>
              );
            })}

            {/* Ungrouped projects below all groups */}
            {filteredUngroupedProjects.map((project) => renderProjectItem(project, false))}

            {/* Inline group creation input */}
            {creatingGroup && (
              <div className="mx-2 my-1.5 flex items-center gap-2 px-3 py-2.5 rounded-md border border-accent/50 bg-surface-hover/30">
                <FolderTree size={16} className="text-accent-fg flex-shrink-0" />
                <input
                  ref={newGroupInputRef}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onBlur={() => {
                    setCreatingGroup(false);
                    setNewGroupName('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubmitNewGroup();
                    if (e.key === 'Escape') {
                      setCreatingGroup(false);
                      setNewGroupName('');
                    }
                  }}
                  placeholder="Group name"
                  className="flex-1 min-w-0 text-sm bg-transparent text-fg outline-none placeholder:text-fg-disabled"
                />
              </div>
            )}
          </SortableContext>

          <DragOverlay>
            {activeId && (() => {
              const project = projects.find((p) => p.id === activeId);
              if (!project) return null;
              const isActive = currentProject?.id === project.id;
              return (
                <div className={`bg-surface-raised border rounded px-3 py-1.5 text-sm shadow-lg opacity-90 ${
                  isActive ? 'border-accent text-fg' : 'border-edge text-fg-muted'
                }`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-fg-faint" />
                    <span className="truncate font-medium">{project.name}</span>
                  </div>
                </div>
              );
            })()}
          </DragOverlay>
        </DndContext>
        {projects.length === 0 && (
          <div className="p-6 text-center">
            <Folder size={32} className="mx-auto text-fg-disabled mb-2" />
            <div className="text-sm text-fg-faint">No projects yet</div>
            <div className="text-xs text-fg-disabled mt-1">Use the buttons below to open a folder</div>
          </div>
        )}
        {projects.length > 0 && isSearching && totalFilteredCount === 0 && (
          <div className="p-6 text-center">
            <Search size={24} className="mx-auto text-fg-disabled mb-2" />
            <div className="text-sm text-fg-faint">No projects match</div>
            <div className="text-xs text-fg-disabled mt-1 truncate">&quot;{search}&quot;</div>
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-edge flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleNewProject}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-edge/60 text-fg-muted hover:text-fg hover:bg-surface-hover/40 hover:border-edge transition-colors"
          title="Open folder as project"
          data-testid="sidebar-new-project-button"
        >
          <FolderPlus size={14} />
          Add Project
        </button>
        <button
          type="button"
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          onClick={handleNewGroup}
          className="flex-shrink-0 inline-flex items-center justify-center w-8 h-[30px] rounded-md border border-edge/60 text-fg-muted hover:text-fg hover:bg-surface-hover/40 hover:border-edge transition-colors"
          title="New group"
          data-testid="sidebar-new-group-button"
          aria-label="New group"
        >
          <FolderTree size={14} />
        </button>
      </div>

      {/* Project context menu */}
      {contextMenu && (
        <ProjectContextMenu
          position={contextMenu.position}
          project={contextMenu.project}
          groups={sortedGroups}
          onRename={(project) => setRenamingProjectId(project.id)}
          onOpenInExplorer={(project) => window.electronAPI.shell.openPath(project.path)}
          onOpenSettings={handleOpenSettings}
          onDelete={handleDeleteClick}
          onMoveToGroup={handleContextMenuMoveToGroup}
          onRemoveFromGroup={handleContextMenuRemoveFromGroup}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Group context menu */}
      {groupContextMenu && (() => {
        const groupIndex = sortedGroups.findIndex((g) => g.id === groupContextMenu.group.id);
        return (
          <GroupContextMenu
            position={groupContextMenu.position}
            group={groupContextMenu.group}
            isFirst={groupIndex === 0}
            isLast={groupIndex === sortedGroups.length - 1}
            onRename={(group) => setRenamingGroupId(group.id)}
            onMoveUp={(group) => handleGroupMoveUp(group.id)}
            onMoveDown={(group) => handleGroupMoveDown(group.id)}
            onDelete={(group) => setGroupToDelete(group)}
            onClose={() => setGroupContextMenu(null)}
          />
        );
      })()}

      {projectToDelete && (
        <ConfirmDialog
          title="Delete Project"
          message={
            <p>
              Are you sure you want to delete <strong>&quot;{projectToDelete.name}&quot;</strong>? This will
              remove the project from Kangentic but won&apos;t delete any files on disk.
            </p>
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setProjectToDelete(null)}
        />
      )}

      {groupToDelete && (() => {
        const groupProjectCount = projects.filter((p) => p.group_id === groupToDelete.id).length;
        return (
        <ConfirmDialog
          title="Delete Group"
          message={
            <p>
              Delete group <strong>&quot;{groupToDelete.name}&quot;</strong>?
              Its {groupProjectCount} project{groupProjectCount !== 1 ? 's' : ''} will become ungrouped.
            </p>
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleConfirmDeleteGroup}
          onCancel={() => setGroupToDelete(null)}
        />
        );
      })()}
    </div>
  );
}
