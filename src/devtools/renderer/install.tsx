import { useEffect } from 'react';
import { useToastStore } from '../../renderer/stores/toast-store';
import { buildPreviewSnapshot, pushToastEntry, readStoreState } from './state-mirror';
import {
  startRendererLagRecorder,
  stopRendererLagRecorder,
  getRendererLagReport,
} from './lag-recorder';
import { getTerminalRendererReport } from '../../renderer/utils/terminal-webgl';
import { readTerminalGrids, readTerminalRendererTrace } from '../../renderer/utils/terminal-grid-registry';

/**
 * Renderer-side bootstrap for the dev-only inspection bridge.
 *
 * Renders nothing visible. Two side-effects:
 *   1. Installs `window.__kangenticPreviewSnapshot` so the inspection
 *      server's `/renderer-state` endpoint can read aggregated Zustand
 *      state via `Runtime.evaluate`.
 *   2. Subscribes to a few stores to populate the ring buffers in
 *      `state-mirror.ts` (toasts, dialogs, IPC errors). These exist so
 *      the snapshot can answer "what just happened?" between polls.
 *
 * Production builds drop this entire module via `__KANGENTIC_DEV__`
 * dead-code elimination behind the conditional render in `App.tsx`.
 */
export function DevtoolsBootstrap(): null {
  useEffect(() => {
    type DevtoolsWindow = Window & {
      __kangenticPreviewSnapshot?: () => unknown;
      __kangenticPreviewStoreState?: (storeName: string, path?: string | null) => unknown;
      __kangenticLagReport?: () => unknown;
      __kangenticTerminalRenderers?: () => unknown;
      __kangenticTerminalGrids?: () => unknown;
      __kangenticTerminalTrace?: () => unknown;
    };
    (window as DevtoolsWindow).__kangenticPreviewSnapshot = buildPreviewSnapshot;
    (window as DevtoolsWindow).__kangenticPreviewStoreState = readStoreState;
    // Every mounted xterm's grid + container geometry, so the terminal-state route
    // can put the renderer's view next to main's PTY dimensions. A PTY/grid
    // mismatch is unrecoverable and was previously invisible from either side
    // alone (see terminal-grid-registry).
    (window as DevtoolsWindow).__kangenticTerminalGrids = readTerminalGrids;
    (window as DevtoolsWindow).__kangenticTerminalTrace = readTerminalRendererTrace;

    // Freeze flight recorder: record renderer event-loop stalls so the
    // inspection server's /event-loop-lag route can surface UI-freeze history.
    startRendererLagRecorder();
    (window as DevtoolsWindow).__kangenticLagReport = getRendererLagReport;

    // Terminal renderer report: exposes each terminal's live renderer type
    // (webgl vs the slow DOM fallback) + context-loss count, so a silently
    // degraded terminal is observable via kangentic_devtools_eval.
    (window as DevtoolsWindow).__kangenticTerminalRenderers = getTerminalRendererReport;

    // Subscribe to the toast store: every push lands in our ring.
    const unsubscribeToast = useToastStore.subscribe((state, prevState) => {
      const previousIds = new Set(
        (prevState.toasts ?? []).map((toast: { id?: string }) => toast.id ?? ''),
      );
      for (const toast of state.toasts ?? []) {
        if (!previousIds.has(toast.id ?? '')) {
          pushToastEntry({
            ts: new Date().toISOString(),
            id: toast.id ?? null,
            message: toast.message ?? null,
            variant: toast.variant ?? null,
          });
        }
      }
    });

    return () => {
      unsubscribeToast();
      stopRendererLagRecorder();
      delete (window as DevtoolsWindow).__kangenticPreviewSnapshot;
      delete (window as DevtoolsWindow).__kangenticPreviewStoreState;
      delete (window as DevtoolsWindow).__kangenticLagReport;
      delete (window as DevtoolsWindow).__kangenticTerminalRenderers;
      delete (window as DevtoolsWindow).__kangenticTerminalGrids;
      delete (window as DevtoolsWindow).__kangenticTerminalTrace;
    };
  }, []);

  return null;
}

