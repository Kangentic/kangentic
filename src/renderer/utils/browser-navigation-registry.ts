/**
 * Which Browser pane a mouse back/forward gesture should navigate.
 *
 * This exists because the two halves of the gesture live in different places.
 * `useDictation` owns the mouse-back button globally (it is the push-to-talk
 * binding), so it is the only code that can tell a TAP from a HOLD - and a pane
 * owns its own `<webview>` and history. A registry is the seam: panes publish
 * "I am the active one, here is how to go back", and the gesture owner asks.
 *
 * WHY THE GESTURE IS SPLIT THAT WAY. Mouse:Back is push-to-talk AND the
 * near-universal browser Back button, and the user wants both. They are
 * separable because push-to-talk is a HOLD: a tap under the threshold produces
 * an utterance too short to transcribe into anything, so it was already dead
 * input and is free to mean navigation. Dictation still starts on press, so no
 * audio is lost at the front of a real hold; a short release cancels it and
 * navigates instead.
 */

export interface BrowserNavigationTarget {
  /** True when this pane is the one the gesture should act on: the pointer is
   *  over it, or focus is inside it. */
  isActive: () => boolean;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
}

// hmr-safe: rebuilt by each pane's own registration effect on the next render,
// and a stale entry here would navigate a pane that no longer exists.
const panes = new Set<BrowserNavigationTarget>();

/** Register a pane as a mouse-navigation target. Returns its unregister. */
export function registerBrowserNavigationTarget(target: BrowserNavigationTarget): () => void {
  panes.add(target);
  return () => { panes.delete(target); };
}

/**
 * The pane a back/forward gesture belongs to, or null when the pointer and focus
 * are both somewhere else entirely.
 *
 * More than one pane can be mounted (a second task's window, a pane retained for
 * a backgrounded project), so "active" is asked of each rather than assumed.
 *
 * First match wins, and that IS the tiebreak rather than a claim of exclusivity:
 * `isActive` is hovered OR focus-inside, so one pane hovered while a different
 * one holds focus makes both answer yes, and registration order (mount order)
 * decides. A gesture is aimed with the pointer far more often than with focus,
 * so if this ever needs a real precedence rule, hover should win over focus.
 */
export function resolveBrowserNavigationTarget(): BrowserNavigationTarget | null {
  for (const pane of panes) {
    if (pane.isActive()) return pane;
  }
  return null;
}
