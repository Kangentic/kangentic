import { SquareTerminal, ClipboardCheck, ArrowUp, ArrowDown } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { formatTokenCount } from '../../utils/format-tokens';
import { useValuePulse } from '../../hooks/useValuePulse';
import { Pill } from '../Pill';
import type { UsageTimePeriod } from '../../../shared/types';

const PERIOD_LABELS: Record<UsageTimePeriod, string> = {
  live: 'Live',
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  all: 'All Time',
};

export function StatusBar() {
  const allSessions = useSessionStore((s) => s.sessions);
  const sessionUsage = useSessionStore((s) => s.sessionUsage);
  const selectedPeriod = useSessionStore((s) => s.selectedPeriod);
  const periodStats = useSessionStore((s) => s.periodStats);
  const setSelectedPeriod = useSessionStore((s) => s.setSelectedPeriod);
  const claudeInfo = useConfigStore((s) => s.claudeInfo);
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

  // Aggregate token usage across current project's live sessions
  const projectSessionIds = new Set(projectSessions.map((s) => s.id));
  const usageValues = Object.entries(sessionUsage)
    .filter(([id]) => projectSessionIds.has(id))
    .map(([, usage]) => usage);
  const liveCost = usageValues.reduce((sum, u) => sum + u.cost.totalCostUsd, 0);
  const liveInput = usageValues.reduce((sum, u) => sum + u.contextWindow.totalInputTokens, 0);
  const liveOutput = usageValues.reduce((sum, u) => sum + u.contextWindow.totalOutputTokens, 0);

  // Compute displayed stats based on selected period
  const isLive = selectedPeriod === 'live';
  const displayInput = isLive ? liveInput : (periodStats?.totalInputTokens ?? 0) + liveInput;
  const displayOutput = isLive ? liveOutput : (periodStats?.totalOutputTokens ?? 0) + liveOutput;
  const displayCost = isLive ? liveCost : (periodStats?.totalCostUsd ?? 0) + liveCost;

  const hasUsage = usageValues.length > 0 || (periodStats && !isLive);

  // Pulse hooks - always called unconditionally (hooks rules)
  const tokenKey = `${displayInput}-${displayOutput}`;
  const tokenPulseRef = useValuePulse(tokenKey);
  const costPulseRef = useValuePulse(displayCost);

  return (
    <div className="h-9 bg-surface border-t border-edge flex items-center px-3 text-xs text-fg-faint select-none flex-shrink-0">
      {currentProject && (
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5" data-testid="session-count">
            <SquareTerminal size={14} className={activeSessions > 0 ? 'text-green-400' : 'text-fg-faint'} />
            <span className={activeSessions > 0 ? 'text-green-400' : ''}>
              {activeSessions} agents
            </span>
            {queued > 0 && <span className="text-fg-faint">{queued} queued</span>}
          </span>
          <span className="flex items-center gap-1.5" data-testid="task-count">
            <ClipboardCheck size={14} />
            {activeTasks} tasks
          </span>
          {hasUsage && (
            <>
              <div className="w-px h-3.5 bg-edge flex-shrink-0" />
              <span ref={tokenPulseRef} className="tabular-nums flex items-center gap-3" data-testid="aggregate-tokens" title={`${PERIOD_LABELS[selectedPeriod]} input / output tokens`}>
                <span className="flex items-center gap-1">
                  <ArrowUp size={11} className="text-fg-faint" />
                  {formatTokenCount(displayInput)}
                </span>
                <span className="flex items-center gap-1">
                  <ArrowDown size={11} className="text-fg-faint" />
                  {formatTokenCount(displayOutput)}
                </span>
              </span>
              <div className="w-px h-3.5 bg-edge flex-shrink-0" />
              <span ref={costPulseRef} className="tabular-nums" data-testid="aggregate-cost" title={`${PERIOD_LABELS[selectedPeriod]} API cost`}>
                ${displayCost.toFixed(2)}
              </span>
            </>
          )}
          {(hasUsage || !isLive) && <div className="w-px h-3.5 bg-edge flex-shrink-0" />}
          <select
            value={selectedPeriod}
            onChange={(event) => setSelectedPeriod(event.target.value as UsageTimePeriod)}
            className="appearance-none bg-transparent border border-edge rounded px-1.5 py-0.5 text-xs text-fg-muted cursor-pointer hover:border-edge-input focus:outline-none focus:border-accent"
            data-testid="usage-period-select"
            title="Usage stats time range"
          >
            {(Object.keys(PERIOD_LABELS) as UsageTimePeriod[]).map((period) => (
              <option key={period} value={period}>{PERIOD_LABELS[period]}</option>
            ))}
          </select>
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-4">
        {claudeInfo && !claudeInfo.found && (
          <span className="text-red-400">claude not found</span>
        )}
        {appVersion && (
          <Pill className="border border-edge text-fg-muted">v{appVersion}</Pill>
        )}
      </div>
    </div>
  );
}
