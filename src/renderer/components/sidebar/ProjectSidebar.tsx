import React, { useState, useCallback } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Trash2, Plus, GripVertical, Folder, FolderOpen, Menu, Loader2, Mail, Settings } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import type { Project } from '../../../shared/types';

/** Show last 3 path segments, e.g. "Users/dev/my-project" */
function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/');
  return '.../' + parts.slice(-3).join('/');
}

interface SortableProjectItemProps {
  project: Project;
  isActive: boolean;
  thinkingCount: number;
  idleCount: number;
  onSelect: (id: string) => void;
  onOpenSettings: (e: React.MouseEvent, project: Project) => void;
  onOpenInExplorer: (e: React.MouseEvent, project: Project) => void;
  onDeleteClick: (e: React.MouseEvent, project: Project) => void;
}

function SortableProjectItem({
  project,
  isActive,
  thinkingCount,
  idleCount,
  onSelect,
  onOpenSettings,
  onOpenInExplorer,
  onDeleteClick,
}: SortableProjectItemProps) {
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
      className={`group w-full text-left px-3 py-2 text-sm transition-colors border-l-2 cursor-pointer outline-none ${
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
                  title={`${idleCount} idle -- needs attention`}
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

interface ProjectSidebarProps {
  onToggleSidebar?: () => void;
}

export function ProjectSidebar({ onToggleSidebar }: ProjectSidebarProps) {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const openProject = useProjectStore((s) => s.openProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionActivity = useSessionStore((s) => s.sessionActivity);
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const openProjectByPath = useProjectStore((s) => s.openProjectByPath);

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

  const handleConfirmDelete = async () => {
    if (!projectToDelete) return;
    const name = projectToDelete.name;
    await deleteProject(projectToDelete.id);
    setProjectToDelete(null);
    useToastStore.getState().addToast({
      message: `Deleted project "${name}"`,
      variant: 'info',
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = projects.findIndex((p) => p.id === active.id);
    const newIndex = projects.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(projects, oldIndex, newIndex);
    reorderProjects(reordered.map((p) => p.id));
  }, [projects, reorderProjects]);

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
                <Menu size={16} />
              </button>
            )}
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-faint">Projects</span>
          </div>
          <button
            onClick={handleNewProject}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-accent/40 text-xs text-accent-fg hover:bg-accent/15 transition-colors"
            title="Open folder as project"
          >
            <Plus size={14} />
            New
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            {projects.map((project) => {
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
                <SortableProjectItem
                  key={project.id}
                  project={project}
                  isActive={isActive}
                  thinkingCount={thinkingCount}
                  idleCount={idleCount}
                  onSelect={openProject}
                  onOpenSettings={handleOpenSettings}
                  onOpenInExplorer={handleOpenInExplorer}
                  onDeleteClick={handleDeleteClick}
                />
              );
            })}
          </SortableContext>
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

      {projectToDelete && (
        <ConfirmDialog
          title="Delete Project"
          message={
            <p>
              Are you sure you want to delete <strong>"{projectToDelete.name}"</strong>? This will
              remove the project from Kangentic but won't delete any files on disk.
            </p>
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setProjectToDelete(null)}
        />
      )}
    </div>
  );
}
