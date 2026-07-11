import { useEffect } from 'react';
import { ChartColumn, X } from 'lucide-react';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useConfigStore } from '../../stores/config-store';
import { useUsageDashboardStore } from '../../stores/usage-dashboard-store';
import { DetachableSurfaceHeader } from '../../pop-out/DetachableSurfaceHeader';
import { StatsDashboardBody } from './StatsDashboardBody';

/**
 * The usage statistics dashboard: a full-surface overlay between the title
 * bar and status bar (above the board window layer at z-40, below the
 * command terminal layer at z-[45] and dialogs at z-50). Opened from the
 * title-bar chart button or Mod+Shift+U; Escape closes (unless the Settings
 * drawer is open on top). The shell paints immediately - data arrives via
 * the store's stale-while-revalidate cache, and live updates stream in
 * through the usage-push debounce + poll inside StatsDashboardBody, animating
 * in place.
 *
 * The pop-out button detaches this surface into its own OS window
 * (PopOutStatsRoot, sharing StatsDashboardBody so the live pipeline is
 * identical in both hosts). AppLayout suppresses this overlay's mount
 * whenever the stats pop-out is open (strict mutual exclusivity).
 */
export function StatsPage() {
  const close = useUsageDashboardStore((state) => state.close);
  const statusBarVisible = useConfigStore((state) => state.config.statusBarVisible !== false);

  const overlay = useOverlayPhase(close, { variant: 'panel', skipEnterOnHmr: true });

  // Structural Escape (the documented dialog-Escape exception to the
  // keybindings registry). Bubble phase so popovers' capture-phase Escape
  // wins first; gated so the Settings drawer stacked above keeps its own.
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
      data-testid="stats-page"
    >
      <div
        className={`h-full bg-surface border-t border-edge flex flex-col ${overlay.contentClassName}`}
        onAnimationEnd={overlay.onAnimationEnd}
      >
        {/* Shared detachable-surface header: identity (chart + Usage) on the left,
            the pop-out control in its predictable top-right slot, then the overlay
            close button. The surface's own toolbar (scope / metric / period) lives
            inside StatsDashboardBody below, never mixed into this header. */}
        <DetachableSurfaceHeader
          kind="stats"
          params={{}}
          className="px-4 py-2.5"
          trailing={
            <button
              type="button"
              onClick={() => overlay.requestClose()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Close (Esc)"
              aria-label="Close usage stats"
              data-testid="stats-close"
            >
              <X size={16} />
            </button>
          }
        >
          <ChartColumn size={18} className="text-fg-muted flex-shrink-0" aria-hidden />
          <h1 className="text-sm font-semibold text-fg">Usage</h1>
        </DetachableSurfaceHeader>

        <StatsDashboardBody />
      </div>
    </div>
  );
}
