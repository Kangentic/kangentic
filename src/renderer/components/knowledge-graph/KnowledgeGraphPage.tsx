/**
 * The Knowledge Graph: a full-surface overlay between the title bar and status
 * bar, showing what this project's conversation index has learned.
 *
 * Shares `z-[42]` with StatsPage and MonitorPage rather than claiming a new
 * slot in the documented ladder (board windows 40, stats/monitor/knowledge graph 42,
 * command terminal 45, dialogs 50, toasts 60). That is only safe because all
 * three are mutually exclusive - AppLayout closes the others when one opens.
 * Do not widen the ladder for this surface.
 *
 * It carries `data-dismiss-layer="knowledge-graph"`, like MonitorPage, because it hosts a
 * window layer of its own: `KnowledgeGraphDetailLayer` mounts the conversation windows the
 * graph opens. Light dismiss needs a scope root per HOST, and the detached graph
 * (`PopOutKnowledgeGraphRoot`) does not render this component, so it declares its own.
 * `tests/unit/window-layer-isolation.test.ts` pins both sites.
 */

import { useEffect } from 'react';
import { Brain, X } from 'lucide-react';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useConfigStore } from '../../stores/config-store';
import { useKnowledgeGraphStore } from '../../stores/knowledge-graph-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { DetachableSurfaceHeader } from '../../pop-out/DetachableSurfaceHeader';
import { knowledgeGraphWindowManager } from '../../window-manager';
import { LazyKnowledgeGraph } from './LazyKnowledgeGraph';
import { KnowledgeGraphDetailLayer } from './KnowledgeGraphDetailLayer';
import { openAnswerSettings, openSearchSettings } from './open-answer-settings';

export function KnowledgeGraphPage() {
  const close = useKnowledgeGraphStore((state) => state.close);
  const statusBarVisible = useConfigStore((state) => state.config.statusBarVisible !== false);

  const overlay = useOverlayPhase(close, { variant: 'panel', skipEnterOnHmr: true });

  // Structural Escape (the documented dialog-Escape exception to the keybindings
  // registry). Bubble phase so popovers' capture-phase Escape wins first; gated
  // so a Settings drawer stacked above keeps its own.
  //
  // Also gated while a conversation window is open over the map. The layer
  // always keeps one of its windows focused, and that window closes itself on
  // Escape, so the same keystroke used to close the graph too. The graph
  // unmounted the window mid-exit, it stayed in the store, and it came back on
  // the next open.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (useConfigStore.getState().settingsOpen) return;
      if (Object.keys(knowledgeGraphWindowManager.store.getState().windows).length > 0) return;
      overlay.requestClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [overlay]);

  return (
    <div
      className={`fixed left-0 right-0 top-10 ${statusBarVisible ? 'bottom-9' : 'bottom-0'} z-[42]`}
      data-testid="knowledge-graph-page"
      data-dismiss-layer="knowledge-graph"
    >
      <div
        className={`h-full bg-surface border-t border-edge flex flex-col ${overlay.contentClassName}`}
        onAnimationEnd={overlay.onAnimationEnd}
      >
        <DetachableSurfaceHeader
          kind="knowledge-graph"
          params={{}}
          className="px-4 py-2.5"
          trailing={
            <button
              type="button"
              onClick={() => overlay.requestClose()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Close (Esc)"
              aria-label="Close Knowledge Graph"
              data-testid="knowledge-graph-close"
            >
              <X size={16} />
            </button>
          }
        >
          {/* A plain lucide glyph, not a branding activity mark: those all mean
              a STATE, so one here would read as "the graph is idle" rather
              than naming the surface. */}
          <Brain size={18} className="text-fg-muted flex-shrink-0" aria-hidden />
          {/* No project name beside the title: the Filter card's Projects row
              always shows and names the scope, so a second label only
              repeated it. */}
          <h1 className="text-sm font-semibold text-fg">Knowledge Graph</h1>
        </DetachableSurfaceHeader>

        <LazyKnowledgeGraph
          onChooseAnswerAgent={openAnswerSettings}
          onRevealTask={revealTaskOnBoard}
          onOpenSettings={openSearchSettings}
        />
      </div>

      {/* Conversation windows the graph opens, over the map. The inset matches
          this overlay's own, so a window can use the full surface. */}
      <KnowledgeGraphDetailLayer
        bottomInsetClass={statusBarVisible ? 'bottom-9' : 'bottom-0'}
        onRevealTask={revealTaskOnBoard}
      />
    </div>
  );
}

/**
 * "Open task" from a conversation on the graph: close the graph, then open the
 * task on the board, where task details live. Closing first matters, since a
 * task detail opened behind the graph's overlay would be invisible. Most of what
 * the graph shows is finished work; the detail bridge loads an older finished
 * task before mounting it (`useTaskDetailWindowBridge`).
 */
function revealTaskOnBoard(taskId: string, taskProjectId?: string): void {
  useKnowledgeGraphStore.getState().close();
  const projectStore = useProjectStore.getState();
  if (taskProjectId && taskProjectId !== projectStore.currentProject?.id) {
    // A task on another project's island: open that project, then the task,
    // through the same pending-open path Quick Find uses across projects.
    const sessionStore = useSessionStore.getState();
    sessionStore.setPendingOpenTaskId(taskId);
    void projectStore.openProject(taskProjectId).then((outcome) => {
      if (outcome !== 'opened') sessionStore.setPendingOpenTaskId(null);
    });
    return;
  }
  useSessionStore.getState().setDetailTaskId(taskId);
}
