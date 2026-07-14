import { Suspense, lazy } from 'react';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import { onIdle } from '../../utils/on-idle';

/**
 * The single lazy boundary in front of StatsDashboardBody - the module whose
 * import graph pulls recharts (the Kng* chart wrappers). BOTH hosts (the
 * in-app StatsPage overlay and the pop-out PopOutStatsRoot) render this
 * wrapper instead of importing StatsDashboardBody statically, which is what
 * keeps recharts out of the renderer's main bundle: the pop-out registry
 * chain (index.tsx -> PopOutSurfaceRoot -> surfaces -> stats-surface ->
 * PopOutStatsRoot) is statically reachable from the entry, so a lazy
 * StatsPage alone would remove nothing.
 */
const StatsDashboardBody = lazy(() =>
  import('./StatsDashboardBody').then((module) => ({ default: module.StatsDashboardBody })),
);

// hmr-safe: reset-on-HMR just re-fires the already-resolved dynamic import below - resolves instantly from the module cache (a no-op unless the stats module graph also changed in the same HMR batch).
let hasWarmedStatsDashboard = false;

/** Warm the stats chunk (and its recharts module graph) immediately - the
 *  hover-intent path (title-bar stats button mouseenter), where the user has
 *  signaled they are about to open the dashboard. Once per session; repeat
 *  calls are free. */
export function warmStatsDashboard(): void {
  if (hasWarmedStatsDashboard) return;
  hasWarmedStatsDashboard = true;
  void import('./StatsDashboardBody');
}

/** Warm the stats chunk once at idle, off the startup path, so the first
 *  stats open in a normal session resolves from the module cache with no
 *  skeleton - without recharts competing with the initial board load and
 *  session sync. Mirrors warmChangesPanelOnIdle in TaskDetailBody. */
export function warmStatsDashboardOnIdle(): void {
  onIdle(warmStatsDashboard);
}

/** Suspense fallback for the lazy stats chunk: a shell mirroring the
 *  dashboard's real layout (filter row, KPI tiles, two chart cards, three
 *  breakdown cards), so a genuinely cold open paints a recognizable frame
 *  instead of a bare spinner. */
export function StatsDashboardSkeleton() {
  return (
    <div className="flex-1 min-h-0 overflow-hidden p-4 space-y-4" data-testid="stats-dashboard-skeleton">
      <div className="flex items-center gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-7 w-24 rounded-full bg-surface-hover animate-pulse" style={{ opacity: 1 - index * 0.15 }} />
        ))}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-20 rounded-lg bg-surface-hover animate-pulse" style={{ opacity: 1 - index * 0.1 }} />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="h-56 rounded-lg bg-surface-hover animate-pulse" style={{ opacity: 0.9 - index * 0.15 }} />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-40 rounded-lg bg-surface-hover animate-pulse" style={{ opacity: 0.8 - index * 0.1 }} />
        ))}
      </div>
    </div>
  );
}

/** Drop-in replacement for a static <StatsDashboardBody />: scoped error
 *  boundary (chunk-load failures offer Reload, per PanelErrorBoundary's
 *  poisoned-module-map handling) around the Suspense boundary. */
export function LazyStatsDashboard() {
  return (
    <PanelErrorBoundary label="usage dashboard">
      <Suspense fallback={<StatsDashboardSkeleton />}>
        <StatsDashboardBody />
      </Suspense>
    </PanelErrorBoundary>
  );
}
