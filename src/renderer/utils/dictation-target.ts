import { boardWindowManager, commandWindowManager } from '../window-manager';
import { useSessionStore } from '../stores/session-store';
import { useProjectStore } from '../stores/project-store';
import { derivePanelSessionId } from './focused-sessions';

/**
 * Resolving the ONE terminal that dictated text should be injected into. The
 * renderer owns single-active-terminal truth across three surfaces (the bottom
 * panel, task-detail windows, and Command Terminal windows); the main process
 * only tracks a focused SET. So we resolve here and pass the chosen session id
 * explicitly on the commit IPC, and refuse to guess when nothing resolves.
 */

// Last terminal whose xterm gained focus, across all layers. The window-manager
// focus only covers windowed terminals; this catches the bottom-panel terminal
// and a terminal the user clicked without opening a window. Preserved across a
// Fast Refresh so a reload mid-dictation keeps the target.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let lastFocusedTerminalSessionId: string | null = import.meta.hot?.data?.lastFocusedTerminalSessionId ?? null;

export function noteTerminalFocus(sessionId: string | null): void {
  if (sessionId) lastFocusedTerminalSessionId = sessionId;
}

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.lastFocusedTerminalSessionId = lastFocusedTerminalSessionId;
  });
}

/** True only when the id names a session the manager currently has running. */
function isRunningSession(sessionId: string | null): sessionId is string {
  if (!sessionId) return false;
  return useSessionStore
    .getState()
    .sessions.some((session) => session.id === sessionId && session.status === 'running');
}

/** The session id owned by a window layer's currently focused window, if any. */
function focusedWindowSessionId(manager: typeof boardWindowManager): string | null {
  const state = manager.store.getState();
  const focusedId = state.focusedWindowId;
  if (!focusedId) return null;
  return state.windows[focusedId]?.sessionId ?? null;
}

/**
 * Resolve the single injection target via a priority chain. Returns null when
 * no live terminal can be determined, so the caller can refuse to commit rather
 * than inject into the wrong terminal.
 */
export function resolveDictationTarget(): string | null {
  // 1. The focused Command Terminal window.
  const commandTarget = focusedWindowSessionId(commandWindowManager);
  if (isRunningSession(commandTarget)) return commandTarget;

  // 2. The focused task-detail (board) window.
  const boardTarget = focusedWindowSessionId(boardWindowManager);
  if (isRunningSession(boardTarget)) return boardTarget;

  // 3. The last terminal the user focused anywhere.
  if (isRunningSession(lastFocusedTerminalSessionId)) return lastFocusedTerminalSessionId;

  // 4. The bottom panel's derived session.
  const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
  const sessionState = useSessionStore.getState();
  const panelSessionId = derivePanelSessionId({
    activeSessionId: sessionState.activeSessionId,
    sessions: sessionState.sessions,
    currentProjectId,
    sessionActivity: sessionState.sessionActivity,
  });
  if (isRunningSession(panelSessionId)) return panelSessionId;

  return null;
}
