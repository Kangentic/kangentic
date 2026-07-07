/**
 * Bridges the renderer's single "which conversation is open" signal
 * (`session-store.conversationSessionId`) to a managed window on the board
 * task-detail layer. Mirrors `useTaskDetailWindowBridge`: every entry point
 * (search palette conversation hit, session-summary "View conversation" button,
 * task-detail kebab) calls `setConversationSessionId`; this hook turns that into
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

    // Focus an existing conversation window for this session instead of duplicating.
    const existing = Object.values(windowStore.windows).find(
      (candidate) => candidate.kind === 'conversation' && candidate.anchor === conversationSessionId,
    );
    if (existing) {
      windowStore.focusWindow(existing.id);
      conversationWindowIdRef.current = existing.id;
      return;
    }

    conversationWindowIdRef.current = windowStore.openWindow({
      kind: 'conversation',
      anchor: conversationSessionId,
      sessionId: conversationSessionId,
      title: 'Conversation',
    });
  }, [conversationSessionId]);

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
