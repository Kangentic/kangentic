import { useSyncExternalStore } from 'react';

/** The window's device pixel ratio, or 1 where there is none. */
function readDevicePixelRatio(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

// hmr-safe: the components subscribed right now and the one resolution query they share. A
// re-evaluation starts both empty; every mounted subscriber subscribes again because `subscribe`
// is a new function, and the old module's query stops when its last subscriber leaves.
const subscribers = new Set<() => void>();
let stopWatching: (() => void) | null = null;

/**
 * Watch for the ratio changing (a window moving to another monitor, or a zoom). A
 * `(resolution: Ndppx)` query matches exactly one ratio, so it fires `change` when the
 * ratio leaves it, and the watch moves to the new ratio.
 */
function watchResolution(): void {
  const query = window.matchMedia(`(resolution: ${readDevicePixelRatio()}dppx)`);
  const onChange = (): void => {
    stopWatching?.();
    watchResolution();
    subscribers.forEach((notify) => notify());
  };
  query.addEventListener('change', onChange);
  stopWatching = () => query.removeEventListener('change', onChange);
}

/** The store's subscribe, exported so a unit test can drive the shared query without React. */
export function subscribeToDevicePixelRatio(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1 && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    watchResolution();
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      stopWatching?.();
      stopWatching = null;
    }
  };
}

/**
 * The window's device pixel ratio, re-read when it changes. Every caller shares one
 * media query, so a board of cards that each draw a priority meter adds one listener,
 * not one per card.
 */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeToDevicePixelRatio,readDevicePixelRatio, () => 1);
}
