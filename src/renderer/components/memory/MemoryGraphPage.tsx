/**
 * The Memory Graph: a full-surface overlay between the title bar and status
 * bar, showing what this project's conversation index has learned.
 *
 * Shares `z-[42]` with StatsPage and MonitorPage rather than claiming a new
 * slot in the documented ladder (board windows 40, stats/monitor/memory 42,
 * command terminal 45, dialogs 50, toasts 60). That is only safe because all
 * three are mutually exclusive - AppLayout closes the others when one opens.
 * Do not widen the ladder for this surface.
 *
 * It carries `data-dismiss-layer="memory"`, like MonitorPage, because it hosts a
 * window layer of its own: `MemoryDetailLayer` mounts the conversation windows the
 * graph opens. Light dismiss needs a scope root per HOST, and the detached graph
 * (`PopOutMemoryRoot`) does not render this component, so it declares its own.
 * `tests/unit/window-layer-isolation.test.ts` pins both sites.
 */

import { useEffect } from 'react';
import { Network, X } from 'lucide-react';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useConfigStore } from '../../stores/config-store';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import { useSessionStore } from '../../stores/session-store';
import { DetachableSurfaceHeader } from '../../pop-out/DetachableSurfaceHeader';
import { LazyMemoryGraph } from './LazyMemoryGraph';
import { MemoryDetailLayer } from './MemoryDetailLayer';
import { openAnswerSettings } from './open-answer-settings';

export function MemoryGraphPage() {
  const close = useMemoryGraphStore((state) => state.close);
  const statusBarVisible = useConfigStore((state) => state.config.statusBarVisible !== false);

  const overlay = useOverlayPhase(close, { variant: 'panel', skipEnterOnHmr: true });

  // Structural Escape (the documented dialog-Escape exception to the keybindings
  // registry). Bubble phase so popovers' capture-phase Escape wins first; gated
  // so a Settings drawer stacked above keeps its own.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (useConfigStore.getState().settingsOpen) return;
      overlay.requestClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [overlay]);

  return (
    <div
      className={`fixed left-0 right-0 top-10 ${statusBarVisible ? 'bottom-9' : 'bottom-0'} z-[42]`}
      data-testid="memory-graph-page"
      data-dismiss-layer="memory"
    >
      <div
        className={`h-full bg-surface border-t border-edge flex flex-col ${overlay.contentClassName}`}
        onAnimationEnd={overlay.onAnimationEnd}
      >
        <DetachableSurfaceHeader
          kind="memory"
          params={{}}
          className="px-4 py-2.5"
          trailing={
            <button
              type="button"
              onClick={() => overlay.requestClose()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Close (Esc)"
              aria-label="Close memory graph"
              data-testid="memory-graph-close"
            >
              <X size={16} />
            </button>
          }
        >
          {/* A plain lucide glyph, not a branding activity mark: those all mean
              a STATE, so one here would read as "the memory is idle" rather
              than naming the surface. */}
          <Network size={18} className="text-fg-muted flex-shrink-0" aria-hidden />
          <h1 className="text-sm font-semibold text-fg">Memory Graph</h1>
        </DetachableSurfaceHeader>

        <LazyMemoryGraph onChooseAnswerAgent={openAnswerSettings} onRevealTask={revealTaskOnBoard} />
      </div>

      {/* Conversation windows the graph opens, over the map. The inset matches
          this overlay's own, so a window can use the full surface. */}
      <MemoryDetailLayer
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
function revealTaskOnBoard(taskId: string): void {
  useMemoryGraphStore.getState().close();
  useSessionStore.getState().setDetailTaskId(taskId);
}
