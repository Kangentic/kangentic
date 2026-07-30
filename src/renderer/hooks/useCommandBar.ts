import { useState, useEffect, useCallback, useRef } from 'react';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { useKeybinding } from './useKeybinding';
import { reconcileCommandTerminalWindows } from '../components/command-bar/CommandTerminalLayer';

/** Preserved across HMR so the command bar overlay stays mounted during
 *  hot module replacement instead of resetting to closed. */
// @ts-expect-error -- Vite handles import.meta.hot
const hmrCommandBarOpen: boolean = import.meta.hot?.data?.commandBarOpen ?? false;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.commandBarOpen = _lastIsOpen;
  });
}

/** Tracks the latest isOpen value. Read by the HMR dispose() snapshot AND by
 *  `open()`'s reconcile gate (`!_lastIsOpen` stands in for "layer currently
 *  unmounted"), so it must stay in sync with the real open state. */
let _lastIsOpen = hmrCommandBarOpen;

/**
 * Registers Ctrl+Shift+P / Cmd+Shift+P to open the command bar overlay.
 * Returns open/close state and handlers.
 */
export function useCommandBar() {
  const [isOpen, setIsOpen] = useState(hmrCommandBarOpen);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id);
  const pendingOpenCommandTerminal = useSessionStore((s) => s._pendingOpenCommandTerminal);
  const hideNonce = useSessionStore((s) => s.commandBarHideNonce);

  // Keep module-scoped tracker in sync for HMR dispose()
  useEffect(() => {
    _lastIsOpen = isOpen;
    // Sync store so TerminalPanel can include transient session in focus priority
    useSessionStore.getState().setCommandBarVisible(isOpen);
  }, [isOpen]);

  // Close command bar when project changes - it will reattach on next open
  useEffect(() => {
    setIsOpen(false);
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
    if (!_lastIsOpen) reconcileCommandTerminalWindows({ skipWhenEmpty: true });
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
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
    setIsOpen(false);
  }, [hideNonce]);

  useKeybinding('commandBar.toggle', () => {
    if (isOpen) close();
    else open();
  });

  return { isOpen, open, close };
}
