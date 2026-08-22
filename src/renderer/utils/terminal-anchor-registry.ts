/**
 * Which DOM element is drawing each session's terminal, so a floating surface
 * can be positioned against it.
 *
 * The dictation chip is the only consumer today, and it needs an answer no other
 * registry gives. `terminal-mount-registry.ts` publishes WHICH sessions are held
 * (a refcount, no elements). `terminal-grid-registry.ts` does hold the xterm
 * instances, but it is `__KANGENTIC_DEV__`-gated and compiles away in a shipped
 * build, so nothing user-facing may depend on it. Hence a third, deliberately
 * tiny one.
 *
 * Registered from `initTerminal` alongside the mount registration, because that
 * is the one place that runs per xterm construction and holds both the session
 * id and `terminal.element`.
 */

/** Registrations for one session, in mount order. A session legitimately has
 *  more than one: an inactive bottom-panel pane plus a detail window mid-handoff,
 *  or a pane retained for a backgrounded project. */
// hmr-safe: rebuilt from scratch on the next mount. Unlike the mount registry,
// nothing outside this module reads it across a reload, and a stale entry here
// would be WORSE than an empty one - it would anchor the chip to a disposed node.
const anchorsBySession = new Map<string, HTMLElement[]>();

/**
 * Register the element drawing this session's terminal. Returns the release for
 * the mount's cleanup.
 */
export function registerTerminalAnchor(
  sessionId: string | null,
  element: HTMLElement | null,
): () => void {
  if (!sessionId || !element) return () => { /* nothing to anchor to */ };
  const existing = anchorsBySession.get(sessionId);
  if (existing) existing.push(element);
  else anchorsBySession.set(sessionId, [element]);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = anchorsBySession.get(sessionId);
    if (!current) return;
    const index = current.indexOf(element);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) anchorsBySession.delete(sessionId);
  };
}

/**
 * The element currently drawing this session's terminal, or null.
 *
 * Walks the registrations BACKWARDS, so the most recently mounted surface wins
 * when a session is held twice. That is the right tiebreak for a floating
 * surface: the newer mount is the one that just took the session over (a detail
 * window opening evicts the bottom panel's view of it), while the older one is
 * typically parked or retained.
 *
 * Skips anything detached or zero-sized. A retained pane (hidden at
 * `opacity: 0` for a backgrounded project) still measures non-zero, so it is
 * filtered by the caller's own bounds check rather than here - this function
 * answers "where is it drawn", not "should it win".
 */
export function resolveTerminalAnchorElement(sessionId: string | null): HTMLElement | null {
  if (!sessionId) return null;
  const candidates = anchorsBySession.get(sessionId);
  if (!candidates) return null;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const element = candidates[index];
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return element;
  }
  return null;
}
