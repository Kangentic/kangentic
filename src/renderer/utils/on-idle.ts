/** Schedule `callback` for a moment the browser considers idle, so heavy but
 *  non-urgent work (warming a lazy chunk) never competes with an in-flight
 *  interaction. Falls back to a short `setTimeout` where `requestIdleCallback`
 *  is unavailable (older WebViews); the callback still runs off the current
 *  task, just without the "only when actually idle" guarantee. */
export function onIdle(callback: () => void): void {
  // requestIdleCallback is typed on Window but genuinely absent at runtime in
  // some browsers (e.g. older WebViews), so guard before calling.
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(callback);
  } else {
    setTimeout(callback, 1);
  }
}
