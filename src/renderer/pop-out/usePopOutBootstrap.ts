import { useEffect } from 'react';
import { useConfigStore } from '../stores/config-store';
import { sharedModuleState } from '../stores/hmr-store-pin';
import { reportRendererFailure } from '../utils/renderer-failure';
import { setTerminalGraphicsSupport } from '../utils/terminal-webgl';
import { createHmrResyncScheduler } from '../utils/hmr-resync-scheduler';
import type { HmrResyncScheduler } from '../utils/hmr-resync-scheduler';
import { getSurface } from './surface-registry';
import type { PopOutDescriptor } from '../../shared/pop-out';

/**
 * The minimal bootstrap a standalone pop-out window needs, in place of App.tsx's
 * full ~700-line bootstrap (board/backlog/session-drag/notification wiring a
 * detached surface never touches).
 *
 * Universal steps (every surface needs them): load config once, and re-load it on a
 * config:changed broadcast so theme/settings edits made in another window sync live
 * here too (config-store's own module-level subscribe re-applies the <html> theme
 * class + localStorage once `config` updates - see config-store.ts). Boot theme
 * itself is already correct via the FOUC inline script in index.html, which reads
 * the shared-origin localStorage entry before React ever mounts.
 *
 * Surface-specific steps delegate to the registered SurfaceDescriptor.
 *
 * StrictMode-safe by construction: every store load this hook (or a surface's
 * bootstrap) triggers is idempotent, and every subscription is torn down via the
 * AbortController on unmount, so a mount -> unmount -> mount double-invoke leaves
 * exactly one live subscription and at most one harmless extra fetch.
 */
/** Re-read the config; a read that fails keeps the config this window has. */
function reloadConfig(): void {
  useConfigStore.getState().loadConfig().catch((error: unknown) => {
    console.error('[usePopOutBootstrap] could not load the config', error);
    reportRendererFailure('pop_out', 'config', error);
  });
}

/** Pull main's graphics status into this page's terminal renderer. */
export function loadTerminalGraphicsSupport(): void {
  window.electronAPI.gpuHealth?.readStatus()
    .then((status) => {
      setTerminalGraphicsSupport(status);
    })
    .catch((error: unknown) => {
      // report-ok: no status leaves WebGL available, which is how a terminal
      // ran before this pull existed; App.tsx swallows the same read.
      console.warn('[usePopOutBootstrap] could not read the graphics status', error);
    });
}

interface PopOutHmrModuleState {
  /**
   * This window's own scheduler, never the main window's shared one: two
   * callers on one scheduler would each replace the other's ask.
   */
  scheduler: HmrResyncScheduler;
  /**
   * What the mounted pop-out root re-syncs after a burst of updates. Null while
   * no root is mounted, which is always so in the main window: the entry imports
   * this module there too.
   */
  resync: (() => void) | null;
}

// One object every evaluation of this module shares, so the listeners a new
// evaluation registers reach the scheduler and the mounted root an earlier one
// left. Pure so a production build, where nothing reads it, drops the call.
const popOutHmrModuleState = /* @__PURE__ */ sharedModuleState<PopOutHmrModuleState>(
  // @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
  import.meta.hot?.data,
  'popOutHmrModuleState',
  () => ({ scheduler: createHmrResyncScheduler(), resync: null }),
);

// This pop-out window's OWN HMR re-sync (Pattern B, scoped to this window). App.tsx's
// module-scope vite:afterUpdate listener runs in this window as well, since the
// entry imports App whether or not it mounts it (measured: one save with a pop-out
// open ran App's re-sync once in each window). That one re-fetches the main
// window's stores; this one covers what the surface itself owns.
//
// Registered at module scope, never in the hook's effect: each evaluation of this
// module gets a new hot context, and Vite's client drops the listeners the old
// one registered (.claude/rules/hmr-patterns.md). An effect also added a listener
// pair and a scheduler on every run, so a StrictMode mount re-synced twice per burst.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // A re-sync an earlier update asked for waits for the update now starting.
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.on('vite:beforeUpdate', () => {
    popOutHmrModuleState.scheduler.holdWhileUpdating();
  });
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.on('vite:afterUpdate', () => {
    // The main window evaluates this module and mounts no pop-out root.
    if (popOutHmrModuleState.resync === null) return;
    // Pattern D (mirrors App.tsx's vite:afterUpdate handler, repeated here so a
    // pop-out does not lean on App's listener): ChangesPanel's file-tree /
    // history resize dividers set the document.body cursor + userSelect on
    // mousedown, cleared only by their own mouseup - never on unmount. A Fast
    // Refresh mid-drag in the 'changes' pop-out window would otherwise leave this
    // window's cursor stuck. Pattern C's generation bump and the other Pattern D
    // cleanups are not repeated here: App's listener runs them in this window
    // too. Kept that way on purpose. Moving App's listener out of pop-out windows
    // would mean wiring each of those here first.
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Pattern B once per burst of updates, as in App.tsx: the cleanup above
    // runs for every update, and the re-sync waits for the last one.
    popOutHmrModuleState.scheduler.schedule(() => {
      // Read when the re-sync runs: the root may have unmounted since the ask.
      popOutHmrModuleState.resync?.();
    });
  });
}

export function usePopOutBootstrap(descriptor: PopOutDescriptor): void {
  const surface = getSurface(descriptor.kind);

  useEffect(() => {
    const controller = new AbortController();

    reloadConfig();

    const offConfigChanged = window.electronAPI.config.onChanged(reloadConfig);
    controller.signal.addEventListener('abort', offConfigChanged);

    // A pop-out hosts terminals too (the Agent Monitor, a Command Terminal), and
    // this page has its own copy of terminal-webgl.ts, so it needs the graphics
    // status App.tsx pulls in the main window, or a terminal here retries WebGL
    // on a machine that cannot have it (DESKTOP-32). Main answers a pop-out
    // without the one-shot recovery notice, which stays the main window's.
    loadTerminalGraphicsSupport();

    surface.bootstrap(descriptor.params, { signal: controller.signal });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- descriptor/surface are boot-constant for this window's lifetime
  }, []);

  // Hand this window's re-sync to the module-scope Vite listeners above, for as
  // long as this root is mounted.
  useEffect(() => {
    // @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
    if (!import.meta.hot) return;
    popOutHmrModuleState.resync = () => {
      reloadConfig();
      surface.hmrResync();
    };
    return () => {
      // A pending ask is kept: Fast Refresh re-runs this effect after the update
      // that asked, and the next run's re-sync answers it.
      popOutHmrModuleState.resync = null;
    };
  }, [surface]);
}
