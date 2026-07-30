import { useConfigStore } from '../../stores/config-store';
import { useMonitorStore } from '../../stores/monitor-store';
import { useSessionStore } from '../../stores/session-store';
import { PopOutMonitorRoot } from '../roots/PopOutMonitorRoot';
import type { SurfaceDescriptor } from '../surface-registry';

export const monitorSurface: SurfaceDescriptor<'monitor'> = {
  kind: 'monitor',
  Root: PopOutMonitorRoot,

  bootstrap: (_params, { signal }) => {
    // This window has its OWN store instances, so it must seed both the persisted
    // view preference and the first snapshot itself - nothing carries over from
    // the main window.
    const monitor = useMonitorStore.getState();
    monitor.hydrateView(useConfigStore.getState().config.monitor);
    monitor.open();

    // Seed the SESSION store too, not just the monitor's rows.
    //
    // The rows come from main's aggregator, but a task detail hosted in this
    // window resolves its session from `session-store.sessions`
    // (`useTaskSessionState`), and this renderer's copy of that store starts
    // empty - nothing carries over from the main window. Without this the detail
    // mounts, finds no session, and renders the no-session description branch
    // instead of the agent's terminal.
    //
    // `sessions.list()` is deliberately unscoped (it serves the sidebar's
    // cross-project counts), which is exactly what a cross-project host needs.
    void useSessionStore.getState().syncSessions();

    // Live activity is patched onto rows without a refetch, exactly as in the main
    // window. SESSION_ACTIVITY is declared in this surface's `channels`, so main
    // fans it out to this window directly.
    const unsubscribeActivity = window.electronAPI.sessions.onActivity((sessionId, state, reason) => {
      useMonitorStore.getState().applyActivity(sessionId, state, reason ?? null);
    });
    signal.addEventListener('abort', unsubscribeActivity);

    // Snapshot pushes for the DB-resident half (session spawned/exited, task
    // retitled or moved).
    const unsubscribeChanged = window.electronAPI.monitor.onChanged((snapshot) => {
      useMonitorStore.getState().applySnapshot(snapshot);
      // This push fires precisely when a session spawned, changed status, or
      // exited, which is exactly when the session list this window holds goes
      // stale. Riding it keeps a hosted task detail's terminal bound to the live
      // session without a second subscription or a timer.
      void useSessionStore.getState().syncSessions();
    });
    signal.addEventListener('abort', unsubscribeChanged);

    // Keep the view in sync when it is changed from the main window. Subscribe to
    // the config STORE, not the config:changed IPC event: usePopOutBootstrap
    // already handles that event by kicking off an async loadConfig(), so a second
    // IPC subscriber would read config.monitor while that reload is still in
    // flight and hydrate the PRE-change value. Waiting for the store to actually
    // update is the race-free version.
    const unsubscribeConfig = useConfigStore.subscribe((state, previous) => {
      if (state.config.monitor === previous.config.monitor) return;
      useMonitorStore.getState().hydrateView(state.config.monitor);
    });
    signal.addEventListener('abort', unsubscribeConfig);
  },

  hmrResync: () => {
    void useMonitorStore.getState().loadSnapshot();
  },

  inAppSurface: 'monitor-overlay',
};
