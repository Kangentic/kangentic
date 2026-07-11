import { useEffect } from 'react';
import { useConfigStore } from '../stores/config-store';
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
export function usePopOutBootstrap(descriptor: PopOutDescriptor): void {
  const surface = getSurface(descriptor.kind);

  useEffect(() => {
    const controller = new AbortController();

    void useConfigStore.getState().loadConfig();

    const offConfigChanged = window.electronAPI.config.onChanged(() => {
      void useConfigStore.getState().loadConfig();
    });
    controller.signal.addEventListener('abort', offConfigChanged);

    surface.bootstrap(descriptor.params, { signal: controller.signal });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- descriptor/surface are boot-constant for this window's lifetime
  }, []);

  // This pop-out root's OWN HMR re-sync (Pattern B, scoped to this window - App.tsx's
  // vite:afterUpdate handler never runs here since the pop-out never mounts App).
  useEffect(() => {
    // @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
    if (!import.meta.hot) return;
    // @ts-expect-error -- Vite handles import.meta.hot
    import.meta.hot.on('vite:afterUpdate', () => {
      // Pattern D (mirrors App.tsx's vite:afterUpdate handler, which never runs in a
      // pop-out window): ChangesPanel's file-tree / history resize dividers set the
      // document.body cursor + userSelect on mousedown, cleared only by their own
      // mouseup - never on unmount. A Fast Refresh mid-drag in the 'changes' pop-out
      // window would otherwise leave this window's cursor stuck. No <DndContext> lives
      // in any pop-out surface yet, so Pattern C's generation bump is intentionally
      // not wired here; add it before any surface adopts a stateful third-party subtree.
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      void useConfigStore.getState().loadConfig();
      surface.hmrResync();
    });
  }, [surface]);
}
