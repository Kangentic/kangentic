import { PanelLeft, FolderPlus, Loader2, Mail } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import type { Project } from '../../../shared/types';

interface CollapsedRailProps {
  onExpandSidebar: () => void;
}

function railLabelFor(project: Project, projects: Project[]): string {
  const first = project.name.charAt(0).toUpperCase();
  const collision = projects.some(
    (other) =>
      other.id !== project.id &&
      other.name.charAt(0).toUpperCase() === first,
  );
  if (!collision) return first;
  return project.name.slice(0, 2).toUpperCase();
}

export function CollapsedRail({ onExpandSidebar }: CollapsedRailProps) {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const openProject = useProjectStore((s) => s.openProject);
  const openProjectByPath = useProjectStore((s) => s.openProjectByPath);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionActivity = useSessionStore((s) => s.sessionActivity);

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

  return (
    <div className="h-full flex flex-col items-center pt-3 pb-2 px-1 bg-surface-raised">
      <button
        onClick={onExpandSidebar}
        className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors mb-2"
        title="Show sidebar"
        data-testid="sidebar-expand-button"
      >
        <PanelLeft size={18} />
      </button>

      <div className="flex-1 flex flex-col items-center gap-1 overflow-y-auto w-full">
        {projects.map((project) => {
          const isActive = currentProject?.id === project.id;
          const runningSessions = sessions.filter(
            (session) => session.projectId === project.id && session.status === 'running' && !session.transient,
          );
          const thinkingCount = runningSessions.filter(
            (session) => sessionActivity[session.id] !== 'idle',
          ).length;
          const idleCount = runningSessions.filter(
            (session) => sessionActivity[session.id] === 'idle',
          ).length;
          const hasThinking = thinkingCount > 0;
          const hasIdle = idleCount > 0;

          const label = railLabelFor(project, projects);
          const tooltip = hasThinking || hasIdle
            ? `${project.name} - ${thinkingCount} thinking, ${idleCount} idle`
            : project.name;

          return (
            <button
              key={project.id}
              onClick={() => openProject(project.id)}
              title={tooltip}
              data-testid={`rail-project-${project.id}`}
              className={`relative w-7 h-7 rounded flex items-center justify-center text-xs font-semibold transition-colors ${
                isActive
                  ? 'bg-accent/20 text-accent-fg'
                  : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
              } ${label.length > 1 ? 'tracking-tight' : ''}`}
            >
              {label}
              {(hasThinking || hasIdle) && (
                <span
                  className="absolute -bottom-1 -right-1 inline-flex items-center justify-center w-3 h-3 rounded-full bg-surface-raised ring-1 ring-surface-raised"
                  aria-hidden
                >
                  {hasThinking ? (
                    <Loader2 size={10} className="text-green-400 animate-spin" />
                  ) : (
                    <Mail size={10} className="text-amber-400" />
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <button
        onClick={handleNewProject}
        className="p-1.5 mt-2 rounded hover:bg-surface-hover text-fg-muted hover:text-fg transition-colors"
        title="New project"
        data-testid="rail-new-project-button"
      >
        <FolderPlus size={18} />
      </button>
    </div>
  );
}
