import { PanelLeft, FolderPlus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import {
  selectCommandTerminalSummary,
  type CommandTerminalTone,
} from '../../stores/session-store/transient-session-slice';
import { useFormattedCombo } from '../../hooks/useKeybinding';
import { useAddProject } from '../../hooks/useAddProject';
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

/**
 * Tone -> dot color. A LIVE terminal that is merely resting still gets a dot: the
 * whole point of the rail indicator is that a background project's terminals are
 * otherwise invisible, so presence is the signal and tone is the detail.
 */
const RAIL_DOT_CLASS: Record<CommandTerminalTone, string> = {
  thinking: 'bg-active',
  idle: 'bg-attention',
  rest: 'bg-fg-muted',
};

/**
 * Tone -> the spoken half of the rail button's accessible name. The dot carries
 * tone in COLOR ALONE, so without this a screen-reader user learns a project has
 * terminals but never that one is waiting on them, while a sighted user reads it
 * straight off the amber. Reuses the expanded row's parenthetical vocabulary
 * (`SidebarCommandTerminalIndicator`) so the two views differ in verbosity, not
 * in meaning. The count is deliberately not spoken: the rail's summary map stores
 * tone alone so it stays a flat, shallow-comparable record.
 */
const RAIL_TERMINAL_LABEL: Record<CommandTerminalTone, string> = {
  thinking: 'Command Terminals running (working)',
  idle: 'Command Terminals running (needs you)',
  rest: 'Command Terminals running (resting)',
};

export function CollapsedRail({ onExpandSidebar }: CollapsedRailProps) {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const openProject = useProjectStore((s) => s.openProject);
  const sidebarCombo = useFormattedCombo('view.toggleSidebar');
  const { startAddProject } = useAddProject();

  // Command Terminal presence per project, for the corner dot below. One
  // subscription for the whole rail (not one per button), shallow-compared so the
  // rail re-renders only when some project's terminal state actually changes.
  const terminalSummaries = useSessionStore(
    useShallow((store) => {
      const byProject: Record<string, CommandTerminalTone> = {};
      for (const project of projects) {
        const summary = selectCommandTerminalSummary(store.sessions, store.sessionActivity, project.id);
        if (summary.count > 0) byProject[project.id] = summary.tone;
      }
      return byProject;
    }),
  );

  return (
    <div className="h-full flex flex-col items-center pt-3 pb-2 px-1 bg-surface-raised">
      <button
        onClick={onExpandSidebar}
        className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors mb-2"
        title={`Show sidebar (${sidebarCombo})`}
        data-testid="sidebar-expand-button"
      >
        <PanelLeft size={18} />
      </button>

      <div className="flex-1 flex flex-col items-center gap-1 overflow-y-auto w-full">
        {projects.map((project) => {
          const isActive = currentProject?.id === project.id;
          const label = railLabelFor(project, projects);
          const terminalTone = terminalSummaries[project.id];

          return (
            <button
              key={project.id}
              onClick={() => openProject(project.id)}
              title={project.name}
              // `title` stays the bare project name (a test pins that exactly), so the
              // terminal state rides on aria-label instead. aria-label REPLACES the
              // computed accessible name, so it has to restate the project name; when
              // there are no terminals it is omitted entirely and the name is unchanged.
              aria-label={terminalTone ? `${project.name}, ${RAIL_TERMINAL_LABEL[terminalTone]}` : undefined}
              data-testid={`rail-project-${project.id}`}
              className={`relative w-7 h-7 rounded flex items-center justify-center text-xs font-semibold transition-colors ${
                isActive
                  ? 'bg-accent/20 text-accent-fg'
                  : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
              } ${label.length > 1 ? 'tracking-tight' : ''}`}
            >
              {label}
              {/* A plain dot, NOT the Command Terminal glyph. At 28px the button is
                  already full of the project initials; the previous attempt at a rail
                  activity icon was removed because a partial-arc glyph reads as a broken
                  icon overflowing the initial. A dot has no arc, so it carries the tone
                  in the space actually available. */}
              {terminalTone && (
                <span
                  className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${RAIL_DOT_CLASS[terminalTone]}`}
                  data-testid={`rail-project-terminals-${project.id}`}
                  data-activity={terminalTone}
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </div>

      <button
        onClick={startAddProject}
        className="p-1.5 mt-2 rounded hover:bg-surface-hover text-fg-muted hover:text-fg transition-colors"
        title="New project"
        data-testid="rail-new-project-button"
      >
        <FolderPlus size={18} />
      </button>
    </div>
  );
}
