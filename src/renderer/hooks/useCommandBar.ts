import { useEffect, useCallback, useRef } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { usePopOutStore } from '../stores/pop-out-store';
import { popOutInstanceKey } from '../../shared/pop-out';
import { useKeybinding } from './useKeybinding';
import { reconcileCommandTerminalWindows } from '../components/command-bar/CommandTerminalLayer';
import { clearPanelEnterSkip } from '../components/command-bar/reopen-panel';

/** How long an open waits on main's restore before the title-bar toggle shows it. */
const OPEN_WAIT_INDICATOR_DELAY_MS = 150;

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

  // The open waiting on main's restore, so a hide or a project switch can drop
  // it and a second press does not start another.
  const openWaiting = useRef<{ projectId: string } | null>(null);
  const endOpenWait = useCallback(() => {
    openWaiting.current = null;
    useSessionStore.getState().setCommandBarOpening(false);
  }, []);
  // The open is off, so the panel a restart's reopen asked for will not mount.
  // The next open is a user's, and fades in.
  const dropWaitingOpen = useCallback(() => {
    endOpenWait();
    clearPanelEnterSkip();
  }, [endOpenWait]);

  // Close command bar when project changes - it will reattach on next open.
  // Skipping the initial value keeps a mount from closing a layer that HMR
  // just preserved.
  const seenProjectId = useRef(currentProjectId);
  useEffect(() => {
    if (currentProjectId === seenProjectId.current) return;
    seenProjectId.current = currentProjectId;
    dropWaitingOpen();
    useSessionStore.getState().setCommandBarVisible(false);
  }, [currentProjectId, dropWaitingOpen]);

  // Note where the panel is showing, so a quit leaves it reading open and the
  // next launch reopens it (`reopen-panel.ts`). Nothing runs at the quit itself.
  // Skipping the initial value keeps a boot's closed panel from erasing that
  // record before the boot reads it.
  const seenOpen = useRef(isOpen);
  useEffect(() => {
    if (isOpen === seenOpen.current) return;
    seenOpen.current = isOpen;
    const openProjectId = isOpen ? useProjectStore.getState().currentProject?.id ?? null : null;
    useConfigStore.getState().saveCommandTerminalOpenProject(openProjectId);
  }, [isOpen]);

  const open = useCallback(() => {
    const currentProject = useProjectStore.getState().currentProject;
    if (!currentProject) {
      useToastStore.getState().addToast({
        title: i18n._(msg`No project open`),
        message: i18n._(msg`Open a project first.`),
        variant: 'warning',
      });
      return;
    }
    // While this project's terminals have a window of their own, every way of
    // opening the panel brings that window forward instead.
    const popOutParams = { projectId: currentProject.id, projectName: currentProject.name };
    const detachedKey = popOutInstanceKey('command-terminal', popOutParams);
    if (usePopOutStore.getState().openInstanceKeys[detachedKey]) {
      clearPanelEnterSkip();
      void window.electronAPI.popOut.focus('command-terminal', popOutParams);
      return;
    }
    const projectId = currentProject.id;
    if (openWaiting.current?.projectId === projectId) return;
    const request = { projectId };
    openWaiting.current = request;
    // A wait past this is a boot's restore, and the toggle says so. Every other
    // open is answered at once, and never flashes the spinner.
    const showWaiting = setTimeout(() => {
      if (openWaiting.current === request) useSessionStore.getState().setCommandBarOpening(true);
    }, OPEN_WAIT_INDICATOR_DELAY_MS);
    // This is the one place the panel is shown. It waits for main's restore: a
    // default window opened ahead of it would start fresh in a slot the restore
    // is about to take. Answered at once unless a boot's restore is still running.
    const showPanel = (): void => {
      clearTimeout(showWaiting);
      if (openWaiting.current !== request) return;
      if (
        useProjectStore.getState().currentProject?.id !== projectId
        || usePopOutStore.getState().openInstanceKeys[detachedKey]
      ) {
        dropWaitingOpen();
        return;
      }
      endOpenWait();
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
    };
    // A wait that failed only means main cannot say: the panel still opens.
    window.electronAPI.sessions.waitForCommandTerminalRestore(projectId).then(showPanel, showPanel);
  }, [dropWaitingOpen, endOpenWait]);

  const close = useCallback(() => {
    dropWaitingOpen();
    useSessionStore.getState().setCommandBarVisible(false);
  }, [dropWaitingOpen]);

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
    dropWaitingOpen();
    useSessionStore.getState().setCommandBarVisible(false);
  }, [hideNonce, dropWaitingOpen]);

  useKeybinding('commandBar.toggle', () => {
    if (isOpen) close();
    else open();
  });

  return { isOpen, open, close };
}
