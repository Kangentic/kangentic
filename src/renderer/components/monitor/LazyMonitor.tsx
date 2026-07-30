import { lazy, Suspense } from 'react';
import { PanelErrorBoundary } from '../PanelErrorBoundary';

/**
 * The single lazy boundary for the monitor body.
 *
 * BOTH hosts (the in-app overlay and the pop-out window) must import the body
 * through here. If only one did, the body would re-enter the main bundle through
 * the other's static import and the split would silently stop paying for itself -
 * the same trap documented on LazyStatsDashboard.
 */
const MonitorBodyLazy = lazy(() =>
  import('./MonitorBody').then((module) => ({ default: module.MonitorBody })));

function MonitorSkeleton() {
  return (
    <div className="flex-1 min-h-0 p-4 space-y-2" data-testid="monitor-lazy-skeleton">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="h-28 rounded-lg bg-surface-hover animate-pulse"
          style={{ opacity: 1 - index * 0.15 }}
        />
      ))}
    </div>
  );
}

export function LazyMonitor() {
  return (
    <PanelErrorBoundary label="agent monitor">
      <Suspense fallback={<MonitorSkeleton />}>
        <MonitorBodyLazy />
      </Suspense>
    </PanelErrorBoundary>
  );
}
