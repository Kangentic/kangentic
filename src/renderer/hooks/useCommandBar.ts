import { useEffect, useCallback, useRef } from 'react';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { useKeybinding } from './useKeybinding';
import { reconcileCommandTerminalWindows } from '../components/command-bar/CommandTerminalLayer';

/**
 * Registers Ctrl+Shift+P / Cmd+Shift+P to open the command bar overlay.
 * Returns open/close state and handlers.
 *
 * The open state IS the session store's `commandBarVisible`: TerminalPanel's
 * focus priority and the dictation target already read it there, and the store
 * is pinned across HMR (hmr-patterns.md, Pattern E), so the overlay stays open
 * through a Fast Refresh with no module-scope snapshot of its own. It used to
 * be local state mirrored INTO the store by an effect, which needed that
 * snapshot and a second effect to close it, both of the cascading-render shape
 * React's compiler rules forbid.
 */
export function useCommandBar() {
  const isOpen = useSessionStore((s) => s.commandBarVisible);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id);
  const pendingOpenCommandTerminal = useSessionStore((s) => s._pendingOpenCommandTerminal);
  const hideNonce = useSessionStore((s) => s.commandBarHideNonce);

  // Close command bar when project changes - it will reattach on next open.
  // Skipping the initial value keeps a mount from closing a layer that HMR
  // just preserved.
  const seenProjectId = useRef(currentProjectId);
  useEffect(() => {
    if (currentProjectId === seenProjectId.current) return;
    seenProjectId.current = currentProjectId;
    useSessionStore.getState().setCommandBarVisible(false);
  }, [currentProjectId]);

  const open = useCallback(() => {
    const currentProject = useProjectStore.getState().currentProject;
    if (!currentProject) {
      useToastStore.getState().addToast({
        message: 'Open a project first',
        variant: 'warning',
      });
      return;
    }
    // Reconcile the singleton window population to THIS project's live transient
    // sessions BEFORE the layer mounts, so a carried-over window can never mount
    // (and spawn) under the wrong project. Skipped when the layer is already open:
    // the population was reconciled at open time, and a mid-open reconcile could
    // transiently empty the store under the live hide-on-empty bridge.
    // `skipWhenEmpty` defers the empty-store case to `useEnsureCommandWindow`, which
    // restores the saved layout blob first; reconciling an empty store here would
    // open default-geometry windows and defeat that restore.
    const sessionState = useSessionStore.getState();
    if (!sessionState.commandBarVisible) reconcileCommandTerminalWindows({ skipWhenEmpty: true });
    sessionState.setCommandBarVisible(true);
  }, []);

  const close = useCallback(() => {
    useSessionStore.getState().setCommandBarVisible(false);
  }, []);

  // Consume pending-open flag set by notification clicks for transient sessions.
  // Runs after currentProjectId settles, so cross-project notification clicks
  // (which call openProject first) reopen the overlay on the correct project.
  // Route through open() so the population reconciles for the target project.
  useEffect(() => {
    if (!pendingOpenCommandTerminal) return;
    if (!currentProjectId) return;
    useSessionStore.getState().setPendingOpenCommandTerminal(false);
    open();
  }, [pendingOpenCommandTerminal, currentProjectId, open]);

  // Honour an outside request to hide the layer (the Agent Monitor deep-linking to
  // a task). Skipping the initial value keeps a mount from closing a layer that
  // HMR just preserved. Hiding leaves every Command Terminal PTY running, the same
  // as the title-bar toggle.
  const seenHideNonce = useRef(hideNonce);
  useEffect(() => {
    if (hideNonce === seenHideNonce.current) return;
    seenHideNonce.current = hideNonce;
    useSessionStore.getState().setCommandBarVisible(false);
  }, [hideNonce]);

  useKeybinding('commandBar.toggle', () => {
    if (isOpen) close();
    else open();
  });

  return { isOpen, open, close };
}
