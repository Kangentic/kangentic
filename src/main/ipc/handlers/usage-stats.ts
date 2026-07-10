import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { UsageCustomWindow, UsageDayDrill, UsageStatsScope, UsageTimePeriod } from '../../../shared/types';
import { usageStatsService } from '../../usage-stats/usage-stats-service';
import type { IpcContext } from '../ipc-context';

/**
 * Read-only usage-statistics endpoint backing the dashboard. The scope is
 * explicit (the dashboard can aggregate the current project OR every
 * registered project), so no ambient-project routing is involved; a stale
 * scope after a project switch shows one frame of the previous project's
 * numbers and is refetched by the renderer - it cannot corrupt anything
 * (project-scoped-ipc stamps mutations only).
 */
export function registerUsageStatsHandlers(_context: IpcContext): void {
  ipcMain.handle(IPC.USAGE_GET_DASHBOARD_STATS, (
    _event,
    scope: UsageStatsScope,
    period: UsageTimePeriod,
    drill: UsageDayDrill | null = null,
    customWindow: UsageCustomWindow | null = null,
  ) => {
    return usageStatsService.getDashboardStats(scope, period, drill, customWindow);
  });
}
