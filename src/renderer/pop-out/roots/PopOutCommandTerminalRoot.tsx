import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CommandTerminalLayer, useCloseCommandWindowOnRemoval } from '../../components/command-bar/CommandTerminalLayer';
import { commandWindowManager } from '../../window-manager';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { transientKey } from '../../stores/session-store/transient-session-slice';
import { syncFocusedTerminals } from '../../utils/focused-terminals';
import type { PopOutProjectParams } from '../../../shared/pop-out';

type LoadState = 'loading' | 'ready' | 'missing' | 'failed';

/**
 * Seed this window with its project and the state its terminals need, then
 * report `ready`. The terminals must not mount before then:
 *
 * - the project, because every Command Terminal call reads it, and this window
 *   shows one project for its whole life. It is set on this window's own store
 *   and never asked of main: `projects.open` would switch the main window's
 *   board to it.
 * - the config, because the layer restores the saved layout once, on mount.
 * - the session list, because a window that mounts before it cannot find the
 *   terminal already running in its slot and starts a second one.
 * - the agent list, for the context bar's pickers.
 *
 * A read that fails reports `failed`, never `ready`: mounting without the
 * session list would start a second terminal in a slot that has one.
 */
function useSeedCommandTerminalWindow(projectId: string): LoadState {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const projects = await window.electronAPI.projects.list();
      const project = projects.find((candidate) => candidate.id === projectId) ?? null;
      if (cancelled) return;
      if (!project) {
        setLoadState('missing');
        return;
      }
      useProjectStore.setState({ currentProject: project });
      const [, sessionsSynced] = await Promise.all([
        useConfigStore.getState().loadConfig(),
        useSessionStore.getState().syncSessions(),
        useConfigStore.getState().loadAgentList(),
      ]);
      // A sync answers false when the list could not be read, and when a newer
      // sync (a dev-mode update's) superseded it; asking once more settles which.
      const sessionsLoaded = sessionsSynced || await useSessionStore.getState().syncSessions();
      if (!cancelled) setLoadState(sessionsLoaded ? 'ready' : 'failed');
    })().catch((error: unknown) => {
      console.error('[PopOutCommandTerminalRoot] could not load the window', error);
      if (!cancelled) setLoadState('failed');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return loadState;
}

/**
 * Tell main which terminals this window shows, which is what makes their
 * output reach it: main streams a session's bytes only to the renderers that
 * named it. This window has none of the main window's coordinator
 * (`useFocusedSessionsSync`), so it publishes its own set: every terminal it
 * holds a window for, all of them on screen.
 */
function usePublishCommandTerminalFocus(projectId: string): void {
  const windowSlots = commandWindowManager.store(useShallow((state) =>
    Object.values(state.windows).map((managedWindow) => managedWindow.anchor)));
  const focusedKey = useSessionStore((state) => windowSlots
    .map((slot) => state.transientSessions[transientKey(projectId, slot)]?.sessionId ?? '')
    .filter((sessionId) => sessionId !== '')
    .join(','));
  useEffect(() => {
    const focusedIds = focusedKey === '' ? [] : focusedKey.split(',');
    // The catch-up edge first, then the publish, as the main window's coordinator orders them.
    syncFocusedTerminals(new Set(focusedIds));
    void window.electronAPI.sessions.setFocused(focusedIds);
    // No cleanup: the window's `ErrorBoundary` releases the focus when its
    // tree is gone (see useFocusedSessionsSync for why not an unmount effect).
  }, [focusedKey]);
}

/** Pop-out root for the 'command-terminal' surface: the rail and the
 *  terminals filling the window. Hide, and stopping the last terminal, close
 *  the window; the terminals keep running and the main window shows them again. */
export function PopOutCommandTerminalRoot({ params }: { params: PopOutProjectParams }) {
  const loadState = useSeedCommandTerminalWindow(params.projectId);
  // A terminal main ends (an agent that exits, a phone's Stop) closes its window here too.
  useCloseCommandWindowOnRemoval();
  usePublishCommandTerminalFocus(params.projectId);
  const closeWindow = useCallback(() => window.electronAPI.window.close(), []);

  if (loadState === 'missing') {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-fg-muted" data-testid="command-terminal-window-missing">
        This project is no longer in Kangentic.
      </div>
    );
  }
  if (loadState === 'failed') {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-fg-muted" data-testid="command-terminal-window-failed">
        Couldn't load the terminals for this window.
      </div>
    );
  }
  if (loadState === 'loading') return <div className="flex-1" data-testid="command-terminal-window-loading" />;
  return <CommandTerminalLayer onHide={closeWindow} host="window" />;
}
