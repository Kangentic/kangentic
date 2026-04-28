import { PanelLeft, FolderPlus } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
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
          const label = railLabelFor(project, projects);

          return (
            <button
              key={project.id}
              onClick={() => openProject(project.id)}
              title={project.name}
              data-testid={`rail-project-${project.id}`}
              className={`w-7 h-7 rounded flex items-center justify-center text-xs font-semibold transition-colors ${
                isActive
                  ? 'bg-accent/20 text-accent-fg'
                  : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
              } ${label.length > 1 ? 'tracking-tight' : ''}`}
            >
              {label}
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
