import { useProjectStore } from '../../stores/project-store';
import { useUsageDashboardStore } from '../../stores/usage-dashboard-store';
import { enqueueUsage } from '../../lib/session-update-coalescer';
import { PopOutStatsRoot } from '../roots/PopOutStatsRoot';
import type { SurfaceDescriptor } from '../surface-registry';

export const statsSurface: SurfaceDescriptor<'stats'> = {
  kind: 'stats',
  Root: PopOutStatsRoot,

  bootstrap: (_params, { signal }) => {
    // Projects for the scope picker + current-project resolution.
    void useProjectStore.getState().loadProjects();
    void useProjectStore.getState().loadCurrent();

    // This window's OWN usage-dashboard-store instance: flip it open (so its
    // internal loadDashboardStats calls stop no-op'ing) and force the first fetch.
    useUsageDashboardStore.getState().open();
    void useUsageDashboardStore.getState().loadDashboardStats({ force: true, evenIfClosed: true });

    // Live usage pushes -> coalescer -> session-store.sessionUsage, which
    // StatsDashboardBody already subscribes for its debounced refetch. This is
    // the one wire the pop-out needs beyond what StatsDashboardBody already does.
    const unsubscribe = window.electronAPI.sessions.onUsage((sessionId, data) => enqueueUsage(sessionId, data));
    signal.addEventListener('abort', unsubscribe);
  },

  hmrResync: () => {
    void useUsageDashboardStore.getState().loadDashboardStats({ force: true, evenIfClosed: true });
  },

  inAppSurface: 'stats-overlay',
};
