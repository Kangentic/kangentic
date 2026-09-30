import { useConfigStore } from '../../stores/config-store';
import { useKnowledgeGraphStore } from '../../stores/knowledge-graph-store';
import { PopOutKnowledgeGraphRoot } from '../roots/PopOutKnowledgeGraphRoot';
import type { SurfaceDescriptor } from '../surface-registry';

export const knowledgeGraphSurface: SurfaceDescriptor<'knowledge-graph'> = {
  kind: 'knowledge-graph',
  Root: PopOutKnowledgeGraphRoot,

  bootstrap: (_params, { signal }) => {
    // Opened with NULL on purpose, which puts the store in follow-main mode.
    //
    // A pop-out is a separate renderer, and `usePopOutBootstrap` loads config
    // and nothing else - this window's `project-store` is never populated, so
    // it cannot observe a project switch in the main window and subscribing to
    // that store here would be dead code. Following main instead means every
    // read passes null for main to resolve, and any completion push is a reason
    // to re-read, so a switch in the main window re-points this map correctly.
    useKnowledgeGraphStore.getState().open(null);
    // The ask box decides who answers from the installed agents, and nothing
    // else in this window loads them. Without the list every question read as
    // "no agent chosen" and asking was impossible detached.
    void useConfigStore.getState().loadAgentList();
    // `close`, not a bare `detach`: it also lets the chat's warm answering
    // session go, which would otherwise idle in main until its own timeout.
    signal.addEventListener('abort', () => useKnowledgeGraphStore.getState().close());
  },

  // The same re-sync as App.tsx's: the Projects list and every scoped project
  // are main-process truth here too.
  hmrResync: () => {
    const knowledgeGraph = useKnowledgeGraphStore.getState();
    const asRefresh = { fromPush: true };
    void knowledgeGraph.loadSnapshot(knowledgeGraph.followsCurrentProject ? null : knowledgeGraph.projectId, asRefresh);
    void knowledgeGraph.loadProjects();
    for (const scopedProjectId of knowledgeGraph.scopeProjectIds ?? []) {
      if (scopedProjectId !== knowledgeGraph.projectId) void knowledgeGraph.loadScopeSnapshot(scopedProjectId, asRefresh);
    }
    void useConfigStore.getState().loadAgentList();
  },

  inAppSurface: 'knowledge-graph-overlay',
};
