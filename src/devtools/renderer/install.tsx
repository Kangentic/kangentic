import { useEffect } from 'react';
import { useToastStore } from '../../renderer/stores/toast-store';
import { buildPreviewSnapshot, pushToastEntry, readStoreState } from './state-mirror';
import {
  startRendererLagRecorder,
  stopRendererLagRecorder,
  getRendererLagReport,
} from './lag-recorder';

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
    };
    (window as DevtoolsWindow).__kangenticPreviewSnapshot = buildPreviewSnapshot;
    (window as DevtoolsWindow).__kangenticPreviewStoreState = readStoreState;

    // Freeze flight recorder: record renderer event-loop stalls so the
    // inspection server's /event-loop-lag route can surface UI-freeze history.
    startRendererLagRecorder();
    (window as DevtoolsWindow).__kangenticLagReport = getRendererLagReport;

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
    };
  }, []);

  return null;
}

