import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import {
  Folder, ChevronsLeft, FolderPlus, FolderTree,
} from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { Pill } from '../Pill';
import type { Project, ProjectGroup } from '../../../shared/types';
import {
  ProjectListItem,
  GroupHeader,
  ProjectContextMenu,
  useSidebarDragDrop,
  shortenPath,
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
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);

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

  const handleOpenSettings = (event: React.MouseEvent, project: Project) => {
    event.stopPropagation();
    openProjectSettings(project.path, project.name);
  };

  const handleOpenInExplorer = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    window.electronAPI.shell.openPath(project.path);
  };

  const handleDeleteClick = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
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

  const handleGroupRename = async (id: string, name: string) => {
    await updateGroup(id, name);
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
      (s) => s.projectId === project.id && s.status === 'running',
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
        onOpenSettings={handleOpenSettings}
        onOpenInExplorer={handleOpenInExplorer}
        onDeleteClick={handleDeleteClick}
        onContextMenu={handleContextMenu}
        onRename={handleRenameProject}
        onCancelRename={() => setRenamingProjectId(null)}
      />
    );
  };

  return (
    <div className="w-full h-full bg-surface-raised flex flex-col flex-shrink-0">
      <div className="px-3 pt-3 pb-2 border-b border-edge">
        <div className="flex items-center justify-between">
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
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-faint">Projects</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Pill
              onClick={handleNewProject}
              className="border border-accent/40 text-accent-fg hover:bg-accent/15 transition-colors"
              title="Open folder as project"
            >
              <FolderPlus size={14} />
              Project
            </Pill>
            <Pill
              onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
              onClick={handleNewGroup}
              className="border border-edge/60 text-fg-muted hover:text-fg-tertiary hover:bg-surface-hover transition-colors"
              title="New group"
            >
              <FolderTree size={14} />
              Group
            </Pill>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
            {/* Groups with their projects */}
            {sortedGroups.map((group, groupIndex) => {
              const groupProjects = groupedProjectsMap.get(group.id) || [];
              return (
                <React.Fragment key={group.id}>
                  <GroupHeader
                    group={group}
                    projectCount={groupProjects.length}
                    isFirst={groupIndex === 0}
                    isLast={groupIndex === sortedGroups.length - 1}
                    onToggleCollapsed={toggleGroupCollapsed}
                    onRename={handleGroupRename}
                    onDelete={setGroupToDelete}
                    onMoveUp={handleGroupMoveUp}
                    onMoveDown={handleGroupMoveDown}
                  />
                  {!group.is_collapsed && groupProjects.length > 0 && (
                    <div>
                      {groupProjects.map((project) => renderProjectItem(project, true))}
                    </div>
                  )}
                  {groupIndex === sortedGroups.length - 1 && ungroupedProjects.length > 0 && !group.is_collapsed && groupProjects.length > 0 && (
                    <div className="my-1.5 mx-3 border-b border-fg-disabled/50" />
                  )}
                </React.Fragment>
              );
            })}

            {/* Ungrouped projects below all groups */}
            {ungroupedProjects.map((project) => renderProjectItem(project, false))}

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
                <div className="bg-surface-raised border border-edge rounded px-3 py-2 text-sm text-fg shadow-lg opacity-90">
                  <div className="flex items-center gap-2">
                    <Folder size={16} className={`${isActive ? 'text-accent-fg' : 'text-fg-faint'} flex-shrink-0`} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{project.name}</div>
                      <div className="truncate text-xs text-fg-faint mt-0.5">{shortenPath(project.path)}</div>
                    </div>
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
            <div className="text-xs text-fg-disabled mt-1">Click "+ New" to open a folder</div>
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-edge text-xs text-fg-disabled">
        {projects.length} project{projects.length !== 1 ? 's' : ''}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ProjectContextMenu
          position={contextMenu.position}
          project={contextMenu.project}
          groups={sortedGroups}
          onRename={(project) => setRenamingProjectId(project.id)}
          onOpenInExplorer={(project) => window.electronAPI.shell.openPath(project.path)}
          onOpenSettings={(project) => openProjectSettings(project.path, project.name)}
          onDelete={(project) => setProjectToDelete(project)}
          onMoveToGroup={handleContextMenuMoveToGroup}
          onRemoveFromGroup={handleContextMenuRemoveFromGroup}
          onClose={() => setContextMenu(null)}
        />
      )}

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
