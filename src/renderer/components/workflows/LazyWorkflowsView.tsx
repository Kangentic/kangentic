/**
 * Lazy boundary for the Workflows view. React Flow and the canvas load the
 * first time the view opens, never at startup; `scripts/build.js` fails the
 * build if the `xyflow` chunk ever reaches the entry's static import closure.
 */

import { lazy, Suspense } from 'react';
import { PanelErrorBoundary } from '../PanelErrorBoundary';

const WorkflowsViewBody = lazy(() =>
  import('./WorkflowsView').then((module) => ({ default: module.WorkflowsView })),
);

function WorkflowsSkeleton() {
  return <div className="h-full bg-surface" data-testid="workflows-skeleton" />;
}

export function LazyWorkflowsView() {
  return (
    <PanelErrorBoundary label="Workflows">
      <Suspense fallback={<WorkflowsSkeleton />}>
        <WorkflowsViewBody />
      </Suspense>
    </PanelErrorBoundary>
  );
}
