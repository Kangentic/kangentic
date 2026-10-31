/**
 * The command-terminal layer: one PANEL over a slight backdrop blur, holding a
 * rail (Add terminal and Earlier conversations) and up to four terminals. The
 * terminals are windows of a second, independent window-manager layer
 * (separate from the board task-detail layer) that renders into the panel's
 * terminal area and lets the panel arrange them (`hostArranged`): one fills
 * the area, two sit side by side, three and four tile in fixed presets that
 * resize by their seams, and the panel never resizes under that grid. The panel
 * itself moves, resizes and maximizes.
 *
 * GEOMETRY is GLOBAL: the panel's place (`AppConfig.commandTerminalPanel`) and
 * the terminals' seams (`AppConfig.commandTerminalWorkspace`) are shared across
 * all projects. POPULATION is PER-PROJECT: which slots get windows is derived
 * from the current project's live transient sessions on open (see
 * `reconcileCommandTerminalWindows`), because the session store is keyed per
 * `(projectId, slot)`. Without that split the window count carried over from
 * one project would spawn that many fresh PTYs in the next.
 *
 * Mounted by `AppLayout` only while open (Ctrl+Shift+P). The command window-store
 * instance is a module singleton that survives the mount/unmount, so hiding the
 * layer keeps the layout in memory and the PTY alive; reopening reattaches.
 * Hiding (Ctrl+Shift+P toggle, the panel's X, the panel-close combo, or a
 * backdrop click) keeps everything alive; a terminal's Stop kills its PTY.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  WindowManagerLayer,
  commandWindowManager,
  createWorkspaceSaver,
  getPortalHost,
  isHostArranged,
  isWindowDormant,
  windowIdsInReadingOrder,
} from '../../window-manager';
import type { ManagedWindow, WindowManagerLayerOptions } from '../../window-manager';
import { heldSplitSizes, TILE_GAP_PX } from '../../window-manager/tiling/resolve-layout';
import { COMMAND_PANEL_HEADER_HEIGHT_PX, CommandTerminalPanel } from './CommandTerminalPanel';
import { CommandTerminalRail } from './CommandTerminalRail';
import { COMMAND_RAIL_COLLAPSED_WIDTH_PX, COMMAND_RAIL_DEFAULT_WIDTH_PX, COMMAND_RAIL_MIN_WIDTH_PX } from '../../../shared/command-terminal-rail';
import type { RunningCommandTerminal } from './CommandTerminalRail';
import { killCommandTerminalInSlot } from './stop-command-terminal';
import type { CommandTerminalHistoryEntry, Session } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { getIsHmrReload } from '../../utils/hmr-flag';
import { runTerminalLayoutChange, terminalLayoutScopeOf } from '../../utils/terminal-layout-transition';
import { CommandTerminalLayerProvider } from './command-terminal-context';
import { COMMAND_TERMINAL_FLOOR, commandTerminalAreaMinWidth, commandTerminalGridMinimum } from './command-terminal-grid-fit';
import { PanelWidthContext, type PanelWidthChange } from './panel-edge-push';
import { planCommandWindowReconciliation } from './command-window-reconcile';
import { MAX_COMMAND_TERMINALS, commandTerminalSlotId, commandTerminalTitle } from '../../../shared/command-terminal-name';
import { resolveProjectRoot } from '../../../shared/git-utils';
import { selectLiveCommandTerminalSlots, transientKey } from '../../stores/session-store/transient-session-slice';

/** The single command-terminal slot anchor (Phase 1 is one window; Phase 2 adds
 *  more slots). The on-disk layout is anchored by this stable id, not a task. */
const COMMAND_SLOT_ID = 'slot-1';

/** A constant sentinel project id: the command layout is GLOBAL, so the shared
 *  saver (which keys by project) always persists. */
const COMMAND_WORKSPACE_KEY = 'command-terminal';

/** The body-level host the panel portals into. */
const COMMAND_LAYER_ROOT_ID = 'command-terminal-layer-root';

/**
 * The panel arranges its terminals (`hostArranged`). The pane floor is
 * `COMMAND_TERMINAL_FLOOR`, 630 x 200, and the panel never resizes under the
 * grid at that floor (`panelMinSizeFor`). Seams stop at the floor.
 */
const COMMAND_LAYER_OPTIONS: WindowManagerLayerOptions = {
  minSize: COMMAND_TERMINAL_FLOOR,
  hostArranged: true,
};

/**
 * Slots a new window must not take: the anchors of the windows already open
 * (some may still be spawning, with no session yet), plus every slot the current
 * project's live terminals hold. A phone can start a terminal while this layer
 * is closed, and main gives it a slot this layer has no window for; asking main
 * for that slot again would be refused.
 */
function occupiedCommandTerminalSlots(): Set<string> {
  const slots = new Set(
    Object.values(commandWindowManager.store.getState().windows).map((managedWindow) => managedWindow.anchor),
  );
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  for (const slot of selectLiveCommandTerminalSlots(useSessionStore.getState().sessions, projectId)) slots.add(slot);
  return slots;
}

/** Lowest free `slot-N`, or null at the cap. */
function nextFreeSlot(usedSlots: Set<string>): string | null {
  for (let index = 1; index <= MAX_COMMAND_TERMINALS; index += 1) {
    const slot = commandTerminalSlotId(index);
    if (!usedSlots.has(slot)) return slot;
  }
  return null;
}

/**
 * Close the window anchored at `slot`, for an end the window did not start: a
 * phone's Stop, or main ending a terminal whose agent exited (or whose PTY
 * died). Works on the module-singleton store whether the layer is mounted or
 * not; when that was the last window, `useHideLayerWhenEmpty` hides the layer,
 * as it does after Stop.
 */
export function closeCommandTerminalWindowInSlot(slot: string): void {
  const store = commandWindowManager.store;
  const managedWindow = Object.values(store.getState().windows).find((candidate) => candidate.anchor === slot);
  if (!managedWindow) return;
  store.getState().closeWindow(managedWindow.id);
  arrangeCommandTerminals();
}

/**
 * Close a Command Terminal's window when MAIN ends it. A desktop Stop, or a
 * branch switch, ends its own terminal and scrubs its (project, slot) entry
 * BEFORE the kill (`killTransientSessionBySlot`), so when the removal push
 * arrives, an entry that still points at the removed session means the end
 * came from elsewhere: a phone's Stop, the agent exiting (C2), or the PTY
 * dying. Its window closes the way Stop closes it. The entry is dropped for
 * every project, and the window closed only for the current one, whose
 * population the window store holds.
 *
 * Its own `sessions.onRemoved` subscription, beside App.tsx's: that handler
 * only drops the replica row (session-replica-contract.md), and this one only
 * touches the Command Terminal pairing. Mounted by AppLayout, so it runs while
 * the layer is hidden.
 */
export function useCloseCommandWindowOnRemoval(): void {
  useEffect(() => {
    const onRemoved = window.electronAPI?.sessions?.onRemoved;
    if (typeof onRemoved !== 'function') return;
    // agent-focus-ok: this push only CLOSES a window and opens nothing.
    return onRemoved((sessionId, session) => {
      if (session && session.transient !== true) return;
      const entry = Object.values(useSessionStore.getState().transientSessions)
        .find((candidate) => candidate.sessionId === sessionId);
      if (!entry) return;
      useSessionStore.getState().clearTransientSessionById(sessionId);
      if (entry.projectId === (useProjectStore.getState().currentProject?.id ?? null)) {
        closeCommandTerminalWindowInSlot(entry.slot);
      }
    });
  }, []);
}

/**
 * Lay the terminals out in the panel's preset for their count
 * (`tiling/host-arrangement.ts`), keeping the order they read in on screen and
 * placing any new window last. A no-op when the layout already is the preset,
 * so a seam the user dragged holds until a terminal starts or stops.
 */
function arrangeCommandTerminals(): void {
  const store = commandWindowManager.store;
  const state = store.getState();
  if (isHostArranged(state.windows, state.tileTree, state.tileTreeRect)) return;
  const liveIds = Object.values(state.windows)
    .filter((managedWindow) => !isWindowDormant(managedWindow))
    .map((managedWindow) => managedWindow.id);
  const placedIds = windowIdsInReadingOrder(state.tileTree).filter((id) => liveIds.includes(id));
  state.arrangeTiles([...placedIds, ...liveIds.filter((id) => !placedIds.includes(id))]);
}

/** Open a Command Terminal in a specific slot and lay the panel out again with
 *  it last. Operates on the module-singleton store, so callers work whether or
 *  not the layer is currently mounted.
 *
 *  Every Command Terminal window opens FLAT, whether spawned by the user or by a
 *  project-switch reconcile, so there is no per-caller animation choice to make. */
function openCommandTerminalWindowInSlot(slot: string): void {
  commandWindowManager.store.getState().openWindow({
    kind: 'command-terminal',
    anchor: slot,
    sessionId: null,
    title: commandTerminalTitle(slot),
    // Always flat, not just on restore. A terminal-hosting window must never
    // animate in: the entrance is a `scale()` transform, which does NOT change
    // the border box (so ResizeObserver stays silent) but DOES change
    // `getBoundingClientRect()`, which is what xterm's FitAddon measures. A fit
    // that lands mid-animation computes `cols` from a shrunken box and is never
    // corrected, leaving a terminal that overflows and looks frozen.
    skipEnterAnimation: true,
  });
  arrangeCommandTerminals();
}

/** Open another Command Terminal in the next free slot, or nothing at the cap.
 *  Operates on the module-singleton store, so it works whether or not the layer
 *  is currently mounted. */
function spawnAdditionalCommandTerminal(): void {
  const slot = nextFreeSlot(occupiedCommandTerminalSlots());
  if (slot) openCommandTerminalWindowInSlot(slot);
}

/** The slot an Earlier row would resume into in place: the focused terminal,
 *  or the only one. Null when there are several and none is focused. */
function inPlaceCandidateSlot(state: { windows: Record<string, ManagedWindow>; focusedWindowId: string | null }): string | null {
  const live = Object.values(state.windows).filter((managedWindow) => !isWindowDormant(managedWindow));
  const focused = live.find((managedWindow) => managedWindow.id === state.focusedWindowId);
  if (focused) return focused.anchor;
  return live.length === 1 ? live[0].anchor : null;
}

/** Whether nothing has reached the slot's terminal yet: no keystroke, paste or
 *  submit (`Session.hasUserInput`). A slot still spawning has had nothing. */
function isSlotUnused(
  state: { transientSessions: Record<string, { sessionId: string }>; sessions: Session[] },
  projectId: string,
  slot: string,
): boolean {
  const entry = state.transientSessions[transientKey(projectId, slot)];
  if (!entry) return true;
  const session = state.sessions.find((candidate) => candidate.id === entry.sessionId);
  return session?.hasUserInput !== true;
}

/**
 * Resume an earlier conversation from the Earlier list. It takes the place of
 * the focused (or only) terminal while nothing has reached that terminal, and
 * otherwise opens beside the others: a used terminal is never replaced. The
 * slot's window takes the request (`requestCommandTerminalResume`), whether it
 * is live or still mounting.
 */
function resumeCommandTerminalConversation(agentSessionId: string): void {
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  if (!projectId) return;
  const sessionState = useSessionStore.getState();
  const candidateSlot = inPlaceCandidateSlot(commandWindowManager.store.getState());
  if (candidateSlot && isSlotUnused(sessionState, projectId, candidateSlot)) {
    sessionState.requestCommandTerminalResume(projectId, candidateSlot, agentSessionId);
    return;
  }
  resumeCommandTerminalBeside(agentSessionId);
}

/** Resume an earlier conversation in a new terminal, in the next free slot.
 *  Nothing happens at the cap, where the Earlier list is off. A window reaches
 *  this through the layer context. */
function resumeCommandTerminalBeside(agentSessionId: string): void {
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  if (!projectId) return;
  const slot = nextFreeSlot(occupiedCommandTerminalSlots());
  if (!slot) return;
  useSessionStore.getState().requestCommandTerminalResume(projectId, slot, agentSessionId);
  openCommandTerminalWindowInSlot(slot);
}

/** Reconcile the singleton window POPULATION to the current project's live
 *  transient sessions: close carried-over windows whose slot has no live session
 *  for the project, and open a window for every live session that lacks one (so a
 *  back-switch reattaches the PTY instead of orphaning it). Geometry stays global
 *  (the blob); only which slots get windows is per project.
 *
 *  MUST run while the layer is UNMOUNTED (the `open()` path) or inside
 *  `useEnsureCommandWindow`'s empty-store branch, so no `CommandTerminalWindow`
 *  mount effect can observe a pre-reconcile population and spawn under the wrong
 *  project. Closes are applied before opens so docking never targets a window
 *  about to close.
 *
 *  `skipWhenEmpty` (the `open()` caller) bails when the store holds no windows. An
 *  empty store has no carried-over windows to reconcile, and populating it here
 *  would open DEFAULT-geometry windows that pre-empt `useEnsureCommandWindow`'s
 *  saved-layout restore: its `windows.length > 0` guard would then skip
 *  `applyWorkspace`, losing the blob geometry on a first open after a hard reload
 *  with surviving PTYs. The mount effect owns the empty-store case. */
export function reconcileCommandTerminalWindows(options?: { skipWhenEmpty?: boolean }): void {
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  if (!projectId) return;

  const store = commandWindowManager.store;
  if (options?.skipWhenEmpty && Object.keys(store.getState().windows).length === 0) return;

  const sessionState = useSessionStore.getState();
  const plan = planCommandWindowReconciliation({
    windows: Object.values(store.getState().windows).map((managedWindow) => ({
      windowId: managedWindow.id,
      slot: managedWindow.anchor,
    })),
    transientSessions: sessionState.transientSessions,
    sessions: sessionState.sessions,
    projectId,
    maxWindows: MAX_COMMAND_TERMINALS,
  });

  for (const windowId of plan.closeWindowIds) store.getState().closeWindow(windowId);
  for (const slot of plan.openSlots) openCommandTerminalWindowInSlot(slot);
  arrangeCommandTerminals();
}

/** Ensure the command layer has its windows once mounted. Runs once per mount.
 *
 *  Non-empty store: reopen after a hide (`open()` already reconciled the
 *  population) or an HMR remount (the live layout and `transientSessions` are
 *  both HMR-preserved and consistent). Leave it alone.
 *
 *  Empty store (first open this app run): restore the GLOBAL geometry blob, then
 *  reconcile the population to this project's live sessions (trim restored
 *  windows whose slot has no live PTY, keeping one default; open windows for live
 *  PTYs the blob did not cover, e.g. hard-reload survivors re-paired by
 *  `syncSessions`), then fall back to a fresh default window if still empty. */
function useEnsureCommandWindow(): void {
  useEffect(() => {
    const store = commandWindowManager.store;
    if (Object.keys(store.getState().windows).length > 0) return;

    const saved = useConfigStore.getState().globalConfig.commandTerminalWorkspace;
    if (saved) {
      // Slot anchors are always valid; the transient session is ephemeral, so the
      // restored windows resolve to no session (reconciliation decides which stay).
      store.getState().applyWorkspace(saved, () => null, () => true);
    }

    // Safe here (unlike a bridge effect on a non-empty store): an empty store
    // committed zero window frames, so no window mount effect can spawn until this
    // effect finishes and React re-renders the reconciled population.
    reconcileCommandTerminalWindows();

    if (Object.keys(store.getState().windows).length === 0) openCommandTerminalWindowInSlot(COMMAND_SLOT_ID);
    // A layout saved before the panel (floating or snapped windows) is tiled
    // into the panel's preset here.
    arrangeCommandTerminals();
  }, []);
}

/** Keep the terminals in the panel's preset while the layer is on screen: a
 *  Stop, or a window whose spawn failed, closes its window from inside the
 *  layer, and the rest re-tile for the new count. A resume asked of a slot
 *  whose window closed before taking it is dropped with the window. */
function useArrangeOnPopulationChange(): void {
  useEffect(() => commandWindowManager.store.subscribe((state) => {
    arrangeCommandTerminals();
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!projectId) return;
    const windowSlots = new Set(Object.values(state.windows).map((managedWindow) => managedWindow.anchor));
    useSessionStore.getState().dropCommandTerminalResumesExcept(projectId, windowSlots);
  }), []);
}

/** Every terminal in the panel in the order they tile, for the rail's Running
 *  list and its strip, and the one in front: the expanded one, else the focused
 *  tile. A window not yet in the tile tree follows the placed ones. */
function useRailTerminals(): { terminals: RunningCommandTerminal[]; frontWindowId: string | null } {
  const windowIds = commandWindowManager.store(useShallow((state) => {
    const placed = windowIdsInReadingOrder(state.tileTree).filter((id) => state.windows[id] !== undefined);
    return [...placed, ...Object.keys(state.windows).filter((id) => !placed.includes(id))];
  }));
  const slots = commandWindowManager.store(useShallow((state) =>
    windowIds.map((id) => state.windows[id]?.anchor ?? '')));
  const frontWindowId = commandWindowManager.store((state) => {
    const front = state.expandedWindowId ?? state.focusedWindowId;
    return front !== null && state.windows[front] !== undefined ? front : null;
  });
  const terminals = useMemo(
    () => windowIds.map((windowId, index) => ({ windowId, slot: slots[index] })),
    [windowIds, slots],
  );
  return { terminals, frontWindowId };
}

/** Every slot is taken: the Command Terminal windows (the store is a module
 *  singleton that outlives the layer's mount) plus the project's live
 *  terminals, which include any a phone started with the layer closed. Both
 *  reads compare shallowly, so this re-renders only when a slot changes. */
function useCommandTerminalAtCap(projectId: string | null): boolean {
  const windowSlots = commandWindowManager.store(useShallow((state) =>
    Object.values(state.windows).map((managedWindow) => managedWindow.anchor)));
  const liveSlots = useSessionStore(useShallow((state) =>
    [...selectLiveCommandTerminalSlots(state.sessions, projectId)]));
  return new Set([...windowSlots, ...liveSlots]).size >= MAX_COMMAND_TERMINALS;
}

/**
 * Why Open in new window is off: a terminal is still starting, its window not
 * yet paired with a session. Main holds that slot reserved until the start
 * lands, so the new window could neither find the terminal nor take the slot.
 */
const TERMINALS_STARTING_REASON = msg`Wait for the terminals to start.`;

/** Whether a window in the panel is still waiting for its terminal's session. */
function useTerminalsStarting(projectId: string | null): boolean {
  const windowSlots = commandWindowManager.store(useShallow((state) =>
    Object.values(state.windows).map((managedWindow) => managedWindow.anchor)));
  return useSessionStore((state) =>
    projectId !== null && windowSlots.some((slot) => !state.transientSessions[transientKey(projectId, slot)]));
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

/** Hide the whole layer once the LAST command window closes (the user Stopped the
 *  only remaining terminal). Watches the module-singleton store; subscribes after
 *  `useEnsureCommandWindow` has opened the first window, so the initial empty
 *  state never triggers a spurious hide. */
function useHideLayerWhenEmpty(onHide: () => void): void {
  useEffect(() => {
    return commandWindowManager.store.subscribe((state, prevState) => {
      const count = Object.keys(state.windows).length;
      const previousCount = Object.keys(prevState.windows).length;
      if (previousCount > 0 && count === 0) onHide();
    });
  }, [onHide]);
}

/** Keep every window's branch pill honest while the layer is on screen.
 *
 *  The pill is a per-project fact (all of a project's terminals share the main
 *  checkout's HEAD), so ONE tracker per layer re-derives it, not one per window:
 *  once on mount, which is every reattach after a hide, and then on every
 *  diff-watcher fire, which already covers HEAD / logs/HEAD moves and debounces.
 *  The subscription is ref-counted per path in main and shared with a Changes
 *  panel open on the same root, so this adds no second fs.watch. The layer
 *  unmounts on hide, so the cost exists only while the terminals are visible.
 *  A reattach never CHECKS OUT anything: the read is the whole action, so HEAD
 *  can never move out from under a running agent. */
function useTrackHeadBranch(): void {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const rawProjectPath = useProjectStore((state) => state.currentProject?.path ?? null);
  const refreshBranches = useSessionStore((state) => state.refreshTransientBranchesFromHead);
  useEffect(() => {
    if (!projectId || !rawProjectPath) return;
    const projectRoot = resolveProjectRoot(rawProjectPath);
    // StrictMode runs mount / cleanup / mount; the flag drops the discarded
    // run's fires, and the refcount tolerates the paired subscribe/unsubscribe.
    let cancelled = false;
    const refresh = (): void => {
      if (!cancelled) void refreshBranches(projectId, projectRoot);
    };
    refresh();
    window.electronAPI.git.subscribeDiff(projectRoot);
    // agent-focus-ok: this push opens nothing. It only re-reads HEAD and
    // rewrites the branch text of windows that already exist; every openWindow
    // in this file runs off a user gesture (Ctrl+Shift+P, Add terminal) or
    // the reconcile that follows it, never off this subscription. The scan in
    // agent-driven-focus-sites.test.ts cannot tell the two apart, so the answer
    // is written down here. See .claude/rules/agent-driven-focus.md.
    const unsubscribe = window.electronAPI.git.onDiffChanged(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      window.electronAPI.git.unsubscribeDiff(projectRoot);
    };
  }, [projectId, rawProjectPath, refreshBranches]);
}

/** Layer bridges: ensure the window exists, persist the global layout, hide the
 *  layer when the last terminal is Stopped, keep the branch pills honest, and
 *  bind the panel-close combo to hide. Mounted inside the layer's portal. */
function CommandBridges({ onHide }: { onHide: () => void }): null {
  useEnsureCommandWindow();
  useArrangeOnPopulationChange();
  useCommandWorkspacePersistence();
  useHideLayerWhenEmpty(onHide);
  useTrackHeadBranch();
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

/** What the panel adds around its terminals: the rail beside them and the
 *  header above, plus the 1px border on each side. It sizes a panel nobody has
 *  moved, so it reads the rail's DEFAULT width, never its live one: a panel
 *  nobody moved opens at one size whatever the rail was left at. */
const PANEL_CHROME = { width: COMMAND_RAIL_DEFAULT_WIDTH_PX + 2, height: COMMAND_PANEL_HEADER_HEIGHT_PX + 2 };

/**
 * The smallest panel: the rail at its narrowest (its 200px drag minimum open,
 * its strip folded) beside the grid at the pane floor, under the panel header,
 * plus the 1px border. So a resize stops where the grid still fits, and a
 * terminal added or the grid restored grows the panel to fit
 * (`CommandTerminalPanel` keeps the size it grew to). Only while one is expanded
 * may the panel shrink to one terminal. Opening the rail grows the panel by what
 * the rail takes (`panel-edge-push.ts`), so a panel sized down to the strip
 * leaves the terminals their floor when the rail opens. An area smaller than
 * this (a small window) shows the panel at the area's size, its terminals tiled
 * under the floor.
 */
function panelMinSizeFor(gridMinimum: { width: number; height: number }, railMinimumWidth: number): { width: number; height: number } {
  return {
    width: railMinimumWidth + gridMinimum.width + 2,
    height: COMMAND_PANEL_HEADER_HEIGHT_PX + gridMinimum.height + 2,
  };
}

/**
 * Where the layer is drawn: `panel` floats over the board in the main window;
 * `window` fills a window of its own (the detached Command Terminal), whose OS
 * frame already moves, sizes and closes it, so it draws the rail and the
 * terminals with no panel header, backdrop or geometry of its own.
 */
export type CommandTerminalHost = 'panel' | 'window';

export function CommandTerminalLayer({ onHide, host = 'panel' }: { onHide: () => void; host?: CommandTerminalHost }) {
  // The panel's own host is the body-level layer root, stamped
  // `data-window-layer-root`, so light dismiss treats the whole panel as a window.
  const [layerRoot] = useState(() => (host === 'panel' ? getPortalHost(COMMAND_LAYER_ROOT_ID) : null));
  // The window engine renders INTO the panel's terminal area, once it exists.
  const [terminalArea, setTerminalArea] = useState<HTMLElement | null>(null);
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const projectName = useProjectStore((state) => state.currentProject?.name ?? '');
  const terminalCount = commandWindowManager.store((state) => Object.keys(state.windows).length);
  const expanded = commandWindowManager.store((state) => state.expandedWindowId !== null);
  const gridMinimum = commandTerminalGridMinimum(terminalCount, expanded, COMMAND_LAYER_OPTIONS.minSize);
  // The rail's narrowest: its strip folded, its drag minimum open.
  const railFolded = useConfigStore((state) => state.config.commandTerminalRail?.collapsed === true);
  const railMinimumWidth = railFolded ? COMMAND_RAIL_COLLAPSED_WIDTH_PX : COMMAND_RAIL_MIN_WIDTH_PX;
  const terminalAreaMinWidth = commandTerminalAreaMinWidth(gridMinimum.width, railMinimumWidth);
  const panelMinSize = useMemo(
    () => panelMinSizeFor({ width: gridMinimum.width, height: gridMinimum.height }, railMinimumWidth),
    [gridMinimum.width, gridMinimum.height, railMinimumWidth],
  );
  const atCap = useCommandTerminalAtCap(projectId);
  const terminalsStarting = useTerminalsStarting(projectId);
  // A terminal added or stopped re-tiles the others, which hold their frames in
  // their new tiles until they have repainted (`terminal-layout-transition.ts`).
  const changeLayout = useCallback((change: () => void) => {
    runTerminalLayoutChange(terminalLayoutScopeOf(terminalArea), change);
  }, [terminalArea]);
  // The panel's width change (`panel-edge-push.ts`), which the rail drives,
  // reached through the ref the panel fills: the detached window has no panel,
  // so there the terminals give the rail its room.
  const panelWidthRef = useRef<PanelWidthChange | null>(null);
  const widthChange = useMemo<PanelWidthChange>(() => ({
    begin: (options) => panelWidthRef.current?.begin(options) ?? null,
  }), []);
  // Before the panel resizes, the terminals take the proportions on screen as
  // their own: two the floor holds even at the panel's minimum grow evenly, not
  // from a seam an earlier, wider panel left skewed. Nothing on screen moves.
  const adoptHeldLayout = useCallback(() => {
    const state = commandWindowManager.store.getState();
    if (!terminalArea || !state.tileTree || state.expandedWindowId !== null) return;
    const size = {
      width: terminalArea.clientWidth * state.tileTreeRect.w,
      height: terminalArea.clientHeight * state.tileTreeRect.h,
    };
    for (const split of heldSplitSizes(state.tileTree, size, TILE_GAP_PX, COMMAND_LAYER_OPTIONS.minSize)) {
      state.setSplitSizes(split.splitId, split.sizes);
    }
  }, [terminalArea]);
  const handleNewTerminal = useCallback(() => {
    changeLayout(spawnAdditionalCommandTerminal);
  }, [changeLayout]);
  const handleResume = useCallback((entry: CommandTerminalHistoryEntry) => {
    changeLayout(() => resumeCommandTerminalConversation(entry.agentSessionId));
  }, [changeLayout]);
  const { terminals: railTerminals, frontWindowId } = useRailTerminals();
  // A rail entry's click: expanded over the others while one is expanded, else
  // the focused tile. The frame stops being inert on the commit after an
  // expand, so the keyboard follows the click into that terminal a frame later.
  const handleBringToFront = useCallback((windowId: string) => {
    const state = commandWindowManager.store.getState();
    if (state.expandedWindowId !== null) state.setExpandedWindow(windowId);
    else state.focusWindow(windowId);
    requestAnimationFrame(() => {
      // arrival-focus-ok: the user's own click on this terminal's rail entry.
      document.querySelector<HTMLElement>(`[data-testid="window-frame-${windowId}"] .xterm-helper-textarea`)?.focus();
    });
  }, []);
  const handleStopRunning = useCallback(async (terminal: RunningCommandTerminal) => {
    await killCommandTerminalInSlot(terminal.slot);
    // The arrange bridge re-tiles the rest; with one left, nothing stays expanded.
    changeLayout(() => commandWindowManager.store.getState().closeWindow(terminal.windowId));
  }, [changeLayout]);
  const handleOpenInNewWindow = useCallback(() => {
    if (!projectId) return;
    // Hide first: the terminals unmount here and the layout saves, so this
    // window has stopped drawing them before the new window draws its own.
    onHide();
    // A window that did not open would leave the running terminals with
    // nothing showing them. The pending-open flag reopens the panel through
    // the same open (and reconcile) the shortcut runs.
    const showPanelAgain = (): void => {
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't open the window`),
        message: i18n._(msg`The terminals are back in the panel.`),
        variant: 'error',
      });
      useSessionStore.getState().setPendingOpenCommandTerminal(true);
    };
    window.electronAPI.popOut.open('command-terminal', { projectId, projectName })
      .then((opened) => {
        if (!opened) showPanelAgain();
      })
      .catch(showPanelAgain);
  }, [projectId, projectName, onHide]);

  const rail = (
    <CommandTerminalRail
      projectId={projectId}
      atCap={atCap}
      terminals={railTerminals}
      frontWindowId={frontWindowId}
      terminalsMinWidth={gridMinimum.width}
      onNewTerminal={handleNewTerminal}
      onResume={handleResume}
      onBringToFront={handleBringToFront}
      onStop={handleStopRunning}
      onLayoutChange={changeLayout}
    />
  );

  return (
    <PanelWidthContext.Provider value={widthChange}>
    <CommandTerminalLayerProvider hideLayer={onHide} resumeBeside={resumeCommandTerminalBeside}>
      {layerRoot === null ? (
        // The window's own title bar takes the place of the panel header.
        <div className="flex flex-1 min-h-0" data-testid="command-terminal-detached">
          {rail}
          <div ref={setTerminalArea} className="relative flex-1" style={{ minWidth: terminalAreaMinWidth }} data-testid="command-terminal-area" />
        </div>
      ) : createPortal(
        // Above board windows (z-40), below true modal dialogs / popovers (z-50)
        // that this layer itself spawns (BranchPicker, ConfirmDialog).
        <div className="fixed left-0 right-0 top-10 bottom-9 z-[45] pointer-events-none" data-testid="command-terminal-layer">
          <CommandBackdrop onHide={onHide} />
          <CommandTerminalPanel
            onHide={onHide}
            minSize={panelMinSize}
            terminalAreaMinWidth={terminalAreaMinWidth}
            onResizeStart={adoptHeldLayout}
            widthChangeRef={panelWidthRef}
            chrome={PANEL_CHROME}
            onTerminalAreaReady={setTerminalArea}
            onOpenInNewWindow={handleOpenInNewWindow}
            openInNewWindowDisabledReason={terminalsStarting ? i18n._(TERMINALS_STARTING_REASON) : null}
            rail={rail}
          />
        </div>,
        layerRoot,
      )}
      {terminalArea && (
        <WindowManagerLayer
          manager={commandWindowManager}
          layer={COMMAND_LAYER_OPTIONS}
          portalHostId={COMMAND_LAYER_ROOT_ID}
          portalHost={terminalArea}
          overlayTestId="command-window-overlay"
          overlayClassName="absolute inset-0 pointer-events-none"
          bridges={<CommandBridges onHide={onHide} />}
        />
      )}
    </CommandTerminalLayerProvider>
    </PanelWidthContext.Provider>
  );
}
