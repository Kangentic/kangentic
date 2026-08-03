/**
 * Mirrors main's "which sessions does a phone stream the TERMINAL of" push
 * into the session store.
 *
 * Terminal ownership is one xterm per PTY, and a phone-streamed session's
 * grid is owned by the resting park (a phone mirrors the PTY 1:1 and cannot
 * escape a strip-shaped fit). The bottom panel therefore renders a
 * placeholder instead of an xterm for these sessions - a panel xterm fitting
 * them to its ~14-row strip is what produced both the phone's sliver view
 * and the panel's own mis-wrapped frames (observed live 2026-08-02). A
 * task-detail window still mounts a real terminal: the detail is the primary
 * surface, and its grid wins while it is open.
 *
 * Only main can answer this (subscriptions live in the mobile bridge), so
 * main pushes every change and the mount does one initial fetch to cover a
 * renderer that loads after the phone already subscribed.
 *
 * Mounted in `AppLayout` - the main window is the only renderer with a
 * bottom panel to protect, mirroring `useRemoteDetailOwnersSync`.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';

function applyIfChanged(sessionIds: string[]): void {
  // Write only on a real membership change: this re-publishes the focused
  // set and re-renders every panel consumer, so a same-set push must be free.
  const current = useSessionStore.getState().mobileTerminalStreamedSessionIds;
  const incoming = new Set(sessionIds);
  const same = current.length === sessionIds.length && current.every((sessionId) => incoming.has(sessionId));
  if (!same) useSessionStore.setState({ mobileTerminalStreamedSessionIds: sessionIds });
}

export function useMobileTerminalStreamsSync(): void {
  useEffect(() => {
    const mobile = window.electronAPI?.mobile;
    if (!mobile?.onTerminalStreamsChanged) return;
    let cancelled = false;
    void mobile.getTerminalStreams?.().then((sessionIds) => {
      if (!cancelled && Array.isArray(sessionIds)) applyIfChanged(sessionIds);
    }).catch(() => {
      // Best-effort seed; the change push corrects it on the next subscribe.
    });
    const unsubscribe = mobile.onTerminalStreamsChanged((sessionIds) => applyIfChanged(sessionIds));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
