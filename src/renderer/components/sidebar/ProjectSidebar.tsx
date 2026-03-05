import React, { useState } from 'react';
import { Trash2, Plus, Folder, FolderOpen, Menu, Loader2, Mail } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
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

interface ProjectSidebarProps {
  onToggleSidebar?: () => void;
}

export function ProjectSidebar({ onToggleSidebar }: ProjectSidebarProps) {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const openProject = useProjectStore((s) => s.openProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionActivity = useSessionStore((s) => s.sessionActivity);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const handleNewProject = async () => {
    const selectedPath = await window.electronAPI.dialog.selectFolder();
    if (!selectedPath) return;

    // Check if this path already has a project
    const existing = projects.find(
      (p) => p.path.replace(/\\/g, '/') === selectedPath.replace(/\\/g, '/'),
    );

    if (existing) {
      await openProject(existing.id);
      useToastStore.getState().addToast({
        message: `Opened project "${existing.name}"`,
        variant: 'info',
      });
    } else {
      const project = await window.electronAPI.projects.openByPath(selectedPath);
      await useProjectStore.getState().loadProjects();
      await useProjectStore.getState().loadCurrent();
      useToastStore.getState().addToast({
        message: `Created project "${project.name}"`,
        variant: 'info',
      });
    }
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
            <Plus size={12} />
            New
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
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
            <div
              key={project.id}
              role="button"
              tabIndex={0}
              onClick={() => openProject(project.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openProject(project.id); }}
              className={`group w-full text-left px-3 py-2 text-sm transition-colors border-l-2 cursor-pointer ${
                isActive
                  ? 'border-accent bg-surface-hover text-fg'
                  : 'border-transparent text-fg-muted hover:bg-surface-hover/50 hover:text-fg-secondary'
              }`}
            >
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Folder size={14} className={`flex-shrink-0 ${isActive ? 'text-accent-fg' : 'text-fg-faint'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{project.name}</div>
                    <div
                      className="truncate text-xs text-fg-faint mt-0.5"
                      title={project.path}
                    >
                      {shortenPath(project.path)}
                    </div>
                  </div>
                </div>
                {(thinkingCount > 0 || idleCount > 0) && (
                  <div className="flex items-center gap-1.5 flex-shrink-0 mr-1">
                    {thinkingCount > 0 && (
                      <span
                        className="flex items-center gap-1 text-xs tabular-nums text-green-400"
                        title={`${thinkingCount} thinking`}
                      >
                        <Loader2 size={10} className="animate-spin" />
                        {thinkingCount}
                      </span>
                    )}
                    {idleCount > 0 && (
                      <span
                        className="flex items-center gap-1 text-xs tabular-nums text-amber-400"
                        title={`${idleCount} idle — needs attention`}
                      >
                        <Mail size={10} />
                        {idleCount}
                      </span>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={(e) => handleOpenInExplorer(e, project)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-fg-disabled hover:text-fg-tertiary hover:bg-edge-input/50 transition-all"
                    title="Open in file explorer"
                  >
                    <FolderOpen size={14} />
                  </button>
                  <button
                    onClick={(e) => handleDeleteClick(e, project)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-fg-disabled hover:text-red-400 hover:bg-red-400/10 transition-all"
                    title="Delete project"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
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
