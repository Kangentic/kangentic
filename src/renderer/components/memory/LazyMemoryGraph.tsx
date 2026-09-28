/**
 * Lazy boundary for the Memory Graph body.
 *
 * BOTH hosts must go through this wrapper. The pop-out registry chain
 * (`index.tsx` -> `PopOutSurfaceRoot` -> `surfaces/index.ts` ->
 * `memory-surface.tsx` -> `PopOutMemoryRoot`) is statically reachable from the
 * renderer entry, so a static import of the body anywhere in that chain would
 * pull the canvas code straight back into the main bundle and the split would
 * remove nothing. This is the same trap `LazyStatsDashboard` documents.
 */

import { lazy, Suspense } from 'react';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import { onIdle } from '../../utils/on-idle';

const MemoryGraphBody = lazy(() =>
  import('./MemoryGraphBody').then((module) => ({ default: module.MemoryGraphBody })),
);

// hmr-safe: reset-on-HMR just re-fires the already-resolved dynamic import
// below, which the module system serves from cache.
let hasWarmedMemoryGraph = false;

/** Hover-intent warm from the title-bar button, so the first open does not pay
 *  the chunk fetch. Once per session. */
export function warmMemoryGraph(): void {
  if (hasWarmedMemoryGraph) return;
  hasWarmedMemoryGraph = true;
  void import('./MemoryGraphBody');
}

export function warmMemoryGraphOnIdle(): void {
  onIdle(warmMemoryGraph);
}

function MemoryGraphSkeleton() {
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="memory-graph-skeleton">
      {/* Mirrors the real layout: coverage strip, then toolbar, then canvas. */}
      <div className="flex gap-8 px-4 py-3 border-b border-edge bg-surface-raised">
        {[0, 1, 2].map((index) => (
          <div key={index} className="space-y-1.5">
            <div className="h-4 w-16 bg-surface-hover rounded animate-pulse-subtle" />
            <div className="h-3 w-24 bg-surface-hover rounded animate-pulse-subtle" />
          </div>
        ))}
      </div>
      <div className="h-8 border-b border-edge bg-surface" />
      <div className="flex-1 bg-surface" />
    </div>
  );
}

interface LazyMemoryGraphProps {
  /**
   * Where a question goes when no answering agent or model is chosen yet. The
   * in-app host opens Settings > Search; the detached window has no settings
   * panel, so it passes nothing and the box names the place instead.
   */
  onChooseAnswerAgent?: () => void;
  /**
   * Opens a task on the board, for an answer row whose task has no recorded
   * conversation to open instead. Absent in the detached window, which has no
   * board, so such a row shows but cannot be opened there.
   */
  onRevealTask?: (taskId: string, projectId?: string) => void;
}

export function LazyMemoryGraph({ onChooseAnswerAgent, onRevealTask }: LazyMemoryGraphProps = {}) {
  return (
    <PanelErrorBoundary label="Knowledge Graph">
      <Suspense fallback={<MemoryGraphSkeleton />}>
        <MemoryGraphBody onChooseAnswerAgent={onChooseAnswerAgent} onRevealTask={onRevealTask} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
