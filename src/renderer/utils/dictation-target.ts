// The managers come from the deep path, not the `../window-manager` barrel: the
// barrel also re-exports the layer COMPONENTS, which reach the task-detail tree
// and back to session-store. Since session-store now imports the arrival-focus
// arbiter, which imports this module, going through the barrel would put that
// whole component tree in the store's import graph - and neither module
// self-accepts, so a Fast Refresh anywhere in it would re-evaluate the store and
// hand a second instance to a mounted tree (hmr-patterns Pattern E).
import { boardWindowManager, commandWindowManager, monitorWindowManager } from '../window-manager/store/window-store';
import { isLayerMounted } from '../window-manager/store/layer-mount-registry';
import { useSessionStore } from '../stores/session-store';
import { useProjectStore } from '../stores/project-store';
import { derivePanelSessionId } from './focused-sessions';
import { transientKey, type TransientSessionEntry } from '../stores/session-store/transient-session-slice';

/**
 * Resolving the ONE terminal that dictated text should be injected into. The
 * renderer owns single-active-terminal truth across three surfaces (the bottom
 * panel, task-detail windows, and Command Terminal windows); the main process
 * only tracks a focused SET. So we resolve here and pass the chosen session id
 * explicitly on the commit IPC, and refuse to guess when nothing resolves.
 *
 * `resolveFocusedWindowTerminal` is the shared half of that question ("which
 * terminal-hosting window holds window-layer focus"), also consumed by the
 * arrival-focus arbiter in `terminal-arrival-focus.ts`. The two differ in POLICY,
 * not in the resolution: dictation must resolve something and so falls through to a
 * wider chain, while arrival focus must abstain and so stops there. Keeping one
 * resolver is what stops those two answers drifting apart.
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

/**
 * The session behind the terminal the user most recently focused.
 *
 * Exported for the agent-input guard, which must answer a DIFFERENT question
 * from `resolveDictationTarget`: not "which terminal should this land in" but
 * "which terminal was the user actually in when the agent took their focus". It
 * snapshots this at ARM time, while the user's terminal still holds focus, and
 * writes only there. It must not use the dictation chain, whose tier 1 is the
 * focused WINDOW - which an agent-opened window becomes, by design, without ever
 * holding DOM focus. See `.claude/rules/agent-driven-focus.md`.
 */
export function getLastFocusedTerminalSessionId(): string | null {
  return lastFocusedTerminalSessionId;
}

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.lastFocusedTerminalSessionId = lastFocusedTerminalSessionId;
  });
}

/** True only when the id names a session the manager currently has running. */
export function isRunningSession(sessionId: string | null): sessionId is string {
  if (!sessionId) return false;
  return useSessionStore
    .getState()
    .sessions.some((session) => session.id === sessionId && session.status === 'running');
}

/** A terminal-hosting window holding window-layer focus. `sessionId` is null when
 *  that window's task has not spawned a session yet, which is NOT the same as
 *  "no window is focused" - the window still owns the user's attention. */
export interface FocusedWindowTerminal {
  sessionId: string | null;
  /** That window was opened or raised by an AGENT, so its focus carries no user
   *  intent (see `.claude/rules/agent-driven-focus.md`).
   *
   *  DICTATION DELIBERATELY IGNORES THIS. It is the same resolver but a different
   *  POLICY: dictation is a later, separate user action and must resolve a target
   *  wherever the window came from, while arrival focus must abstain because
   *  nothing about that window says the user asked to type in it. Consuming this
   *  field in the dictation chain would silently drop the user's speech. */
  openedByAgent: boolean;
}

/** Layers in paint order, front-most first: the Command Terminal layer renders
 *  over the Agent Monitor, which renders over the board. */
const TERMINAL_WINDOW_LAYERS = [commandWindowManager, monitorWindowManager, boardWindowManager];

/**
 * The terminal-hosting window that currently holds window-layer focus, across
 * EVERY layer. Returns null when no layer has one; that is the "nothing
 * resolves" signal, and each caller applies its own policy to it - dictation
 * falls through to a wider chain, arrival focus abstains.
 *
 * `sessionId` is resolved by ANCHOR, never read from `ManagedWindow.sessionId`.
 * That field is captured at open time and is never written back on spawn or
 * respawn, so a window opened on a task with no session keeps `null` forever and
 * a respawned session leaves it stale. Same resolution `useWindowSessionClaims`
 * uses, for the same reason.
 *
 * Exclusions: conversation windows (read-only transcript, no input surface),
 * unmounted layers (the stores deliberately outlive their subtrees, and an
 * unmounted layer hosts no xterm), and a hidden Command Terminal layer (hiding
 * keeps its windows, focus pointer, and PTYs alive, but a terminal nobody can
 * see must never win).
 */
export function resolveFocusedWindowTerminal(): FocusedWindowTerminal | null {
  for (const manager of TERMINAL_WINDOW_LAYERS) {
    if (!isLayerMounted(manager)) continue;
    const state = manager.store.getState();
    const focusedId = state.focusedWindowId;
    if (!focusedId) continue;
    const focusedWindow = state.windows[focusedId];
    if (!focusedWindow || focusedWindow.kind === 'conversation') continue;
    // Defensive: `retainWindows` already clears `focusedWindowId` when the focused
    // window becomes retained, so a retained window cannot be focused today.
    if (focusedWindow.retainedProjectId !== undefined) continue;

    if (focusedWindow.kind === 'command-terminal') {
      const sessionState = useSessionStore.getState();
      // Not visible means this layer is not the user's surface at all, so fall
      // through to the layers beneath rather than resolving it to null (which
      // would wrongly claim the user's attention for a hidden terminal).
      if (!sessionState.commandBarVisible) continue;
      return {
        sessionId: resolveFocusedCommandSessionId({
          commandBarVisible: sessionState.commandBarVisible,
          focusedCommandAnchor: focusedWindow.anchor,
          currentProjectId: useProjectStore.getState().currentProject?.id ?? null,
          transientSessions: sessionState.transientSessions,
        }),
        openedByAgent: focusedWindow.openedByAgent === true,
      };
    }

    const toTaskId = manager.options.anchorToTaskId;
    const taskId = toTaskId ? toTaskId(focusedWindow.anchor) : focusedWindow.anchor;
    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.taskId === taskId);
    return { sessionId: session?.id ?? null, openedByAgent: focusedWindow.openedByAgent === true };
  }
  return null;
}

/** Resolve the focused Command Terminal window's live session by its durable slot
 *  anchor. Gated on layer visibility because hiding the layer keeps the window,
 *  focusedWindowId, and PTY alive; a hidden terminal must never win injection over
 *  a visible one. Resolved by anchor (not the window's stored sessionId, which is
 *  always null for command windows - it is never written back on spawn/reattach/
 *  respawn) so a branch-switch respawn is picked up. */
export function resolveFocusedCommandSessionId(input: {
  commandBarVisible: boolean;
  focusedCommandAnchor: string | null;
  currentProjectId: string | null;
  transientSessions: Record<string, TransientSessionEntry>;
}): string | null {
  if (!input.commandBarVisible) return null;
  if (!input.focusedCommandAnchor || !input.currentProjectId) return null;
  const entry = input.transientSessions[transientKey(input.currentProjectId, input.focusedCommandAnchor)];
  return entry?.sessionId ?? null;
}

/**
 * Resolve the single injection target via a priority chain. Returns null when
 * no live terminal can be determined, so the caller can refuse to commit rather
 * than inject into the wrong terminal.
 */
export function resolveDictationTarget(): string | null {
  // 1. The focused terminal-hosting window, in any layer (Command Terminal,
  //    Agent Monitor, or board). Falls through when it names no running session,
  //    which covers both "no focused window" and "focused window, no session yet".
  const focusedWindowSessionId = resolveFocusedWindowTerminal()?.sessionId ?? null;
  if (isRunningSession(focusedWindowSessionId)) return focusedWindowSessionId;

  // 2. The last terminal the user focused anywhere.
  if (isRunningSession(lastFocusedTerminalSessionId)) return lastFocusedTerminalSessionId;

  // 3. The bottom panel's derived session.
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
