import { useEffect } from 'react';
import { Activity, X } from 'lucide-react';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useConfigStore } from '../../stores/config-store';
import { useMonitorStore } from '../../stores/monitor-store';
import { useBoardStore } from '../../stores/board-store';
import { DetachableSurfaceHeader } from '../../pop-out/DetachableSurfaceHeader';
import { LazyMonitor } from './LazyMonitor';
import { MonitorDetailLayer } from './MonitorDetailLayer';

/** Coalescing window for board-driven refetches while the monitor is open. */
const BOARD_REFETCH_DEBOUNCE_MS = 300;

/**
 * The Agent Monitor: a full-surface overlay between the title bar and status bar,
 * aggregating every live and recently-finished agent session across ALL projects.
 *
 * It deliberately reuses StatsPage's `z-[42]` rather than claiming a new slot in
 * the documented ladder (board windows 40, stats 42, command terminal 45, dialogs
 * 50, toasts 60). That is safe precisely because the two are mutually exclusive:
 * AppLayout closes one when the other opens, so they can never be mounted at
 * once. Do not widen the ladder for this surface.
 *
 * The Command Terminal layer is ABOVE this one (45), so AppLayout hides it when
 * the monitor opens. That is not tidiness: without it the monitor mounts under the
 * terminal's backdrop, which swallows every click, so the surface is present but
 * inert and the terminal appears to refuse to close. Its PTYs keep running, so
 * reopening the layer reattaches them.
 *
 * The pop-out button detaches it into its own OS window (PopOutMonitorRoot,
 * sharing MonitorBody so both hosts behave identically). AppLayout suppresses
 * this overlay whenever that pop-out is open.
 */
export function MonitorPage() {
  const close = useMonitorStore((state) => state.close);
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

  // Main's MONITOR_CHANGED push covers session lifecycle and AGENT-driven board
  // edits (the BoardEventBus is agent-fed only). A USER edit - renaming a task,
  // dragging it to another column - emits nothing on that bus, but it can only
  // ever target the project whose board is open, which is exactly what this store
  // holds. So the open board is the remaining signal, and subscribing to it here
  // (the main-window-only host) closes the gap without broadcasting on every
  // local keystroke. Mounted with the overlay, so it costs nothing while closed.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useBoardStore.subscribe((state, previous) => {
      if (state.tasks === previous.tasks) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void useMonitorStore.getState().loadSnapshot();
      }, BOARD_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return (
    <div
      className={`fixed left-0 right-0 top-10 ${statusBarVisible ? 'bottom-9' : 'bottom-0'} z-[42]`}
      data-testid="monitor-page"
    >
      <div
        className={`h-full bg-surface border-t border-edge flex flex-col ${overlay.contentClassName}`}
        onAnimationEnd={overlay.onAnimationEnd}
      >
        {/* Identity on the left, the pop-out control in its predictable top-right
            slot, then the overlay close. The surface's own four-axis toolbar lives
            inside MonitorBody, never mixed into this header. */}
        <DetachableSurfaceHeader
          kind="monitor"
          params={{}}
          className="px-4 py-2.5"
          trailing={
            <button
              type="button"
              onClick={() => overlay.requestClose()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Close (Esc)"
              aria-label="Close agent monitor"
              data-testid="monitor-close"
            >
              <X size={16} />
            </button>
          }
        >
          <Activity size={18} className="text-fg-muted flex-shrink-0" aria-hidden />
          <h1 className="text-sm font-semibold text-fg">Agent Monitor</h1>
        </DetachableSurfaceHeader>

        <LazyMonitor />
      </div>

      {/* The in-app monitor hosts task details too: a row click always opens the
          detail HERE rather than sending the user to the board, so this layer has
          to exist in both hosts. Rendered as a sibling of the overlay panel (not
          inside it) because the layer portals to its own body-level host and
          floats above the monitor's own chrome. */}
      <MonitorDetailLayer />
    </div>
  );
}
