/**
 * Which Browser pane a mouse back/forward gesture should navigate.
 *
 * The gesture and the history live in different places. A pane owns its own
 * `<webview>` and history, and the press is seen by window-level listeners
 * (`useBrowserMouseNavigation`, and `useDictation` for a button push-to-talk
 * holds). A registry is the seam: panes publish "here is how to go back", and
 * the gesture owner asks.
 *
 * Each renderer has its own registry, so a pane in a pop-out window registers
 * in that window's renderer, which is the one main sends its guest's buttons to.
 *
 * WHY PUSH-TO-TALK SHARES THE BUTTON. Mouse:Back is push-to-talk AND the
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
  /** The pane's guest `webContentsId`, or null before its guest attaches. */
  webContentsId: () => number | null;
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

/**
 * The pane whose guest reported a press, for a press main forwarded from inside
 * a page. The event names its guest, so this does not depend on the host having
 * seen hover or focus on the pane, which a window just brought forward may not
 * have.
 *
 * With no pane holding that guest, only a hovered or focused pane that has not
 * learned its own guest id yet can be the sender. A pane that holds a different
 * guest never is: main sends a release for a guest destroyed mid-press after
 * its pane has unregistered, and that release must not navigate another pane.
 */
export function resolveBrowserNavigationTargetForGuest(webContentsId: number): BrowserNavigationTarget | null {
  for (const pane of panes) {
    if (pane.webContentsId() === webContentsId) return pane;
  }
  for (const pane of panes) {
    if (pane.webContentsId() === null && pane.isActive()) return pane;
  }
  return null;
}
