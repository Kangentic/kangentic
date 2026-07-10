import { SquareTerminal, ClipboardCheck } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { agentDisplayName } from '../../utils/agent-display-name';
import { DEFAULT_AGENT } from '../../../shared/types';
import { Pill } from '../Pill';

/**
 * Bottom status bar: agents/queued/tasks counts, agent-not-found warning, and
 * the app version. The old usage strip (tokens up/down, cost, time-range
 * dropdown) was replaced by the usage dashboard (title-bar chart icon /
 * Mod+Shift+U), which is now the only usage surface.
 */
export function StatusBar() {
  const allSessions = useSessionStore((s) => s.sessions);
  const agentInfo = useConfigStore((s) => s.agentInfo);
  const appVersion = useConfigStore((s) => s.appVersion);
  const tasks = useBoardStore((s) => s.tasks);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const currentProject = useProjectStore((s) => s.currentProject);

  const projectSessions = allSessions.filter((s) => s.projectId === currentProject?.id);
  const activeSessions = projectSessions.filter((s) => s.status === 'running').length;
  const queued = projectSessions.filter((s) => s.status === 'queued').length;

  // Count tasks not in "done" role swimlanes
  const doneSwimlaneIds = new Set(
    swimlanes.filter((s) => s.role === 'done').map((s) => s.id),
  );
  const activeTasks = tasks.filter((t) => !doneSwimlaneIds.has(t.swimlane_id)).length;

  // `data-dismiss-surface`: dead space in the status bar light-dismisses an open task
  // window. A new clickable child must carry `cursor-pointer` or `data-no-dismiss`,
  // or a click on it will also dismiss.
  return (
    <div className="h-9 bg-surface border-t border-edge flex items-center px-3 text-xs text-fg-faint select-none flex-shrink-0" data-dismiss-surface>
      {currentProject && (
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5" data-testid="session-count">
            <SquareTerminal size={14} className={activeSessions > 0 ? 'text-active' : 'text-fg-faint'} />
            <span className={activeSessions > 0 ? 'text-active' : ''}>
              {activeSessions} agents
            </span>
            {queued > 0 && <span className="text-fg-faint">{queued} queued</span>}
          </span>
          <span className="flex items-center gap-1.5" data-testid="task-count">
            <ClipboardCheck size={14} />
            {activeTasks} tasks
          </span>
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-4">
        {agentInfo && !agentInfo.found && (
          <span className="text-red-400">{agentDisplayName(currentProject?.default_agent ?? DEFAULT_AGENT)} not found</span>
        )}
        {appVersion && (
          <Pill size="sm" className="border border-edge text-fg-muted">v{appVersion}</Pill>
        )}
      </div>
    </div>
  );
}
