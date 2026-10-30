import { useEffect, useLayoutEffect, useRef } from 'react';
import { useKeybinding } from './useKeybinding';
import { useBoardStore } from '../stores/board-store';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import { usePopOutStore } from '../stores/pop-out-store';
import { findSessionForTask } from '../stores/session-store/session-index';
import { popOutInstanceKey } from '../../shared/pop-out';
import { isCommandTerminalSession } from '../../shared/session-owner';
import { isAnyOverlayOpen } from '../utils/overlay-gate';
import { resolveFocusedWindowTerminal } from '../utils/dictation-target';
import { panelArrivalSessionId } from './useTerminalResize';
import {
  buildTerminalCycleList,
  cycleIndex,
  cycleStep,
  projectCycleOrder,
  type CycleDirection,
  type CycleTarget,
} from '../utils/cycle-targets';
import { boardWindowManager, commandWindowManager } from '../window-manager/store/window-store';
import { isLayerMounted } from '../window-manager/store/layer-mount-registry';
import { isWindowDormant } from '../window-manager/store/types';
import { onWorkspaceRestored } from '../window-manager/persistence/restore-workspace';

/** How long a Command Terminal landing waits for the layer and the slot's window. */
const COMMAND_WINDOW_WAIT_MS = 3000;
/** How long an all-projects landing waits for the project switch to restore. */
const PROJECT_LANDING_TIMEOUT_MS = 10_000;

export interface CycleShortcutsOptions {
  /** The Command Terminal panel, from `useCommandBar`. */
  commandBar: { open: () => void; close: () => void };
  /** The bottom panel. `rendered`: on screen at all (Board view, not hidden in
   *  Settings). `collapsed`: its EFFECTIVE collapse. `forceCollapsed`: that
   *  collapse is forced (a task window holds the terminals, or the Workflows
   *  view), the same value AppLayout hands `useTerminalResize`. A toggle while
   *  forced only rewrites the saved preference, so landing never toggles then. */
  panel: { rendered: boolean; collapsed: boolean; forceCollapsed: boolean; onToggleCollapse: () => void };
  /** A full-bleed overlay (Stats, Agent Monitor, Knowledge Graph) covers the app. */
  overlayShowing: boolean;
}

/** A landing in flight: the target a quick second press steps from, and
 *  whatever it is still waiting on (a frame, a listener, a timer). */
interface PendingLanding {
  target: CycleTarget;
  cleanups: Array<() => void>;
}

/**
 * Focus a window's terminal. Called a frame after the window is raised, since an
 * expanded Command Terminal frame leaves `inert` on the commit after the expand.
 */
function focusWindowTerminal(windowId: string): void {
  // arrival-focus-ok: a cycle keypress is the user naming this terminal.
  document.querySelector<HTMLElement>(`[data-testid="window-frame-${windowId}"] .xterm-helper-textarea`)?.focus();
}

/** The session of the board or Command Terminal window with this id, if any. */
function sessionIdForWindow(windowId: string): string | null {
  const sessions = useSessionStore.getState().sessions;
  const boardWindow = boardWindowManager.store.getState().windows[windowId];
  if (boardWindow?.kind === 'task-detail') return findSessionForTask(sessions, boardWindow.anchor)?.id ?? null;
  const commandWindow = commandWindowManager.store.getState().windows[windowId];
  if (!commandWindow) return null;
  const projectId = useProjectStore.getState().currentProject?.id ?? null;
  const session = sessions.find((candidate) =>
    isCommandTerminalSession(candidate)
    && candidate.projectId === projectId
    && candidate.commandTerminalSlot === commandWindow.anchor
    && candidate.status !== 'exited');
  return session?.id ?? null;
}

/** Projects whose Command Terminal is open in a window of its own. */
function projectsWithDetachedCommandTerminal(projectIds: readonly string[]): Set<string> {
  const openKeys = usePopOutStore.getState().openInstanceKeys;
  return new Set(projectIds.filter((projectId) => openKeys[popOutInstanceKey('command-terminal', { projectId, projectName: '' })]));
}

/**
 * Binds the cycle keys (GitHub #176): the next or previous terminal in this
 * project or in any project, and the next or previous project. A terminal is a
 * running board agent or a Command Terminal terminal, walked in the orders
 * `utils/cycle-targets.ts` builds.
 *
 * Every binding listens in the capture phase on `window`, ahead of xterm's own
 * capture listener on its textarea (which cancels every key it consumes), so the
 * keys work with a terminal focused. They do nothing while a dialog, the
 * settings panel, the search palette, or a full-bleed overlay is open, passing
 * the event through untouched unless it is aimed at a terminal (the Agent
 * Monitor's), where it is swallowed so the agent never receives it as Tab or
 * Shift+Tab. A held key cycles once and swallows its repeats.
 *
 * Landing on a board agent switches to the Board view if needed, then picks its
 * window when it has one; otherwise its panel tab when the panel can show it;
 * otherwise (the panel hidden in Settings, or held collapsed) it opens the
 * agent's window, the same as double-clicking the tab. A Command Terminal
 * terminal opens the panel on its slot. A terminal in another project switches
 * project first, then lands once that project's workspace has restored.
 */
export function useCycleShortcuts(options: CycleShortcutsOptions): void {
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const pendingRef = useRef<PendingLanding | null>(null);
  const pendingProjectIdRef = useRef<string | null>(null);
  // An unmount (a Fast Refresh that remounts AppLayout) cancels a landing in
  // flight, so its frames and timer never act through a stale render's options.
  useEffect(() => () => {
    const landing = pendingRef.current;
    pendingRef.current = null;
    if (landing) for (const cleanup of landing.cleanups.splice(0)) cleanup();
  }, []);

  function settle(landing: PendingLanding): void {
    for (const cleanup of landing.cleanups.splice(0)) cleanup();
    if (pendingRef.current === landing) pendingRef.current = null;
  }

  function beginLanding(target: CycleTarget): PendingLanding {
    if (pendingRef.current) settle(pendingRef.current);
    const landing: PendingLanding = { target, cleanups: [] };
    pendingRef.current = landing;
    return landing;
  }

  function onNextFrame(landing: PendingLanding, run: () => void): void {
    const frame = requestAnimationFrame(() => {
      if (pendingRef.current === landing) run();
    });
    landing.cleanups.push(() => cancelAnimationFrame(frame));
  }

  /** Retry `attempt` each frame until it reports done or `timeoutMs` passes. */
  function retryEachFrame(landing: PendingLanding, timeoutMs: number, attempt: () => boolean): void {
    const deadline = performance.now() + timeoutMs;
    let frame = 0;
    const tick = (): void => {
      if (pendingRef.current !== landing) return;
      if (attempt()) return;
      if (performance.now() >= deadline) {
        settle(landing);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    landing.cleanups.push(() => cancelAnimationFrame(frame));
  }

  /** The terminal the user is on: a pending landing's target, the window frame
   *  holding focus, the Command Terminal's focused window while that panel is
   *  showing (it covers the board), the bottom panel's selected tab while it is
   *  expanded, or the window that holds window-layer focus. */
  function resolveCurrentSessionId(): string | null {
    if (pendingRef.current) return pendingRef.current.target.sessionId;
    const focused = document.activeElement;
    const frameTestId = focused instanceof Element
      ? focused.closest('[data-testid^="window-frame-"]')?.getAttribute('data-testid')
      : null;
    if (frameTestId) {
      const fromWindow = sessionIdForWindow(frameTestId.slice('window-frame-'.length));
      if (fromWindow) return fromWindow;
    }
    // The Command Terminal is the front layer, so this resolves its focused
    // window, even before that terminal's xterm has taken the keyboard.
    if (useSessionStore.getState().commandBarVisible) {
      const fromCommandTerminal = resolveFocusedWindowTerminal()?.sessionId;
      if (fromCommandTerminal) return fromCommandTerminal;
    }
    const { panel } = optionsRef.current;
    if (panel.rendered && !panel.collapsed) {
      const panelSessionId = panelArrivalSessionId();
      if (panelSessionId) return panelSessionId;
    }
    return resolveFocusedWindowTerminal()?.sessionId ?? null;
  }

  function landOnAgent(
    landing: PendingLanding,
    target: Extract<CycleTarget, { kind: 'agent' }>,
    afterViewSwitch = false,
  ): void {
    // Task windows and the bottom panel show only on the Board view, so a press
    // from Backlog or Workflows switches there first and lands once the layout
    // has re-rendered (the panel options below are read from that render).
    const boardStore = useBoardStore.getState();
    if (boardStore.activeView !== 'board' && !afterViewSwitch) {
      boardStore.setActiveView('board');
      onNextFrame(landing, () => landOnAgent(landing, target, true));
      return;
    }
    const { commandBar, panel } = optionsRef.current;
    const sessionState = useSessionStore.getState();
    if (sessionState.commandBarVisible) commandBar.close();
    const boardState = boardWindowManager.store.getState();
    const taskWindow = Object.values(boardState.windows).find(
      (managed) => managed.kind === 'task-detail' && managed.anchor === target.taskId,
    );
    if (taskWindow && !isWindowDormant(taskWindow)) {
      boardState.focusWindow(taskWindow.id);
      onNextFrame(landing, () => {
        focusWindowTerminal(taskWindow.id);
        settle(landing);
      });
      return;
    }
    // A phone streaming the session holds its panel tab, so only a window shows it.
    const panelCanShow = !taskWindow
      && panel.rendered
      && !panel.forceCollapsed
      && !sessionState.mobileTerminalStreamedSessionIds.includes(target.sessionId);
    if (panelCanShow) {
      // Select first, so the expand's arrival-focus claim names the target.
      sessionState.selectActiveSession(target.sessionId);
      // The forced collapse is ruled out above, so this is the user's own.
      if (panel.collapsed) panel.onToggleCollapse();
    } else {
      // Opens the task's window, or un-parks the one closed with its Browser pane live.
      sessionState.setDetailTaskId(target.taskId);
    }
    onNextFrame(landing, () => settle(landing));
  }

  function landOnCommandTerminal(landing: PendingLanding, target: Extract<CycleTarget, { kind: 'command' }>): void {
    if (!useSessionStore.getState().commandBarVisible) optionsRef.current.commandBar.open();
    // The layer mounts only while the panel is open, and its slot reconcile
    // runs inside it, so the slot's window may not exist for a few frames.
    retryEachFrame(landing, COMMAND_WINDOW_WAIT_MS, () => {
      if (!isLayerMounted(commandWindowManager)) return false;
      const commandState = commandWindowManager.store.getState();
      const slotWindow = Object.values(commandState.windows).find((managed) => managed.anchor === target.slot);
      if (!slotWindow) return false;
      if (commandState.expandedWindowId !== null && commandState.expandedWindowId !== slotWindow.id) {
        commandState.setExpandedWindow(slotWindow.id);
      } else {
        commandState.focusWindow(slotWindow.id);
      }
      onNextFrame(landing, () => {
        focusWindowTerminal(slotWindow.id);
        settle(landing);
      });
      return true;
    });
  }

  function land(landing: PendingLanding, target: CycleTarget): void {
    if (target.kind === 'agent') landOnAgent(landing, target);
    else landOnCommandTerminal(landing, target);
  }

  function landInOtherProject(target: CycleTarget): void {
    const landing = beginLanding(target);
    pendingProjectIdRef.current = null;
    // The Command Terminal closes on a project change. An agent target hides it
    // first, as the Agent Monitor's go-to-project does; a Command Terminal
    // target reopens it on the new project once the switch has landed.
    if (target.kind === 'agent') useSessionStore.getState().requestHideCommandBar();
    const unsubscribe = onWorkspaceRestored((projectId) => {
      if (projectId !== target.projectId) return;
      unsubscribe();
      // The restore runs inside the switch effect, ahead of the window claims and
      // the panel's collapse re-render, so land a frame later.
      onNextFrame(landing, () => {
        if (useProjectStore.getState().currentProject?.id !== target.projectId) {
          settle(landing);
          return;
        }
        land(landing, target);
      });
    });
    landing.cleanups.push(unsubscribe);
    const timeout = setTimeout(() => settle(landing), PROJECT_LANDING_TIMEOUT_MS);
    landing.cleanups.push(() => clearTimeout(timeout));
    void useProjectStore.getState().openProject(target.projectId).then((outcome) => {
      if (outcome !== 'opened') settle(landing);
    });
  }

  function cycleTerminals(scope: 'project' | 'all', direction: CycleDirection): void {
    const projectState = useProjectStore.getState();
    const openProjectId = projectState.currentProject?.id ?? null;
    // While a press is still switching to another project, that project is
    // where the user is, so a quick next press steps from there and still
    // lands after the switch rather than in the project being left.
    const pendingTarget = pendingRef.current?.target ?? null;
    const switchingToProjectId = pendingTarget && pendingTarget.projectId !== openProjectId ? pendingTarget.projectId : null;
    const currentProjectId = switchingToProjectId ?? openProjectId;
    const projectIds = scope === 'all'
      ? projectCycleOrder(projectState.projects, projectState.groups).map((project) => project.id)
      : currentProjectId ? [currentProjectId] : [];
    if (projectIds.length === 0) return;
    const sessionState = useSessionStore.getState();
    const list = buildTerminalCycleList({
      projectIds,
      sessions: sessionState.sessions,
      remoteDetailTaskIds: sessionState.remoteDetailTaskIds,
      commandTerminalsElsewhere: projectsWithDetachedCommandTerminal(projectIds),
    });
    const index = cycleStep({ list, currentSessionId: resolveCurrentSessionId(), currentProjectId, projectIds, direction });
    if (index === -1) return;
    const target = list[index];
    if (target.projectId === openProjectId && switchingToProjectId === null) land(beginLanding(target), target);
    else landInOtherProject(target);
  }

  function cycleProjects(direction: CycleDirection): void {
    const projectState = useProjectStore.getState();
    const order = projectCycleOrder(projectState.projects, projectState.groups);
    const openProjectId = projectState.currentProject?.id ?? null;
    // Step from a switch still in flight, so quick presses keep advancing.
    const fromProjectId = pendingProjectIdRef.current ?? openProjectId;
    const currentIndex = fromProjectId === null ? -1 : order.findIndex((project) => project.id === fromProjectId);
    if (currentIndex !== -1 && order.length < 2) return;
    const nextIndex = cycleIndex(order.length, currentIndex, direction);
    if (nextIndex === -1) return;
    const nextProjectId = order[nextIndex].id;
    if (nextProjectId === openProjectId && pendingProjectIdRef.current === null) return;
    if (pendingRef.current) settle(pendingRef.current);
    pendingProjectIdRef.current = nextProjectId;
    void projectState.openProject(nextProjectId).finally(() => {
      if (pendingProjectIdRef.current === nextProjectId) pendingProjectIdRef.current = null;
    });
  }

  /** A dialog, the settings panel, the search palette or a full-bleed overlay
   *  covers the app, or projects have not loaded: the keys do nothing. */
  function isHeldOff(): boolean {
    return optionsRef.current.overlayShowing || isAnyOverlayOpen() || !useProjectStore.getState().hydrated;
  }
  // Held off, a key passes through untouched, except into a terminal (the Agent
  // Monitor's, say): xterm would send Ctrl+Tab as Tab and Ctrl+Shift+Tab as
  // Shift+Tab, which walks the agent's permission modes. There it is swallowed.
  const when = (): boolean => !isHeldOff() || keyboardFocusIsInTerminal();
  const bindingOptions = { capture: true, when };
  function shouldAct(event: KeyboardEvent | PointerEvent): boolean {
    return !isKeyRepeat(event) && !isHeldOff();
  }

  useKeybinding('session.cycleNext', (event) => {
    if (shouldAct(event)) cycleTerminals('project', 1);
  }, bindingOptions);
  useKeybinding('session.cyclePrev', (event) => {
    if (shouldAct(event)) cycleTerminals('project', -1);
  }, bindingOptions);
  useKeybinding('session.cycleAllNext', (event) => {
    if (shouldAct(event)) cycleTerminals('all', 1);
  }, bindingOptions);
  useKeybinding('session.cycleAllPrev', (event) => {
    if (shouldAct(event)) cycleTerminals('all', -1);
  }, bindingOptions);
  useKeybinding('project.cycleNext', (event) => {
    if (shouldAct(event)) cycleProjects(1);
  }, bindingOptions);
  useKeybinding('project.cyclePrev', (event) => {
    if (shouldAct(event)) cycleProjects(-1);
  }, bindingOptions);
}

/** Whether keyboard focus is inside an xterm (its helper textarea). */
function keyboardFocusIsInTerminal(): boolean {
  const focused = document.activeElement;
  return focused instanceof Element && focused.closest('.xterm') !== null;
}

/**
 * Whether a press is an auto-repeat of a held key. A held cycle key cycles once:
 * its repeats still match, so `useKeybinding` swallows them, and the handler
 * then does nothing. Gating them in `when` instead would pass them through to
 * the terminal just landed on, where a held Ctrl+Shift+Tab arrives as Shift+Tab
 * and walks the agent's permission modes. Any action can be rebound to a mouse
 * button, so the event may be a pointer one.
 */
function isKeyRepeat(event: KeyboardEvent | PointerEvent): boolean {
  return 'repeat' in event && event.repeat;
}
