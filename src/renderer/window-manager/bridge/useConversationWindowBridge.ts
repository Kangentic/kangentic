/**
 * Bridges the renderer's single "which conversation is open" signal
 * (`session-store.conversationSessionId`) to a managed window on the board
 * task-detail layer. Mirrors `useTaskDetailWindowBridge`: every entry point
 * (search palette conversation hit, the completed task view's "View conversation"
 * button, task-detail kebab) calls `setConversationSessionId`; this hook turns that into
 * an `openWindow` of kind 'conversation' anchored on the session id, focusing an
 * existing window for the same session instead of duplicating. It also mirrors a
 * window close back to clearing the signal.
 *
 * The signal means "open/focus this conversation now", not "this window should
 * exist" - existence is owned by the workspace blob (`serializeWorkspace` /
 * `restoreWorkspaceForProject`), same as task-detail windows. So a cleared
 * signal (e.g. a project switch nulling it) does NOT close the window here;
 * `useProjectSwitchEffect` closes the outgoing project's conversation windows
 * explicitly, after persisting them, so a restored one is never mistaken for
 * an untracked ghost.
 *
 * Mounted once by `WindowLayer` alongside the task-detail bridge.
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useWindowStore } from '../store/window-store';

export function useConversationWindowBridge(): void {
  const conversationSessionId = useSessionStore((state) => state.conversationSessionId);
  // Every open request bumps this, so asking again for a conversation that is
  // already open (a second Route pill) re-runs the effect below and switches
  // the window's tab. `?? 0`: an instance pinned across a Fast Refresh predates it.
  const conversationRequestId = useSessionStore((state) => state.conversationRequestId ?? 0);
  const windows = useWindowStore((state) => state.windows);

  // The window id we opened for the current signal, so the mirror effect can
  // detect when the user closed THAT window and clear the signal.
  const conversationWindowIdRef = useRef<string | null>(null);

  // Open (or focus) a window for the current `conversationSessionId`. Other open
  // windows (task-detail or other conversations) are left untouched.
  useEffect(() => {
    if (!conversationSessionId) {
      // Signal cleared (e.g. a project switch nulls it): the window's existence
      // is not tied to this signal (see header comment), so just drop the ref -
      // leave the window open if one is.
      conversationWindowIdRef.current = null;
      return;
    }
    const windowStore = useWindowStore.getState();

    // Adoption signal for the viewer, whichever entry point raised the signal;
    // main dedups to once per day.
    window.electronAPI?.analytics?.trackFeatureUsed('conversation_viewer');

    // `openWindow` focuses an existing window for this session instead of
    // duplicating, and hands it the tab this open asked for. The tab is a
    // one-shot, cleared once handed over, so a later re-run of this effect (a
    // remount, a project switch that keeps the signal) never asks again.
    const conversationTab = useSessionStore.getState().conversationTab ?? undefined;
    conversationWindowIdRef.current = windowStore.openWindow({
      kind: 'conversation',
      anchor: conversationSessionId,
      sessionId: conversationSessionId,
      title: 'Conversation',
      conversationTab,
    });
    if (conversationTab) useSessionStore.setState({ conversationTab: null });
  }, [conversationSessionId, conversationRequestId]);

  // Mirror window closure back to the signal: when the conversation window we
  // opened is gone (closed via the title bar / Escape), clear the signal.
  useEffect(() => {
    if (!conversationSessionId) return;
    const id = conversationWindowIdRef.current;
    if (!id) return;
    if (!useWindowStore.getState().windows[id]) {
      conversationWindowIdRef.current = null;
      useSessionStore.getState().setConversationSessionId(null);
    }
  }, [windows, conversationSessionId]);
}
