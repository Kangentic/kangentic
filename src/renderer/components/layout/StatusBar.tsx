import React from 'react';
import { SquareTerminal, ClipboardCheck, ArrowUp, ArrowDown } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { formatTokenCount } from '../../utils/format-tokens';
import { useValuePulse } from '../../hooks/useValuePulse';

export function StatusBar() {
  const allSessions = useSessionStore((s) => s.sessions);
  const sessionUsage = useSessionStore((s) => s.sessionUsage);
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

  // Aggregate token usage across current project's sessions
  const projectSessionIds = new Set(projectSessions.map((s) => s.id));
  const usageValues = Object.entries(sessionUsage)
    .filter(([id]) => projectSessionIds.has(id))
    .map(([, usage]) => usage);
  const hasUsage = usageValues.length > 0;
  const totalInput = usageValues.reduce((sum, u) => sum + u.contextWindow.totalInputTokens, 0);
  const totalOutput = usageValues.reduce((sum, u) => sum + u.contextWindow.totalOutputTokens, 0);
  const totalCost = usageValues.reduce((sum, u) => sum + u.cost.totalCostUsd, 0);

  // Pulse hooks -- always called unconditionally (hooks rules)
  const tokenKey = `${totalInput}-${totalOutput}`;
  const tokenPulseRef = useValuePulse(tokenKey);
  const costPulseRef = useValuePulse(totalCost);

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
              <span ref={tokenPulseRef} className="tabular-nums flex items-center gap-3" data-testid="aggregate-tokens" title="Total input / output tokens across all sessions">
                <span className="flex items-center gap-1">
                  <ArrowUp size={11} className="text-fg-faint" />
                  {formatTokenCount(totalInput)}
                </span>
                <span className="flex items-center gap-1">
                  <ArrowDown size={11} className="text-fg-faint" />
                  {formatTokenCount(totalOutput)}
                </span>
              </span>
              <div className="w-px h-3.5 bg-edge flex-shrink-0" />
              <span ref={costPulseRef} className="tabular-nums" data-testid="aggregate-cost" title="Total API cost across all sessions">
                ${totalCost.toFixed(2)}
              </span>
            </>
          )}
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-4">
        {claudeInfo && !claudeInfo.found && (
          <span className="text-red-400">claude not found</span>
        )}
        {appVersion && (
          <span className="border border-edge rounded-full text-fg-muted px-2.5 py-0.5">v{appVersion}</span>
        )}
      </div>
    </div>
  );
}
