import { SquareTerminal, ClipboardCheck } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useUpdaterStore } from '../../stores/updater-store';
import { DEFAULT_AGENT } from '../../../shared/types';
import { Pill } from '../Pill';
import { bakedReleaseNotes } from '../../lib/baked-release-notes';

/**
 * Bottom status bar: agents/queued/tasks counts, agent-not-found warning, and
 * the app version. The old usage strip (tokens up/down, cost, time-range
 * dropdown) was replaced by the usage dashboard (title-bar chart icon /
 * Mod+Shift+U), which is now the only usage surface.
 */
export function StatusBar() {
  const allSessions = useSessionStore((s) => s.sessions);
  const appVersion = useConfigStore((s) => s.appVersion);
  const tasks = useBoardStore((s) => s.tasks);
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const currentProject = useProjectStore((s) => s.currentProject);
  const agentEntry = useConfigStore((s) =>
    s.agentList.find((agent) => agent.name === (currentProject?.default_agent ?? DEFAULT_AGENT)));
  const openWhatsNewAction = useUpdaterStore((s) => s.openWhatsNew);
  const openWhatsNew = () => openWhatsNewAction({ autoOpened: false });

  const projectSessions = allSessions.filter((s) => s.projectId === currentProject?.id);
  const activeSessions = projectSessions.filter((s) => s.status === 'running').length;
  const queued = projectSessions.filter((s) => s.status === 'queued').length;

  // Count tasks not in "done" role swimlanes
  const doneSwimlaneIds = new Set(
    swimlanes.filter((s) => s.role === 'done').map((s) => s.id),
  );
  const activeTasks = tasks.filter((t) => !doneSwimlaneIds.has(t.swimlane_id)).length;

  // `data-dismiss-layer`: the status bar belongs to the board layer, so dead space here
  // light-dismisses an open task window. It needs its own marker because it sits OUTSIDE
  // AppLayout's marked shell row rather than inside it. A new clickable child must carry
  // `cursor-pointer` or `data-no-dismiss`, or a click on it will dismiss instead of acting.
  // Note this stays board-scoped while the Agent Monitor is open: the monitor overlay
  // leaves the status bar exposed, and a click here closes a board window the user cannot
  // currently see. That matches the behavior before the denylist inversion.
  return (
    // `app-status-bar`, not `status-bar`: the bare name is already asserted ABSENT by
    // task-activity-indicators.spec.ts (the task-detail "initializing" bar), so claiming it
    // here made that absence check resolve to this always-visible element and fail.
    <div className="h-9 bg-surface border-t border-edge flex items-center px-3 text-xs text-fg-faint select-none flex-shrink-0" data-testid="app-status-bar" data-dismiss-layer="board">
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
        {agentEntry && !agentEntry.found && (
          <span className="text-red-400" data-testid="agent-not-found">{agentEntry.displayName} not found</span>
        )}
        {appVersion && (
          // Passing `onClick` makes Pill render a real <button> with
          // `cursor-pointer`, which is what keeps this from also light-dismissing
          // an open task window (see the data-dismiss-layer note above).
          // `undefined` when the build has no notes leaves it a plain <span>: a
          // clickable pill that opens an empty dialog is worse than a static one -
          // and a static one correctly reads as dead space that dismisses.
          <Pill
            size="sm"
            onClick={bakedReleaseNotes ? openWhatsNew : undefined}
            title={bakedReleaseNotes ? `What's new in v${appVersion}` : undefined}
            data-testid="status-bar-version-pill"
            className={`border border-edge text-fg-muted${
              bakedReleaseNotes ? ' hover:text-fg-secondary hover:border-fg-faint transition-colors' : ''
            }`}
          >
            v{appVersion}
          </Pill>
        )}
      </div>
    </div>
  );
}
