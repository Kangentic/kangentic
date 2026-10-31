/**
 * A single Command Terminal hosted inside a window-manager frame, one tile of
 * the Command Terminal panel (`CommandTerminalPanel`). The panel tiles its
 * terminals and owns moving, resizing and maximizing, so this component only
 * renders the CONTENT - a header (Stop + title + branch picker + command/changes
 * pills + kebab), the xterm body, an optional Changes panel, and the ContextBar
 * footer. Hiding the panel keeps the PTY alive; only Stop destroys the session.
 *
 * Lifecycle: an ephemeral transient session is spawned on mount (or reattached if
 * one is already alive for the project), scoped to the active project. Stop kills
 * the PTY and hides the layer; hiding the layer (Ctrl+Shift+P toggle, the panel-
 * close combo, or a backdrop click) keeps the PTY alive so reopening reattaches.
 * The xterm is never remounted during a frame drag/resize: the engine moves the
 * frame by transform and commits once, firing `terminal-panel-resize`, which
 * refits the terminal in place.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderGit, GitCompare, Loader2, Maximize2, Minimize2, Pencil } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { BranchPicker } from '../dialogs/BranchPicker';
import { LaunchOverlay } from '../LaunchOverlay';
import { HeaderActionButton } from '../HeaderActionButton';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { KebabMenu } from '../KebabMenu';
import { CommandPalettePopover } from '../dialogs/task-detail/CommandPalettePopover';
import { useHeaderPillOverflow, type HeaderPillSpec } from '../dialogs/task-detail/useHeaderPillOverflow';
import { resolveTerminalBackground } from '../../hooks/useTerminal';
import { ContextBar } from '../terminal/ContextBar';
import { CommandTerminalPane, type TerminalGridGetter } from './CommandTerminalPane';
import { useSessionStore } from '../../stores/session-store';
import { transientKey } from '../../stores/session-store/transient-session-slice';
import { findAdoptableTransientSession } from '../../stores/session-store/transient-recovery';
import { commandTerminalChangesEntityId } from '../../stores/session-store/task-changes-panel-slice';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { shortcutIcon } from '../../utils/swimlane-icons';
import { resolveProjectRoot } from '../../../shared/git-utils';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { useLayerStore, windowIdsInReadingOrder } from '../../window-manager';
import type { ManagedWindow } from '../../window-manager';
import { runTerminalLayoutChange, terminalLayoutScopeOf } from '../../utils/terminal-layout-transition';
import type { AgentCommand, Session } from '../../../shared/types';
import { useCommandTerminalLayer } from './command-terminal-context';
import { CommandTerminalMenuItems } from './CommandTerminalMenuItems';
import { runCommandTerminalShortcut } from './command-terminal-shortcuts';
import { CommandTerminalNameField } from './CommandTerminalNameField';
import { useCommandTerminalRename } from './useCommandTerminalRename';
import { StopButtonIcon } from './StopButtonIcon';
import { killCommandTerminalInSlot } from './stop-command-terminal';
import { startCommandTerminalSwapDrag } from './swap-drag';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import { describeIpcError, asSentence } from '../../lib/ipc-error';

const ChangesPanel = lazy(() => import('../dialogs/task-detail/changes/ChangesPanel').then((module) => ({ default: module.ChangesPanel })));

/** What a window attaches to at mount; see `resolveMountAttach`. */
type MountAttach =
  | { kind: 'reattach'; sessionId: string }
  | { kind: 'adopt'; sessionId: string; session: Session }
  | null;

/**
 * Decide, from the store as it stands at the first render, whether the slot's
 * window reattaches to its own live PTY, adopts a reload survivor, or spawns.
 *
 * A stale map entry (the session died while the layer was hidden and the exit
 * is not yet applied) is not a reattach: it falls through to the adopt check
 * and then to a spawn, with the launch shimmer. Being adoptable is a strictly
 * stronger condition than "this is an HMR remount": it means main is running a
 * live PTY for this exact slot, which is reason enough to attach shimmer-free
 * however the renderer got here, including a cold page reload, where the map
 * is gone and the HMR flag reads false.
 */
function resolveMountAttach(slot: string): MountAttach {
  const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
  if (!currentProjectId) return null;
  const state = useSessionStore.getState();
  const existing = state.transientSessions[transientKey(currentProjectId, slot)];
  if (existing && state.sessions.some((session) => session.id === existing.sessionId && session.status === 'running')) {
    return { kind: 'reattach', sessionId: existing.sessionId };
  }
  const adoptable = findAdoptableTransientSession(state.sessions, state.transientSessions, currentProjectId, slot);
  if (adoptable) return { kind: 'adopt', sessionId: adoptable.id, session: adoptable };
  return null;
}

interface CommandTerminalWindowProps {
  managedWindow: ManagedWindow;
  /** True while the frame is maximized (driven by the window store). */
  isMaximized: boolean;
}

export function CommandTerminalWindow({ managedWindow, isMaximized }: CommandTerminalWindowProps) {
  const { t } = useLingui();
  const windowId = managedWindow.id;
  // The window's durable anchor IS its Command Terminal slot id (`slot-1`,
  // `slot-2`, ...). It pairs the persistent window to its ephemeral PTY across
  // hide/reopen and project switches; the transient session is keyed by it.
  const slot = managedWindow.anchor;
  // This window's own Changes-panel entity id (namespaced by slot), so the
  // open flag and per-entity panel state (selected file, scroll, scope, ...)
  // never leak across Command Terminal windows.
  const commandTerminalEntityId = commandTerminalChangesEntityId(slot);
  const layerStore = useLayerStore();
  const closeWindow = layerStore((state) => state.closeWindow);
  const setExpandedWindow = layerStore((state) => state.setExpandedWindow);
  const canExpand = layerStore((state) => Object.keys(state.windows).length > 1);
  const isExpanded = layerStore((state) => state.expandedWindowId === windowId);
  // Expand and Restore resize terminals: the new layout shows at once, and each
  // terminal holds its frame until it has repainted.
  const changeLayout = useCallback((change: () => void) => {
    runTerminalLayoutChange(terminalLayoutScopeOf(document.querySelector(`[data-testid="window-frame-${windowId}"]`)), change);
  }, [windowId]);
  const handleToggleExpanded = useCallback(
    () => changeLayout(() => setExpandedWindow(isExpanded ? null : windowId)),
    [changeLayout, setExpandedWindow, isExpanded, windowId],
  );
  // The other terminals in the order they tile, for the swap drag. None while
  // one is expanded: only one tile is on screen then.
  const swapTargetIds = layerStore(useShallow((state) =>
    (state.expandedWindowId === null ? windowIdsInReadingOrder(state.tileTree).filter((id) => id !== windowId) : [])));
  const swapWindows = layerStore((state) => state.swapWindows);
  // A press on the header's empty space starts a swap drag; its controls keep their clicks.
  const handleHeaderPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (swapTargetIds.length === 0) return;
    if ((event.target as HTMLElement).closest('button, a, input, [role="button"], [role="menu"], [role="menuitem"]')) return;
    startCommandTerminalSwapDrag(event, {
      windowId,
      windowIds: [windowId, ...swapTargetIds],
      swap: swapWindows,
      terminalBackground: resolveTerminalBackground(useConfigStore.getState().config.terminal.colors),
    });
  }, [swapTargetIds, windowId, swapWindows]);
  const { hideLayer, resumeBeside } = useCommandTerminalLayer();

  // What this window attaches to at mount, decided ONCE, before the first
  // paint, so the mount effect below only performs side effects and the two
  // states seeded from it never need a synchronous set inside that effect.
  // `reattach`: the slot's map entry names a live PTY (the layer was hidden
  // and reopened, or an HMR remount). `adopt`: no map entry, but main still
  // runs a PTY stamped with this slot (a renderer reload destroys the map while
  // every transient PTY survives; `syncSessions` normally re-pairs first, so
  // this covers a window that mounts ahead of it - strip it and
  // `command-terminal.spec.ts`'s "adopts the live PTY for its slot" test spawns
  // a second PTY and strands the first). `null`: spawn.
  const [mountAttach] = useState<MountAttach>(() => resolveMountAttach(slot));
  const [sessionId, setSessionId] = useState<string | null>(mountAttach?.sessionId ?? null);
  // The same id, for async completions and the store subscription below, which
  // must see a respawn's null at once rather than after the next render.
  const liveSessionIdRef = useRef<string | null>(mountAttach?.sessionId ?? null);
  // `takePendingResume`, for completions that run before it is declared.
  const takePendingResumeRef = useRef<() => void>(() => undefined);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  // Stop is async (kill IPC, then close). Without a pending state the button looks
  // inert for the duration, which is exactly how a DROPPED click presented, so the
  // two were indistinguishable to the user.
  const [stopping, setStopping] = useState(false);
  // Set inside an effect, not at ref init: StrictMode remounts synthetically in dev
  // and a ref-init value alone stays false after the synthetic cleanup.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const config = useConfigStore((s) => s.config);
  const rawProjectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  // Also the source for CommandTerminalPane's own pasteImageCapability lookup
  // (SESSION_INJECT_SETTINGS uses the same signal) - kept here too since
  // ContextBar's agentFallback below needs it regardless of the pane.
  const projectAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);
  // Resolve to the main repo root if the current project is a worktree.
  const projectPath = useMemo(() => (rawProjectPath ? resolveProjectRoot(rawProjectPath) : null), [rawProjectPath]);
  const shortcuts = useBoardStore((s) => s.shortcuts);
  const changesOpen = useSessionStore((s) => s.changesOpenTasks.has(commandTerminalEntityId));
  const toggleChangesOpen = useSessionStore((s) => s.toggleChangesOpen);
  const handleToggleChanges = useCallback(
    () => changeLayout(() => toggleChangesOpen(commandTerminalEntityId)),
    [changeLayout, toggleChangesOpen, commandTerminalEntityId],
  );

  const spawnedRef = useRef(false);
  // The branch picker can fold into the kebab; this drives the kebab-anchored
  // fallback dropdown ("Switch branch").
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  // Refs for the measured "priority-plus" header overflow (the title keeps a ~50ch
  // floor; pills reclaim the space above it and fold into the kebab as the window
  // narrows). Mirrors the task-detail header.
  const headerRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const titleSpanRef = useRef<HTMLSpanElement>(null);
  // The rename pencil sits right after the title and never folds, so the
  // overflow calc reserves it with the title.
  const renamePencilRef = useRef<HTMLButtonElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  // The terminal's name, and its name field. Main derives a name from the first
  // prompt or takes the user's, and stamps it on the session row, so it is read
  // from the replica, never held here. `commandTerminalDisplayName` (inside the
  // hook) is shared with the Agent Monitor, a phone's snapshot and the push
  // alert, so all four print the same name; until there is one, the slot number
  // tells the terminals apart, since every other fact in this header (agent,
  // model, branch, cwd) is the same for all of a project's terminals.
  const rename = useCommandTerminalRename(sessionId, slot);
  const renameDisabledReason = sessionId ? null : t`Available once the terminal starts`;
  // The Commands palette anchors to its pill when visible, else to the kebab (so
  // it still opens after the pill has folded into the overflow menu).
  const kebabWrapRef = useRef<HTMLDivElement>(null);

  const headerShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'header' || action.display === 'both')),
    [shortcuts],
  );

  const menuShortcuts = useMemo(
    () => shortcuts.filter((action) => action.command && (!action.display || action.display === 'menu' || action.display === 'both')),
    [shortcuts],
  );

  // Quick-access pills fold into the kebab in DESCENDING priority as the window
  // narrows, so the title always wins the space fight (useHeaderPillOverflow).
  const pillSpecs = useMemo<HeaderPillSpec[]>(() => {
    // Commands is kebab-only (a menu, not a one-tap toggle), matching the task-detail header.
    const specs: HeaderPillSpec[] = [];
    if (projectPath) specs.push({ id: 'folder', priority: 40 });
    if (projectPath) specs.push({ id: 'changes', priority: 30 });
    specs.push({ id: 'branch', priority: 25 });
    for (const action of headerShortcuts) specs.push({ id: `shortcut:${action.id ?? action.label}`, priority: 10 });
    return specs;
  }, [projectPath, headerShortcuts]);

  // Frozen while the name field is open: it replaces the title the calc
  // measures, and nothing in the header may shift while the user types.
  const hiddenPillIds = useHeaderPillOverflow(headerRef, leadingRef, trailingRef, titleSpanRef, pillsRef, pillSpecs, {
    titleSuffixRef: renamePencilRef,
    frozen: rename.editing,
  });
  const showPill = (id: string) => !hiddenPillIds.has(id);

  // A header-only shortcut that folded must surface in the kebab so the overflow
  // stays the complete action set. The built-in pills (Commands / Open folder /
  // Changes) are always in the kebab already; a 'both'-display shortcut is already
  // a menu shortcut, so it is skipped here.
  const overflowMenuShortcuts = useMemo(
    () => [
      ...menuShortcuts,
      ...headerShortcuts.filter(
        (action) =>
          hiddenPillIds.has(`shortcut:${action.id ?? action.label}`)
          && !menuShortcuts.some((menuAction) => (menuAction.id ?? menuAction.label) === (action.id ?? action.label)),
      ),
    ],
    [menuShortcuts, headerShortcuts, hiddenPillIds],
  );

  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const windowTitle = rename.displayName;
  // The branch is read from the pairing map, never held here: every path that
  // used to set it locally (spawn, adopt, a picker switch) already writes the
  // map entry, and the layer's HEAD tracker (`useTrackHeadBranch`) corrects
  // that entry on reattach and on every watcher fire. A per-window copy would
  // be a second, stale answer to a per-project question. The ref bridges the
  // one gap: a picker switch scrubs the entry before the respawn writes the new
  // one, and the pill should not flash the default branch in between. It is
  // state set during render (React's "information from previous renders"
  // pattern) rather than a ref, which render may neither read nor write.
  const mapBranch = useSessionStore((state) =>
    projectId ? state.transientSessions[transientKey(projectId, slot)]?.branch ?? null : null,
  );
  const [lastKnownBranch, setLastKnownBranch] = useState<string | null>(null);
  if (mapBranch && mapBranch !== lastKnownBranch) setLastKnownBranch(mapBranch);
  const branch = mapBranch ?? lastKnownBranch;

  // Spawn this slot's transient session on mount, or reattach to an existing one
  // (the PTY survives a layer hide, so reopening reattaches instead of
  // respawning). Each window owns its (project, slot) session.
  useEffect(() => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    const state = useSessionStore.getState();
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!currentProjectId) {
      hideLayer();
      return;
    }

    // Reattach only. No fetch, no checkout: the PTY may be running an agent,
    // and moving HEAD under it is the class of thing #558 refused. The branch
    // pill is corrected from live HEAD by the layer's tracker instead. The
    // session id was seeded from `mountAttach` at the first render.
    if (mountAttach?.kind === 'reattach') return;

    if (mountAttach?.kind === 'adopt') {
      state.adoptTransientSession(currentProjectId, slot, mountAttach.session);
      return;
    }

    // An Earlier row that opened this window asked it to resume a conversation.
    const resumeAgentSessionId = state.takeCommandTerminalResume(currentProjectId, slot) ?? undefined;
    state.spawnTransientSession(slot, undefined, undefined, resumeAgentSessionId)
      .then((result) => {
        liveSessionIdRef.current = result.session.id;
        setSessionId(result.session.id);
        // A row clicked while this terminal was still starting.
        takePendingResumeRef.current();
        if (result.checkoutError) {
          useToastStore.getState().addToast({ title: i18n._(msg`Couldn't check out branch`), message: result.checkoutError, variant: 'warning' });
        }
      })
      .catch((error) => {
        // Main's refusals (the cap, a taken slot, a shell that did not start)
        // are sentences written for the user; drop Electron's IPC decoration.
        useToastStore.getState().addToast({
          title: resumeAgentSessionId ? i18n._(msg`Couldn't resume conversation`) : i18n._(msg`Couldn't start Command Terminal`),
          message: asSentence(describeIpcError(error, String(error))),
          variant: 'error',
        });
        // Drop just this window; the layer's count bridge hides the layer if it
        // was the last one.
        closeWindow(windowId);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The agent is on screen: main's markAgentReady saw its first text after the
  // shell ran the spawn command, its first alt-screen entry, or its SessionStart
  // hook. Never the adapter's first-output detector or the usage seed: the shell's
  // startup frame trips the first, and the spawn seeds the second with the
  // model name, so either one showed the shell's prompt for seconds.
  const hasAgentOnScreen = useSessionStore((state) => (sessionId ? !!state.sessionFirstOutput[sessionId] : false));
  // The launch shimmer lifts when the agent is on screen, or when something
  // else says the terminal is ready: an exit before that, or a mount that
  // attached to a PTY already running (a reattach after the layer was hidden,
  // an HMR remount, or an adopted reload survivor), which must not flash the
  // launch overlay over a conversation that is already running. Derived, not
  // synced: `terminalReady` used to be state that an effect set, which is the
  // cascading-render shape React's compiler rules forbid. The latch holds the
  // two non-derivable answers.
  const [readyLatch, setReadyLatch] = useState(() => mountAttach !== null);
  const terminalReady = readyLatch || hasAgentOnScreen;
  // Whether the start in flight resumes a conversation, so the shimmer says so:
  // an Earlier row that opened this window left its request for the mount to
  // take, and a resume in place or a branch switch sets it as it respawns.
  const [startingResume, setStartingResume] = useState(() => {
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    return projectId !== null && !!useSessionStore.getState().pendingCommandTerminalResumes[transientKey(projectId, slot)];
  });
  // The launch overlay's label, before the spawn returns and after it, so the
  // hand-off from the window's overlay to the pane's reads as one surface.
  const launchLabel = startingResume ? t`Resuming conversation...` : t`Starting Command Terminal...`;

  // Lift the shimmer if the session exits before its agent is on screen.
  useEffect(() => {
    if (!sessionId || terminalReady) return;
    const cleanup = window.electronAPI.sessions.onExit((exitSessionId) => {
      if (exitSessionId === sessionId) setReadyLatch(true);
    });
    return cleanup;
  }, [sessionId, terminalReady]);

  // The transient session's activity, surfaced as the Stop button's ring (the
  // command-terminal counterpart to the task-detail pause button). Classified via
  // the shared idle-vs-active helpers, never inline literals. Gated on the session
  // having started so the ring only shows for a live session.
  const activity = useSessionStore((state) => (sessionId ? state.sessionActivity[sessionId] : undefined));
  const sessionRunning = terminalReady && !!sessionId;
  const isThinking = sessionRunning && isActive(activity);
  const isIdle = sessionRunning && requiresUserInteraction(activity);
  const showActivityRing = isThinking || isIdle;

  // Published by the mounted CommandTerminalPane; read by handleBranchChange
  // before killing the old session so the respawn can seed the new PTY at the
  // grid the user is already looking at (see spawnTransientSession's cols/rows).
  const gridGetterRef = useRef<TerminalGridGetter | null>(null);

  const defaultBranch = config.git.defaultBaseBranch || 'main';

  // A branch switch and a resume in place both end this slot's terminal and
  // start another in it, so the window, its slot and its grid stay. Each caller
  // reads the grid BEFORE the kill (the pane unmounts, and clears its getter,
  // once sessionId flips to null, and the awaited spawn IPC is not guaranteed
  // to happen after that unmount commits) and clears liveSessionIdRef before
  // its first await, so a resume asked for mid-respawn waits for the new
  // terminal rather than starting a second respawn of this slot.
  const stopForRespawn = useCallback(async (projectId: string): Promise<void> => {
    // Act on the outcome here too, not just in handleTerminate: this path scrubs the
    // slot and immediately spawns a replacement on it, so a kill that failed may leave
    // the old PTY running and unreachable. Warn, then still try the respawn: if the old
    // row is gone it succeeds, and if it lives main refuses its slot (`slot-taken`) and
    // the caller's catch says so. The kill handler's only refusal (a task's session)
    // cannot reach this path, so 'failed' means the invoke itself failed.
    const killOutcome = await useSessionStore.getState().killTransientSessionBySlot(projectId, slot);
    if (killOutcome === 'failed') {
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't stop the old terminal`),
        message: i18n._(msg`Its process may still be running.`),
        variant: 'warning',
      });
    }
    setSessionId(null);
    setReadyLatch(false);
  }, [slot]);

  const spawnInSlot = useCallback(async (
    grid: { cols: number; rows: number } | undefined,
    branch?: string,
    resumeAgentSessionId?: string,
  ) => {
    const result = await useSessionStore.getState().spawnTransientSession(slot, branch, grid, resumeAgentSessionId);
    liveSessionIdRef.current = result.session.id;
    setSessionId(result.session.id);
    // A row clicked while this terminal started opens beside it.
    takePendingResumeRef.current();
    return result;
  }, [slot]);

  // Kill this slot's session, checkout the new branch, and respawn it.
  const handleBranchChange = useCallback(async (newBranch: string) => {
    const resolvedBranch = newBranch || defaultBranch;
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!currentProjectId) return;
    const grid = gridGetterRef.current?.() ?? undefined;
    liveSessionIdRef.current = null;
    try {
      await stopForRespawn(currentProjectId);
      setStartingResume(false);
      const result = await spawnInSlot(grid, resolvedBranch);
      if (result.checkoutError) {
        useToastStore.getState().addToast({ title: i18n._(msg`Couldn't check out branch`), message: result.checkoutError, variant: 'warning' });
      }
    } catch (error) {
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't switch branch`),
        message: asSentence(describeIpcError(error, String(error))),
        variant: 'error',
      });
    }
  }, [defaultBranch, stopForRespawn, spawnInSlot]);

  // Resume an earlier conversation IN PLACE of this terminal, which the panel's
  // Earlier list asks for only while nothing has reached the terminal yet
  // (`Session.hasUserInput`).
  const resumeInPlace = useCallback(async (agentSessionId: string) => {
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!currentProjectId) return;
    const grid = gridGetterRef.current?.() ?? undefined;
    // The branch the ended terminal showed, for a fresh one if main refuses the resume.
    const branch = useSessionStore.getState().transientSessions[transientKey(currentProjectId, slot)]?.branch ?? undefined;
    liveSessionIdRef.current = null;
    try {
      await stopForRespawn(currentProjectId);
      setStartingResume(true);
      await spawnInSlot(grid, undefined, agentSessionId);
    } catch (error) {
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't resume conversation`),
        message: asSentence(describeIpcError(error, String(error))),
        variant: 'error',
      });
      // Main refuses a conversation another terminal holds or one it can no
      // longer find only after this slot's unused terminal has ended, so a fresh
      // one takes its place and the refusal costs nothing. The window goes only
      // when that start fails too.
      setStartingResume(false);
      try {
        await spawnInSlot(grid, branch);
      } catch {
        closeWindow(windowId);
      }
    }
  }, [slot, stopForRespawn, spawnInSlot, closeWindow, windowId]);

  // Take a resume the Earlier list asked of this slot, once the slot has a live
  // terminal. The list judged that terminal unused when it asked; if something
  // reached it since (or it is itself a resumed one), the conversation opens
  // beside it instead, because a used terminal is never replaced.
  const takePendingResume = useCallback(() => {
    const liveSessionId = liveSessionIdRef.current;
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!liveSessionId || !currentProjectId) return;
    const state = useSessionStore.getState();
    if (!state.pendingCommandTerminalResumes[transientKey(currentProjectId, slot)]) return;
    const agentSessionId = state.takeCommandTerminalResume(currentProjectId, slot);
    if (!agentSessionId) return;
    const used = state.sessions.find((session) => session.id === liveSessionId)?.hasUserInput === true;
    if (used) resumeBeside(agentSessionId);
    else void resumeInPlace(agentSessionId);
  }, [slot, resumeInPlace, resumeBeside]);
  useEffect(() => {
    takePendingResumeRef.current = takePendingResume;
  }, [takePendingResume]);
  useEffect(() => useSessionStore.subscribe((state, previous) => {
    if (state.pendingCommandTerminalResumes !== previous.pendingCommandTerminalResumes) takePendingResume();
  }), [takePendingResume]);

  // Stop = destroy THIS terminal's PTY and close its window. The layer's count
  // bridge hides the whole layer when the last window closes. Hiding the layer
  // (the X / Ctrl+Shift+P / backdrop) is separate and keeps every PTY alive.
  //
  // The window closes on EVERY path, including a kill that found nothing to kill:
  // the user asked for this terminal to go away. All three outcomes used to be
  // silent, so a kill that quietly did nothing looked exactly like the dropped
  // click this button was also suffering from.
  //
  // Only 'failed' is surfaced. 'no-session' is deliberately quiet even though it
  // carries the same "a PTY may still be running" risk, because in the case that
  // actually reaches it the window is genuinely all there is to close. The one
  // known gap: Stop clicked while the initial spawn IPC is still in flight finds
  // no map entry yet (spawnTransientSession inserts it only after the await), so
  // the spawn completes unattended and the next layer-open reconciles a window
  // back for it. Closing the spawn race needs cancellation plumbed through the
  // mount effect; until then this path cannot tell that case apart from a slot
  // that never had a PTY, which is why it stays silent rather than crying wolf.
  const handleTerminate = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    await killCommandTerminalInSlot(slot);
    // The rest re-tile into its space, holding their frames until they repaint.
    changeLayout(() => closeWindow(windowId));
    // This runs on essentially every Stop, not just the rare path, right after the
    // close. Usually it is a harmless setState just ahead of that unmount. It is load-bearing only when
    // the close is a no-op (an id the store no longer holds, which closeWindow
    // returns early on), where no unmount ever follows and the button would
    // otherwise be stranded disabled with a spinner and no way back.
    if (mountedRef.current) setStopping(false);
  }, [changeLayout, closeWindow, windowId, slot, stopping]);

  // Enter or Escape in the name field hands the keyboard back to this terminal.
  const focusThisTerminal = useCallback(() => {
    // arrival-focus-ok: the user's own Enter or Escape in this terminal's name
    // field, which they opened from its header; never an arriving terminal.
    document.querySelector<HTMLElement>(`[data-testid="window-frame-${windowId}"] .xterm-helper-textarea`)?.focus();
  }, [windowId]);

  // What a rail row's menu (or a collapsed-rail chip's) asked of this terminal:
  // the rail expanded it and left the request, and the window opens the thing
  // where the user can see it. One frame later, so the expand that made this
  // window the visible one has committed (it is `inert` until then).
  const startRename = rename.startEditing;
  const takeWindowAction = useCallback(() => {
    const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
    if (!currentProjectId) return;
    const action = useSessionStore.getState().takeCommandTerminalWindowAction(currentProjectId, slot);
    if (!action) return;
    requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      if (action === 'commands') setShowCommandPalette(true);
      else if (action === 'switch-branch') setBranchMenuOpen(true);
      else if (action === 'toggle-changes') handleToggleChanges();
      else startRename();
    });
  }, [slot, handleToggleChanges, startRename]);
  useEffect(() => useSessionStore.subscribe((state, previous) => {
    if (state.pendingCommandTerminalWindowActions !== previous.pendingCommandTerminalWindowActions) takeWindowAction();
  }), [takeWindowAction]);

  const handleCommandSelect = useCallback((command: AgentCommand) => {
    setShowCommandPalette(false);
    if (!sessionId) return;
    window.electronAPI.sessions.write(sessionId, command.displayName + '\n');
  }, [sessionId]);

  const handleShortcutExecute = useCallback((action: { command: string }) => {
    runCommandTerminalShortcut(action, projectPath, branch);
  }, [projectPath, branch]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" data-testid="command-terminal-window" data-command-slot={slot}>
      {/* Header. Priority-plus layout: the title keeps a ~50ch floor; the pills
          reclaim the space above it and fold into the kebab as the window narrows
          (useHeaderPillOverflow). */}
      <div
        ref={headerRef}
        className={`flex items-center gap-3 px-4 h-[54px] border-b border-edge flex-shrink-0 select-none min-w-0 ${
          swapTargetIds.length > 0 ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        onPointerDown={handleHeaderPointerDown}
        data-testid="command-bar-header"
      >
        {/* Leading cluster: Stop (protected, measured as one unit). */}
        <div ref={leadingRef} className="flex items-center flex-shrink-0">
          {/* StopButtonIcon's branches all render through IconSlot, so the node under the
              pointer survives an activity change mid-press (see IconSlot). */}
          <Tooltip label={stopping ? t`Stopping terminal` : t`Stop terminal`}>
            <button
              onClick={handleTerminate}
              disabled={stopping}
              className={`inline-flex items-center justify-center p-1 rounded-full transition-colors flex-shrink-0 disabled:cursor-not-allowed ${
                stopping ? 'text-fg-muted' : showActivityRing ? 'hover:bg-surface-hover' : 'text-red-400 hover:bg-red-400/10'
              }`}
              // Tracks `stopping` like the tip and the kebab item's label: an explicit
              // aria-label wins the accessible-name computation, so leaving it static would
              // hide the pending state from exactly the users who cannot see the spinner.
              aria-label={stopping ? t`Stopping terminal` : t`Stop terminal`}
              data-testid="command-bar-terminate-button"
            >
              <StopButtonIcon isThinking={isThinking} isIdle={isIdle} stopping={stopping} />
            </button>
          </Tooltip>
        </div>

        {/* Title and its rename pencil - the overflow calc reserves only a ~50ch
            floor of the title (not the full width) plus the pencil, so pills
            reclaim the space above it. The panel moves as a whole by its own
            header, so a terminal's title drags nothing. While the user renames,
            the name field takes the place of both. */}
        <div className="flex flex-1 min-w-[64px] items-center gap-1.5">
          {rename.editing ? (
            <CommandTerminalNameField
              initialName={windowTitle}
              slot={slot}
              onCommit={(value, byKey) => {
                rename.commit(value);
                if (byKey) focusThisTerminal();
              }}
              onCancel={() => {
                rename.cancel();
                focusThisTerminal();
              }}
              className="text-base font-semibold leading-6"
              data-testid="command-bar-name-field"
            />
          ) : (
            <>
              {/* Content-sized span so its scrollWidth measures the TEXT width;
                  useHeaderPillOverflow reserves up to a ~50ch floor of it. A long
                  name is cut short before the pencil, which never moves out. */}
              <Tooltip label={windowTitle}>
                <span
                  ref={titleSpanRef}
                  className="min-w-0 text-base font-semibold text-fg truncate"
                  data-testid="command-bar-label"
                >
                  {windowTitle}
                </span>
              </Tooltip>
              {/* The board column header's pattern: a small pencil right after the
                  name it changes, faint at rest. */}
              <Tooltip label={tipLabel({ disabled: sessionId === null, disabledReason: renameDisabledReason, tip: t`Rename terminal` })}>
                <button
                  ref={renamePencilRef}
                  type="button"
                  onClick={rename.startEditing}
                  disabled={sessionId === null}
                  className="inline-flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-secondary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-faint"
                  aria-label={t`Rename terminal`}
                  data-testid="command-bar-rename"
                >
                  <Pencil size={14} />
                </button>
              </Tooltip>
            </>
          )}
        </div>

        {/* Quick-access pills - each wrapped with `data-pill-id` so the overflow
            calc can measure it; only the ones that fit are rendered. */}
        <div ref={pillsRef} className="flex items-center gap-3 flex-shrink-0">
          {/* Open folder pill - icon-only. The command terminal always runs in the
              project git dir (never a worktree), so the FolderGit glyph matches the
              task-detail no-worktree case; the path shows once the folder opens. */}
          {projectPath && showPill('folder') && (
            <div data-pill-id="folder" className="flex-shrink-0">
              <HeaderActionButton
                icon={FolderGit}
                onClick={() => window.electronAPI.shell.openPath(projectPath)}
                tip={t`Open project folder`}
                testId="command-bar-folder-button"
              />
            </div>
          )}

          {projectPath && showPill('changes') && (
            <div data-pill-id="changes" className="flex-shrink-0">
              <HeaderActionButton
                icon={GitCompare}
                onClick={handleToggleChanges}
                active={changesOpen}
                tip={changesOpen ? t`Hide changes` : t`Show changes`}
                ariaLabel={t`Toggle changes`}
                testId="command-bar-changes-toggle"
              />
            </div>
          )}

          {showPill('branch') && (
            <div data-pill-id="branch" className="flex-shrink-0">
              <BranchPicker
                value={branch || ''}
                defaultBranch={defaultBranch}
                onChange={handleBranchChange}
              />
            </div>
          )}

          {headerShortcuts.map((action) => {
            const pillId = `shortcut:${action.id ?? action.label}`;
            if (!showPill(pillId)) return null;
            const ActionIcon = shortcutIcon(action.icon);
            return (
              <div key={pillId} data-pill-id={pillId} className="flex-shrink-0">
                <HeaderActionButton
                  icon={ActionIcon}
                  onClick={() => handleShortcutExecute(action)}
                  tip={action.command}
                  label={action.label}
                  testId={`command-bar-shortcut-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
                />
              </div>
            );
          })}
        </div>

        {/* Trailing controls (always protected, so they never get clipped): the
            kebab. There is no per-window hide/X - Stop destroys this terminal; the
            panel's X, the backdrop, Ctrl+Shift+W and Ctrl+Shift+P hide the whole
            layer. */}
        <div ref={trailingRef} className="flex items-center gap-3 flex-shrink-0">
          <div ref={kebabWrapRef} className="flex-shrink-0">
            <KebabMenu>
              {(close) => (
                // The same list a Running row's right-click shows.
                <CommandTerminalMenuItems
                  close={close}
                  testIdPrefix="command-bar-kebab"
                  onRename={rename.startEditing}
                  renameDisabledReason={renameDisabledReason}
                  projectPath={projectPath}
                  onOpenFolder={() => { if (projectPath) window.electronAPI.shell.openPath(projectPath); }}
                  onCommands={() => setShowCommandPalette(true)}
                  onSwitchBranch={() => setBranchMenuOpen(true)}
                  changesOpen={changesOpen}
                  onToggleChanges={handleToggleChanges}
                  shortcuts={overflowMenuShortcuts}
                  onShortcut={handleShortcutExecute}
                  stopping={stopping}
                  onStop={() => { void handleTerminate(); }}
                />
              )}
            </KebabMenu>
          </div>

          {/* Kebab-anchored branch dropdown, shown when the inline branch pill has
              folded into the overflow menu ("Switch branch"). Renders nothing until
              opened. */}
          <BranchPicker
            value={branch || ''}
            defaultBranch={defaultBranch}
            onChange={handleBranchChange}
            hideTrigger
            open={branchMenuOpen}
            onOpenChange={setBranchMenuOpen}
            anchorRef={kebabWrapRef}
          />

          {/* Expand fills the panel with this terminal; the others keep running
              behind it and list in the rail. Only beside another terminal: a
              lone one already fills the panel. Restore is never off: the panel
              grows to fit the grid again. */}
          {canExpand && (
            <Tooltip label={isExpanded ? t`Restore the grid` : t`Expand terminal`}>
              <button
                type="button"
                onClick={handleToggleExpanded}
                className={`p-1.5 rounded transition-colors flex-shrink-0 ${
                  isExpanded ? 'bg-surface-hover text-fg' : 'text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover'
                }`}
                aria-label={isExpanded ? t`Restore the grid` : t`Expand terminal`}
                data-testid="command-bar-expand"
              >
                {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </Tooltip>
          )}
        </div>

        {/* Commands palette: rendered once at the header root. Commands is kebab-only
            now (no header pill), so it always anchors to the kebab. */}
        {showCommandPalette && (
          <CommandPalettePopover
            triggerRef={kebabWrapRef}
            cwd={projectPath ?? undefined}
            onSelect={handleCommandSelect}
            onClose={() => setShowCommandPalette(false)}
          />
        )}
      </div>

      {/* Body */}
      <div className="relative flex flex-1 min-h-0">
        {/* Terminal. min-w-0 lets this flex item shrink below the xterm's content
            width when the window narrows; without it `min-width: auto` pins the pane
            to the terminal's column width, so it overflows the window and fit() reads
            the stale (too-wide) size and never reduces columns. overflow-hidden clips
            the brief pre-fit overflow. Mirrors the Changes panel sibling. */}
        <div className={`${changesOpen ? 'w-1/2' : 'flex-1'} relative min-w-0 overflow-hidden`} style={{ backgroundColor: resolveTerminalBackground(config.terminal.colors) }}>
          {/* Covers the spawn in flight, before there is a pane. From then on
              the pane draws the overlay inside its own `data-terminal-host`
              until the agent is on screen (see CommandTerminalPane). */}
          {!sessionId && <LaunchOverlay label={launchLabel} />}
          {/* Keyed (and gated, not just keyed) by session id: useTerminal is
              unmount-only teardown, so a session swap on a live instance would
              leave onData/onResize/clipboard/WebGL bound to the dead session.
              Gating on sessionId (rather than keying an always-mounted subtree)
              matters because sessionId goes null mid-switch (see
              handleBranchChange) - a null key would mount a throwaway Terminal
              with no onData/onResize, then tear it down. The pane mounts while
              the agent is still starting so its fit sizes the PTY before the
              agent's first frame. See CommandTerminalPane.tsx. */}
          {sessionId && (
            <CommandTerminalPane
              key={sessionId}
              sessionId={sessionId}
              isMaximized={isMaximized}
              ready={terminalReady}
              launchLabel={launchLabel}
              gridGetterRef={gridGetterRef}
            />
          )}
        </div>

        {/* Changes panel */}
        {changesOpen && projectPath && (
          <div className="w-1/2 min-h-0 border-l border-edge">
            <PanelErrorBoundary panel="Changes panel" message={t`Failed to load the Changes panel`}>
              <Suspense
                fallback={
                  <div className="flex items-center justify-center h-full">
                    <Loader2 size={20} className="animate-spin text-fg-muted" />
                  </div>
                }
              >
                {/* The effective base (board-overlaid), not "HEAD": the Working and
                    Staged scopes never read baseBranch, and the Branch scope, the
                    ahead/behind, and the base badge all measure against it. A literal
                    "HEAD" resolved origin/HEAD, the remote's default branch, which is
                    not the project's base when the two differ. */}
                <ChangesPanel
                  entityId={commandTerminalEntityId}
                  projectPath={projectPath}
                  baseBranch={defaultBranch}
                />
              </Suspense>
            </PanelErrorBoundary>
          </div>
        )}
      </div>

      {sessionId && <ContextBar sessionId={sessionId} agentFallback={projectAgent} />}
    </div>
  );
}
