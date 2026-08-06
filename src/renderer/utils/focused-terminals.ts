/**
 * Focused-terminal registry: which sessions the renderer last published to main
 * as focused, and a per-session edge for the moment one regains focus.
 *
 * Why this exists, separately from `parked-terminals.ts`:
 *
 * Main forwards PTY data over IPC only for sessions in its focused union
 * (`SessionManager`'s `onFlush` gate). Everything else accumulates silently in
 * the scrollback ring, which is fine as long as SOMETHING repaints the grid when
 * the session starts being watched again. Until now the only catch-up was
 * `onTerminalReveal`, which fires on the PARKED edge - so the repair covered
 * only sessions that lost focus BY being parked.
 *
 * `deriveFocusedSessionIds` drops sessions for reasons that have nothing to do
 * with parking: a task detail owned by a detached monitor window
 * (`remotelyOwnedSessionIds`), the bottom panel being hidden, the command bar
 * closing on transient sessions. Each of those left a session unfocused, and
 * therefore un-fed, with no path back to a correct grid until an unrelated
 * resize or remount happened to repaint it.
 *
 * Focus loss is the strictly wider condition (parking implies unfocus, not the
 * reverse), so this edge is the general repair and the reveal edge is the
 * special case. Both are kept: only parking additionally makes the renderer's
 * incoming queue ack-and-discard, so the two registries answer different
 * questions and neither subsumes the other.
 *
 * Edge-triggered like the parked registry: republishing an unchanged set fires
 * nothing, so the steady-state cost is one Set comparison per publish.
 */

import { traceTerminalRenderer } from './terminal-grid-registry';

// Preserved across HMR (Pattern A), for exactly the reason parked-terminals.ts
// documents: a components-only Fast Refresh does not remount an already-mounted
// useTerminal, so resetting these would orphan every registered listener in the
// discarded module instance and silently disable the catch-up.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const focusedSessionIds: Set<string> = import.meta.hot?.data?.focusedSessionIds ?? new Set<string>();
// @ts-expect-error -- Vite handles import.meta.hot
const refocusListenersBySession: Map<string, Set<() => void>> = import.meta.hot?.data?.refocusListenersBySession ?? new Map();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.focusedSessionIds = focusedSessionIds;
    data.refocusListenersBySession = refocusListenersBySession;
  });
}

/** True while `sessionId` was in the last published focused set. */
export function isTerminalFocused(sessionId: string): boolean {
  return focusedSessionIds.has(sessionId);
}

/**
 * Compute the sessions that transition unfocused -> focused between two sets.
 *
 * Pure and exported so the edge semantics are unit-testable without a live
 * registry, and so the caller can see that a first publish (empty previous set)
 * deliberately reports every session as regaining focus.
 *
 * That is left to the CONSUMER to absorb rather than special-cased here, because
 * a "first publish" flag would be module state that tests then have to reset and
 * HMR has to preserve, for a case the consumer already handles better: a
 * terminal that has not mounted registers no listener at all, and one that is
 * mid-mount-replay skips the catch-up because a replay is already painting it.
 */
export function computeRefocused(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): string[] {
  const refocused: string[] = [];
  for (const sessionId of next) {
    if (!previous.has(sessionId)) refocused.push(sessionId);
  }
  return refocused;
}

/**
 * Replace the focused set. Fires the listeners of every session that
 * transitioned unfocused -> focused; newly unfocused and still-focused sessions
 * fire nothing.
 */
export function syncFocusedTerminals(focused: ReadonlySet<string>): void {
  const refocused = computeRefocused(focusedSessionIds, focused);
  const unfocused: string[] = [];
  for (const sessionId of focusedSessionIds) {
    if (!focused.has(sessionId)) unfocused.push(sessionId);
  }

  focusedSessionIds.clear();
  for (const sessionId of focused) focusedSessionIds.add(sessionId);

  // Traced on both edges: losing focus is the moment main stops feeding this
  // session, and regaining it is the moment the catch-up replay fires. Neither
  // was visible in the merged timeline before.
  for (const sessionId of unfocused) traceTerminalRenderer(sessionId, 'terminal-unfocus');
  for (const sessionId of refocused) traceTerminalRenderer(sessionId, 'terminal-refocus');

  for (const sessionId of refocused) {
    const listeners = refocusListenersBySession.get(sessionId);
    if (!listeners) continue;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One throwing listener must not block the others.
      }
    }
  }
}

/** Subscribe to `sessionId`'s unfocused -> focused edge. Returns an unsubscribe. */
export function onTerminalRefocus(sessionId: string, listener: () => void): () => void {
  let listeners = refocusListenersBySession.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    refocusListenersBySession.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    const registered = refocusListenersBySession.get(sessionId);
    if (!registered) return;
    registered.delete(listener);
    if (registered.size === 0) refocusListenersBySession.delete(sessionId);
  };
}
