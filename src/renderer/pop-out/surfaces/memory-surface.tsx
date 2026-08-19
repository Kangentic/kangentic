import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import { PopOutMemoryRoot } from '../roots/PopOutMemoryRoot';
import type { SurfaceDescriptor } from '../surface-registry';

export const memorySurface: SurfaceDescriptor<'memory'> = {
  kind: 'memory',
  Root: PopOutMemoryRoot,

  bootstrap: (_params, { signal }) => {
    // Opened with NULL on purpose, which puts the store in follow-main mode.
    //
    // A pop-out is a separate renderer, and `usePopOutBootstrap` loads config
    // and nothing else - this window's `project-store` is never populated, so
    // it cannot observe a project switch in the main window and subscribing to
    // that store here would be dead code. Following main instead means every
    // read passes null for main to resolve, and any completion push is a reason
    // to re-read, so a switch in the main window re-points this map correctly.
    useMemoryGraphStore.getState().open(null);
    signal.addEventListener('abort', () => useMemoryGraphStore.getState().detach());
  },

  hmrResync: () => {
    void useMemoryGraphStore.getState().loadSnapshot();
  },

  inAppSurface: 'memory-overlay',
};
