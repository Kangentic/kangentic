/**
 * Root for the detached Knowledge Graph window.
 *
 * Goes through `LazyKnowledgeGraph` rather than importing the body directly, and
 * that is load-bearing: this module IS statically reachable from the renderer
 * entry via the pop-out surface registry, so a static import here would drag the
 * canvas back into the main bundle and the code split would remove nothing.
 * `KnowledgeGraphDetailLayer` is imported statically on purpose - it is the window engine,
 * which the main bundle already carries, so deferring it would buy nothing and
 * would delay the layer past the first "Open conversation" click.
 *
 * `data-dismiss-layer="knowledge-graph"`: light dismiss needs a scope root per HOST, and
 * this root does NOT render `KnowledgeGraphPage` (which declares the in-app overlay's),
 * so without its own marker a click in this window would resolve to no scope and
 * the conversation windows here would never light-dismiss. Same reasoning, and same
 * shape, as `PopOutMonitorRoot`.
 *
 * The detail layer is mounted here AND by the in-app overlay, because "Open
 * conversation" must land in whichever graph the user is actually looking at. Each
 * renderer has its own window store, so a transcript opened in-app does not follow
 * the surface into a pop-out; the layer is deliberately not persisted (see
 * `KnowledgeGraphDetailLayer`), so there is nothing to hand over.
 */

import { LazyKnowledgeGraph } from '../../components/knowledge-graph/LazyKnowledgeGraph';
import { KnowledgeGraphDetailLayer } from '../../components/knowledge-graph/KnowledgeGraphDetailLayer';

export function PopOutKnowledgeGraphRoot() {
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-dismiss-layer="knowledge-graph">
      <LazyKnowledgeGraph />
      {/* No status bar in a detached window, so the layer runs to the bottom edge. */}
      <KnowledgeGraphDetailLayer bottomInsetClass="bottom-0" />
    </div>
  );
}
