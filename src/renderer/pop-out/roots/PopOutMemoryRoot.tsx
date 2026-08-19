/**
 * Root for the detached Memory Graph window.
 *
 * Goes through `LazyMemoryGraph` rather than importing the body directly, and
 * that is load-bearing: this module IS statically reachable from the renderer
 * entry via the pop-out surface registry, so a static import here would drag the
 * canvas back into the main bundle and the code split would remove nothing.
 * `MemoryDetailLayer` is imported statically on purpose - it is the window engine,
 * which the main bundle already carries, so deferring it would buy nothing and
 * would delay the layer past the first "Open conversation" click.
 *
 * `data-dismiss-layer="memory"`: light dismiss needs a scope root per HOST, and
 * this root does NOT render `MemoryGraphPage` (which declares the in-app overlay's),
 * so without its own marker a click in this window would resolve to no scope and
 * the conversation windows here would never light-dismiss. Same reasoning, and same
 * shape, as `PopOutMonitorRoot`.
 *
 * The detail layer is mounted here AND by the in-app overlay, because "Open
 * conversation" must land in whichever graph the user is actually looking at. Each
 * renderer has its own window store, so a transcript opened in-app does not follow
 * the surface into a pop-out; the layer is deliberately not persisted (see
 * `MemoryDetailLayer`), so there is nothing to hand over.
 */

import { LazyMemoryGraph } from '../../components/memory/LazyMemoryGraph';
import { MemoryDetailLayer } from '../../components/memory/MemoryDetailLayer';

export function PopOutMemoryRoot() {
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-dismiss-layer="memory">
      <LazyMemoryGraph />
      {/* No status bar in a detached window, so the layer runs to the bottom edge. */}
      <MemoryDetailLayer bottomInsetClass="bottom-0" />
    </div>
  );
}
