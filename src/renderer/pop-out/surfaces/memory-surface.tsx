import { useConfigStore } from '../../stores/config-store';
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
    // The ask box decides who answers from the installed agents, and nothing
    // else in this window loads them. Without the list every question read as
    // "no agent chosen" and asking was impossible detached.
    void useConfigStore.getState().loadAgentList();
    signal.addEventListener('abort', () => useMemoryGraphStore.getState().detach());
  },

  hmrResync: () => {
    void useMemoryGraphStore.getState().loadSnapshot();
    void useConfigStore.getState().loadAgentList();
  },

  inAppSurface: 'memory-overlay',
};
