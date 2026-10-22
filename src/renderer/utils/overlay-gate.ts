import { useEffect, useSyncExternalStore } from 'react';

/**
 * Which modal overlays are open: a dialog (`BaseDialog`), the settings panel,
 * the search palette. The toast stack reads it to stop taking clicks while one
 * is open. Toasts sit above dialogs in the bottom right, exactly where a
 * centred dialog's footer is, and a card that took clicks there once swallowed
 * the Board Manager's Save.
 *
 * Registration, not a DOM query: an overlay opened by keyboard while the
 * pointer rests over a toast must close the gate before the next click, and a
 * check made only when the pointer moves would miss it.
 *
 * Kept across a Fast Refresh (Pattern A): an overlay registers on mount, so a
 * re-evaluated module with a fresh set would read "nothing open" under a
 * dialog that is still up.
 */

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const openOverlays: Set<symbol> = import.meta.hot?.data?.openOverlays ?? new Set<symbol>();
// @ts-expect-error -- Vite handles import.meta.hot
const listeners: Set<() => void> = import.meta.hot?.data?.overlayGateListeners ?? new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function anyOverlayOpen(): boolean {
  return openOverlays.size > 0;
}

/** Counts the calling overlay as open for as long as it is mounted (and `active`). */
export function useRegisterOpenOverlay(active = true): void {
  useEffect(() => {
    if (!active) return;
    const token = Symbol('overlay');
    openOverlays.add(token);
    notify();
    return () => {
      openOverlays.delete(token);
      notify();
    };
  }, [active]);
}

/** Whether any modal overlay is open, kept current as they open and close. */
export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, anyOverlayOpen, anyOverlayOpen);
}

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.openOverlays = openOverlays;
    data.overlayGateListeners = listeners;
  });
}
