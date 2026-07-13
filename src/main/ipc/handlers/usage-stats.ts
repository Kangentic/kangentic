import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { LiveSessionRow, UsageCustomWindow, UsageDayDrill, UsageStatsScope, UsageTimePeriod } from '../../../shared/types';
import { usageStatsService } from '../../usage-stats/usage-stats-service';
import type { SessionManager } from '../../pty/session-manager';
import type { IpcContext } from '../ipc-context';

/**
 * Snapshot of in-flight (running/queued) sessions for the requested scope,
 * read straight from the live `SessionManager` - the piece of "current
 * usage" the finalized `usage_history` ledger structurally cannot see until
 * a session finalizes. Excludes transient (Command Terminal) sessions: they
 * have no real task/project the dashboard scopes by.
 */
function buildLiveSessionRows(sessionManager: SessionManager, scope: UsageStatsScope): LiveSessionRow[] {
  const usageCache = scope.kind === 'project'
    ? sessionManager.getUsageCacheForProject(scope.projectId)
    : sessionManager.getUsageCache();

  const rows: LiveSessionRow[] = [];
  for (const session of sessionManager.listSessions()) {
    if (session.status !== 'running' && session.status !== 'queued') continue;
    if (session.transient) continue;
    if (scope.kind === 'project' && session.projectId !== scope.projectId) continue;

    // A just-spawned session may have no usage snapshot yet (status.json
    // hasn't landed) - still counted (0 usage), so the SESSIONS KPI reflects
    // it immediately instead of waiting for its first telemetry tick.
    const usage = usageCache[session.id];
    rows.push({
      sessionRecordId: session.id,
      projectId: session.projectId,
      startedAtIso: session.startedAt,
      inputTokens: usage?.contextWindow.totalInputTokens ?? 0,
      outputTokens: usage?.contextWindow.totalOutputTokens ?? 0,
      costUsd: usage?.cost.totalCostUsd ?? 0,
      totalDurationMs: usage?.cost.totalDurationMs ?? null,
      toolCallCount: sessionManager.getToolCallCount(session.id),
      modelId: usage?.model.id ?? null,
      modelDisplayName: usage?.model.displayName ?? null,
      agent: sessionManager.getSessionAgentName(session.id) ?? null,
      effort: usage?.model.effort ?? null,
    });
  }
  return rows;
}

/**
 * Read-only usage-statistics endpoint backing the dashboard. The scope is
 * explicit (the dashboard can aggregate the current project OR every
 * registered project), so no ambient-project routing is involved; a stale
 * scope after a project switch shows one frame of the previous project's
 * numbers and is refetched by the renderer - it cannot corrupt anything
 * (project-scoped-ipc stamps mutations only).
 */
export function registerUsageStatsHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.USAGE_GET_DASHBOARD_STATS, (
    _event,
    scope: UsageStatsScope,
    period: UsageTimePeriod,
    drill: UsageDayDrill | null = null,
    customWindow: UsageCustomWindow | null = null,
  ) => {
    // A drill or custom window is pure ledger accounting over a (possibly
    // past) bounded range - live in-flight sessions must not layer onto it.
    const liveSessions = !drill && !customWindow
      ? buildLiveSessionRows(context.sessionManager, scope)
      : [];
    return usageStatsService.getDashboardStats(scope, period, drill, customWindow, liveSessions);
  });
}
