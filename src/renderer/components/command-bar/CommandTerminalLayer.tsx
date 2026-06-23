/**
 * The command-terminal window layer: a second, independent window-manager layer
 * (separate from the board task-detail layer) that hosts the Command Terminal as
 * a movable / resizable / maximizable / snappable window, top-layered over a
 * slight backdrop blur. Its arrangement persists GLOBALLY (one blob shared across
 * all projects); the session stays per-project and ephemeral.
 *
 * Mounted by `AppLayout` only while open (Ctrl+Shift+P). The command window-store
 * instance is a module singleton that survives the mount/unmount, so hiding the
 * layer keeps the layout in memory and the PTY alive; reopening reattaches.
 * Hiding (Ctrl+Shift+P toggle, the panel-close combo, or a backdrop click) keeps
 * everything alive; the window's Stop control kills the PTY.
 */

import { useEffect, useRef, useState } from 'react';
import {
  WindowManagerLayer,
  commandWindowManager,
  createWorkspaceSaver,
} from '../../window-manager';
import type { WindowManagerLayerOptions } from '../../window-manager';
import { useConfigStore } from '../../stores/config-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { getIsHmrReload } from '../../utils/hmr-flag';
import { CommandTerminalLayerProvider } from './command-terminal-context';

/** The single command-terminal slot anchor (Phase 1 is one window; Phase 2 adds
 *  more slots). The on-disk layout is anchored by this stable id, not a task. */
const COMMAND_SLOT_ID = 'slot-1';
const COMMAND_WINDOW_TITLE = 'Command Terminal';

/** A constant sentinel project id: the command layout is GLOBAL, so the shared
 *  saver (which keys by project) always persists. */
const COMMAND_WORKSPACE_KEY = 'command-terminal';

/** Command terminals can resize down to the same comfortable floor as board
 *  windows; carried as a per-layer option so it is a one-line change later. */
const COMMAND_LAYER_OPTIONS: WindowManagerLayerOptions = {
  minSize: { width: 650, height: 400 },
};

/** Ensure the command layer has its single window once mounted: reuse the live
 *  one (reopen after hide), else restore the saved global layout, else open a
 *  fresh slot. Runs once per mount. */
function useEnsureCommandWindow(): void {
  useEffect(() => {
    const store = commandWindowManager.store;
    if (Object.keys(store.getState().windows).length > 0) return;

    const saved = useConfigStore.getState().globalConfig.commandTerminalWorkspace;
    if (saved) {
      // Slot anchors are always valid; the transient session is ephemeral, so the
      // restored window resolves to no session and the window spawns a fresh one.
      store.getState().applyWorkspace(saved, () => null, () => true);
    }

    if (Object.keys(store.getState().windows).length === 0) {
      store.getState().openWindow({
        kind: 'command-terminal',
        anchor: COMMAND_SLOT_ID,
        sessionId: null,
        title: COMMAND_WINDOW_TITLE,
      });
    }
  }, []);
}

/** Persist the GLOBAL command-terminal layout: debounced save on every change,
 *  plus a flush on hide (unmount) and before unload. */
function useCommandWorkspacePersistence(): void {
  const save = useConfigStore((state) => state.saveCommandTerminalWorkspace);
  const flush = useConfigStore((state) => state.flushCommandTerminalWorkspace);

  useEffect(() => {
    const saver = createWorkspaceSaver({
      getProjectId: () => COMMAND_WORKSPACE_KEY,
      getWorkspace: () => commandWindowManager.store.getState().serializeWorkspace(),
      save: (_projectId, workspace) => save(workspace),
      saveSync: (_projectId, workspace) => flush(workspace),
    });
    const unsubscribe = commandWindowManager.store.subscribe(saver.onChange);
    const flushBeforeUnload = (): void => saver.flush();
    window.addEventListener('beforeunload', flushBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', flushBeforeUnload);
      unsubscribe();
      saver.flush();
      saver.dispose();
    };
  }, [save, flush]);
}

/** Layer bridges: ensure the window exists, persist the global layout, and bind
 *  Escape to hide the layer. Mounted inside the layer's portal. */
function CommandBridges({ onHide }: { onHide: () => void }): null {
  useEnsureCommandWindow();
  useCommandWorkspacePersistence();
  // The panel-close combo hides the whole layer (keeps the PTY alive). Capture
  // phase so it beats the embedded xterm's key handling. Ctrl+Shift+P (toggle) is
  // bound by `useCommandBar`; a backdrop click also hides.
  useKeybinding('panel.close', onHide, { capture: true });
  return null;
}

/** A slight, theme-adaptive blur behind the terminal so the board is dimmed and the
 *  terminal stays the focus. A clean click on it hides the layer.
 *
 *  It fades in via the shared `overlay-backdrop-in` motion token (opacity 0->1,
 *  ~200ms ease-out, the same enter every dialog/panel uses). Fading the element
 *  that CARRIES the blur eases the blur in for free without animating the
 *  (expensive) filter radius. Skipped on an HMR remount so it does not replay
 *  while dogfooding (mirrors the window content's `skipEnterOnHmr`). */
function CommandBackdrop({ onHide }: { onHide: () => void }) {
  const pressedOnSelf = useRef(false);
  const [animateIn] = useState(() => !getIsHmrReload());
  return (
    <div
      className={`absolute inset-0 bg-surface/40 backdrop-blur-xs pointer-events-auto ${animateIn ? 'overlay-backdrop-in' : ''}`}
      data-testid="command-window-backdrop"
      onMouseDown={(event) => { pressedOnSelf.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        if (event.target === event.currentTarget && pressedOnSelf.current) onHide();
        pressedOnSelf.current = false;
      }}
    />
  );
}

export function CommandTerminalLayer({ onHide }: { onHide: () => void }) {
  return (
    <CommandTerminalLayerProvider hideLayer={onHide}>
      <WindowManagerLayer
        manager={commandWindowManager}
        layer={COMMAND_LAYER_OPTIONS}
        portalHostId="command-terminal-layer-root"
        overlayTestId="command-window-overlay"
        // Above board windows (z-40), below true modal dialogs / popovers (z-50)
        // that this layer itself spawns (BranchPicker, ConfirmDialog).
        overlayClassName="fixed left-0 right-0 top-10 bottom-9 z-[45] pointer-events-none"
        bridges={<CommandBridges onHide={onHide} />}
        backdrop={<CommandBackdrop onHide={onHide} />}
      />
    </CommandTerminalLayerProvider>
  );
}
