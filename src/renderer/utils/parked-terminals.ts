/**
 * Parked-terminal registry: which sessions' terminals are currently off-view
 * (their window layer is parked on the Backlog view, or a maximized window in
 * the same layer covers them).
 *
 * The coordinator (useFocusedSessionsSync) derives the parked set from the
 * window-manager stores and publishes it here. Consumers:
 *
 * - useTerminal's incoming write queue reads `isTerminalParked` in its
 *   `shouldDrop` gate, so a parked terminal acks-and-discards inbound PTY bytes
 *   instead of parsing them (the bytes are not lost: the main process keeps
 *   accumulating them in the per-session scrollback ring).
 * - useTerminal subscribes to `onTerminalReveal` and repaints from scrollback
 *   (`reloadScrollback`) when its session transitions parked -> visible.
 *
 * Reveal notifications are edge-triggered (fired only for sessions that were
 * parked in the previous sync and are not in the new one), so republishing an
 * unchanged set never causes reload storms.
 *
 * This mirrors the board-drag gate in session-update-coalescer.ts: a module
 * predicate plus a notify-listener set, with reset-on-HMR being harmless.
 */

// Preserved across HMR (Pattern A, mirroring terminal-capture-registry.ts and
// useTerminal.ts's savedScrollPositions). A components-only Fast Refresh does
// NOT remount an already-mounted useTerminal (its effect deps are unchanged),
// so resetting these registries would orphan every already-registered reveal
// listener in the discarded module instance - the parked terminal would then
// never get its scrollback catch-up on reveal. Preserve the live Set/Map.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const parkedSessionIds: Set<string> = import.meta.hot?.data?.parkedSessionIds ?? new Set<string>();
// @ts-expect-error -- Vite handles import.meta.hot
const revealListenersBySession: Map<string, Set<() => void>> = import.meta.hot?.data?.revealListenersBySession ?? new Map();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.parkedSessionIds = parkedSessionIds;
    data.revealListenersBySession = revealListenersBySession;
  });
}

/** True while `sessionId`'s terminal is parked off-view. */
export function isTerminalParked(sessionId: string): boolean {
  return parkedSessionIds.has(sessionId);
}

/**
 * Replace the parked set. Fires the reveal listeners of every session that
 * transitioned parked -> visible; newly parked and still-parked sessions fire
 * nothing.
 */
export function syncParkedTerminals(parked: ReadonlySet<string>): void {
  const revealed: string[] = [];
  for (const sessionId of parkedSessionIds) {
    if (!parked.has(sessionId)) revealed.push(sessionId);
  }

  parkedSessionIds.clear();
  for (const sessionId of parked) parkedSessionIds.add(sessionId);

  for (const sessionId of revealed) {
    const listeners = revealListenersBySession.get(sessionId);
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

/** Subscribe to `sessionId`'s parked -> visible edge. Returns an unsubscribe. */
export function onTerminalReveal(sessionId: string, listener: () => void): () => void {
  let listeners = revealListenersBySession.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    revealListenersBySession.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    const registered = revealListenersBySession.get(sessionId);
    if (!registered) return;
    registered.delete(listener);
    if (registered.size === 0) revealListenersBySession.delete(sessionId);
  };
}
