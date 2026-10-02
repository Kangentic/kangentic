/**
 * Lazy boundary for the Knowledge Graph body.
 *
 * BOTH hosts must go through this wrapper. The pop-out registry chain
 * (`index.tsx` -> `PopOutSurfaceRoot` -> `surfaces/index.ts` ->
 * `knowledge-graph-surface.tsx` -> `PopOutKnowledgeGraphRoot`) is statically reachable from the
 * renderer entry, so a static import of the body anywhere in that chain would
 * pull the canvas code straight back into the main bundle and the split would
 * remove nothing. This is the same trap `LazyStatsDashboard` documents.
 */

import { lazy, Suspense } from 'react';
import { PanelErrorBoundary } from '../PanelErrorBoundary';

const KnowledgeGraphBody = lazy(() =>
  import('./KnowledgeGraphBody').then((module) => ({ default: module.KnowledgeGraphBody })),
);

// hmr-safe: reset-on-HMR just re-fires the already-resolved dynamic import
// below, which the module system serves from cache.
let hasWarmedKnowledgeGraph = false;

/** Hover-intent warm from the title-bar button, so the first open does not pay
 *  the chunk fetch. Once per session. */
export function warmKnowledgeGraph(): void {
  if (hasWarmedKnowledgeGraph) return;
  hasWarmedKnowledgeGraph = true;
  void import('./KnowledgeGraphBody');
}

function KnowledgeGraphSkeleton() {
  return (
    <div className="relative flex-1 min-h-0 bg-surface" data-testid="knowledge-graph-skeleton">
      {/* Mirrors the real layout: the left panel's cards over the map, where
          they will be once the body loads, so nothing moves when it does. */}
      <div className="absolute left-3 top-3 flex w-64 flex-col gap-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-9 rounded-lg border border-edge bg-surface-raised/80 animate-pulse-subtle" />
        ))}
      </div>
    </div>
  );
}

interface LazyKnowledgeGraphProps {
  /**
   * Where a question goes when no answering agent or model is chosen yet. The
   * in-app host opens Settings > Knowledge Graph; the detached window has no settings
   * panel, so it passes nothing and the box names the place instead.
   */
  onChooseAnswerAgent?: () => void;
  /**
   * Opens a task on the board, for an answer row whose task has no recorded
   * conversation to open instead. Absent in the detached window, which has no
   * board, so such a row shows but cannot be opened there.
   */
  onRevealTask?: (taskId: string, projectId?: string) => void;
  /** Opens Settings > Knowledge Graph from the Index flyout. Absent in the detached
   *  window, which has no settings panel, so the flyout shows no button there. */
  onOpenSettings?: () => void;
}

export function LazyKnowledgeGraph({ onChooseAnswerAgent, onRevealTask, onOpenSettings }: LazyKnowledgeGraphProps = {}) {
  return (
    <PanelErrorBoundary label="Knowledge Graph">
      <Suspense fallback={<KnowledgeGraphSkeleton />}>
        <KnowledgeGraphBody onChooseAnswerAgent={onChooseAnswerAgent} onRevealTask={onRevealTask} onOpenSettings={onOpenSettings} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
