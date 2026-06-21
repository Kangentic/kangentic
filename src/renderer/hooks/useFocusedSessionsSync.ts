import { useEffect } from 'react';
import { useSessionStore } from '../stores/session-store';
import { useBoardStore } from '../stores/board-store';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import { deriveFocusedSessionIds, derivePanelSessionId } from '../utils/focused-sessions';

/**
 * Pushes the set of "focused" session IDs to the main process whenever the
 * relevant UI state changes. The main process drops PTY data IPC for any
 * session not in this set (see src/main/pty/session-manager.ts), so any
 * terminal visible to the user must be listed here or its output will be
 * silently suppressed.
 *
 * This must live in an always-mounted component (AppLayout). Previously this
 * effect lived inside TerminalPanel, which is unmounted on the Backlog view -
 * causing the command bar overlay opened from Backlog to freeze because the
 * transient session was never added to the focused set.
 *
 * Resolves the panel's focused session from the running-sessions list
 * directly (rather than trusting `activeSessionId`), matching the
 * TerminalPanel render-time derivation so that a stale `activeSessionId`
 * (pointing at a session that just exited) doesn't leak into the focused
 * set for the ~1-render-cycle window before TerminalPanel syncs the store.
 *
 * The derivation logic is extracted into pure helpers in
 * src/renderer/utils/focused-sessions.ts for unit testability.
 */
export function useFocusedSessionsSync(): void {
  const activeView = useBoardStore((s) => s.activeView);
  const terminalPanelVisible = useConfigStore((s) => s.config.terminalPanelVisible);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const dialogSessionIds = useSessionStore((s) => s.dialogSessionIds);
  const commandBarVisible = useSessionStore((s) => s.commandBarVisible);
  const transientSessionId = useSessionStore((s) => s.transientSessionId);

  // Single derived selector: returns the primitive panel session id. The
  // selector body runs on every store change (O(N) over running sessions),
  // but Zustand's Object.is comparison on the string|null result means the
  // hook only re-renders when the resolved id actually changes. This avoids
  // re-rendering AppLayout on every sessionActivity push.
  const panelSessionId = useSessionStore((s) =>
    derivePanelSessionId({
      activeSessionId: s.activeSessionId,
      sessions: s.sessions,
      currentProjectId,
      sessionActivity: s.sessionActivity,
    }),
  );

  useEffect(() => {
    const focusedIds = deriveFocusedSessionIds({
      activeView,
      terminalPanelVisible,
      panelSessionId,
      dialogSessionIds,
      commandBarVisible,
      transientSessionId,
    });

    window.electronAPI.sessions.setFocused(focusedIds);
  }, [activeView, terminalPanelVisible, panelSessionId, dialogSessionIds, commandBarVisible, transientSessionId]);
}
