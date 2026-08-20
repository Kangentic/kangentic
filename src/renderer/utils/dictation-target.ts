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
import {
  isPasswordField,
  resolveFocusedContentEditable,
  resolveFocusedTextTarget,
  type ContentEditableTarget,
  type TextTargetElement,
} from './text-target';
import type { WebviewElement } from '../components/browser/webview-types';

/**
 * Resolving the ONE place dictated text should be injected into. The renderer
 * owns single-active-target truth across four surfaces (the bottom panel,
 * task-detail windows, Command Terminal windows, and any focused text input);
 * the main process only tracks a focused SET of terminals and knows nothing
 * about the fourth. So we resolve here, pass the chosen session id explicitly on
 * the commit IPC when the answer is a terminal, and refuse to guess when nothing
 * resolves.
 *
 * `resolveFocusedWindowTerminal` is the shared half of that question ("which
 * terminal-hosting window holds window-layer focus"), also consumed by the
 * arrival-focus arbiter in `terminal-arrival-focus.ts`. The two differ in POLICY,
 * not in the resolution: dictation must resolve something and so falls through to a
 * wider chain, while arrival focus must abstain and so stops there. Keeping one
 * resolver is what stops those two answers drifting apart.
 *
 * The text-input case is a tier ABOVE that shared resolver rather than a change
 * to it, so arrival focus is untouched by it: an arriving terminal's decision
 * has nothing to say about a focused `<input>`.
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
 * Where dictated text goes. A terminal is written to over IPC by session id; a
 * text input is written to directly in the renderer, so the element itself is
 * the target and there is no session behind it.
 */
export type DictationTarget =
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'input'; element: TextTargetElement }
  /** A `contenteditable` host - a rich-text editor. Separate from `input`
   *  because it has no `.value`: it is written with Selection + `insertText`,
   *  which is the route a real keystroke takes. */
  | { kind: 'contenteditable'; element: ContentEditableTarget }
  /** A field inside a Browser pane's guest page. Carries the `<webview>` rather
   *  than the field, because the field lives in another process and can only be
   *  reached through it (see `guest-text-target.ts`). WHICH field is resolved
   *  asynchronously by the caller, since the host cannot know it synchronously -
   *  from here `document.activeElement` is only ever the `<webview>` itself. */
  | { kind: 'guest'; webview: WebviewElement }
  /** Focus is somewhere dictation must REFUSE outright rather than fall past.
   *
   *  The distinction is load-bearing for a password box. Merely failing
   *  eligibility is not enough: the chain would carry on to the terminal tiers
   *  and type the user's spoken password into a live shell. Refusing stops the
   *  chain dead, and carries the reason so the chip can say what happened
   *  instead of the untrue "nothing focused". */
  | { kind: 'refused'; reason: 'password' };

/**
 * Resolve the single injection target via a priority chain. Returns null when
 * nothing can be determined, so the caller can refuse to commit rather than
 * inject into the wrong place.
 */
export function resolveDictationTarget(): DictationTarget | null {
  // 0. An eligible text input holds DOM focus. This outranks every window tier
  //    below, including a visible, focused Command Terminal: keyboard focus in a
  //    field the user is typing in is the most direct statement of intent there
  //    is, and the tiers below are all proxies for it. Eligibility is
  //    ALLOW-BY-DEFAULT (see `text-target.ts` for why the opt-in marker was
  //    inverted), so an ordinary settings field or search box IS a target; only
  //    the structural exclusions fall through to the terminal chain.
  const active = document.activeElement;

  // 0a. A password box. Refused, never fallen past - see the `refused` variant.
  if (isPasswordField(active)) return { kind: 'refused', reason: 'password' };

  const focusedInput = resolveFocusedTextTarget(active);
  if (focusedInput) return { kind: 'input', element: focusedInput };

  const focusedRichText = resolveFocusedContentEditable(active);
  if (focusedRichText) return { kind: 'contenteditable', element: focusedRichText };

  // 0b. A Browser pane's guest page holds focus. The `<webview>` is as far as
  //     this resolver can see: whether the guest's own focus is on a text field
  //     needs a round trip into it, which the caller does before recording.
  if (active?.tagName === 'WEBVIEW') {
    return { kind: 'guest', webview: active as WebviewElement };
  }

  // 1. The focused terminal-hosting window, in any layer (Command Terminal,
  //    Agent Monitor, or board). Falls through when it names no running session,
  //    which covers both "no focused window" and "focused window, no session yet".
  const focusedWindowSessionId = resolveFocusedWindowTerminal()?.sessionId ?? null;
  if (isRunningSession(focusedWindowSessionId)) return { kind: 'terminal', sessionId: focusedWindowSessionId };

  // 2. The last terminal the user focused anywhere.
  if (isRunningSession(lastFocusedTerminalSessionId)) {
    return { kind: 'terminal', sessionId: lastFocusedTerminalSessionId };
  }

  // 3. The bottom panel's derived session.
  const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
  const sessionState = useSessionStore.getState();
  const panelSessionId = derivePanelSessionId({
    activeSessionId: sessionState.activeSessionId,
    sessions: sessionState.sessions,
    currentProjectId,
    sessionActivity: sessionState.sessionActivity,
  });
  if (isRunningSession(panelSessionId)) return { kind: 'terminal', sessionId: panelSessionId };

  return null;
}
