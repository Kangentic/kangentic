/**
 * A Command Terminal's Browser pane: the store-level actions, the open and close
 * requests main pushes for it, and its saved layout.
 *
 * The pane is the task-detail Browser pane, unchanged, keyed by the slot's
 * owner key (`commandTerminalBrowserOwner`, src/shared/browser-owner.ts) in the
 * same session-store sets a task uses: `browserOpenTasks`, `browserHeldTasks`,
 * `browserGuestTasks`, `dividerRatio`. What differs is where it lives. A
 * `<webview>` dies the instant its node unmounts, and the Command Terminal panel
 * unmounts on every hide, project switch and Open in new window, so the pane
 * never renders inside the panel. `CommandTerminalBrowserHost` keeps it mounted
 * outside and lays it over the slot the window draws
 * (`COMMAND_TERMINAL_BROWSER_SLOT_ATTRIBUTE`).
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { usePopOutStore } from '../../stores/pop-out-store';
import { popOutInstanceKey } from '../../../shared/pop-out';
import {
  commandTerminalBrowserOwner,
  isCommandTerminalBrowserOwner,
  parseCommandTerminalBrowserOwner,
} from '../../../shared/browser-owner';
import { findLiveCommandTerminalSession } from '../../../shared/session-owner';
import { DEFAULT_SPLIT_RATIO, clampSplitRatio } from '../../hooks/task-split-ratio';
import { commandTerminalChangesEntityId } from '../../stores/session-store/task-changes-panel-slice';
import { commandWindowManager } from '../../window-manager';

/** The event `announceCommandTerminalBrowserSlot` fires on `window`. */
export const COMMAND_TERMINAL_BROWSER_SLOT_EVENT = 'kangentic:command-terminal-browser-slot';

/** The attribute on the empty slot a Command Terminal window draws for its pane. */
export const COMMAND_TERMINAL_BROWSER_SLOT_ATTRIBUTE = 'data-command-terminal-browser-slot';

/**
 * Tell the host a slot mounted or unmounted, so it places or hides the pane at
 * once. The host also polls, but a minimized or hidden window throttles both
 * animation frames and timers, so a poll alone left a pane reporting `showing`
 * for seconds after the panel hid.
 */
export function announceCommandTerminalBrowserSlot(): void {
  window.dispatchEvent(new Event(COMMAND_TERMINAL_BROWSER_SLOT_EVENT));
}

/** Whether a project's Command Terminal panel is in a window of its own. Only
 *  the main window learns that (`popOut:changed`), so only it asks. */
export function isCommandTerminalPanelDetached(projectId: string): boolean {
  const key = popOutInstanceKey('command-terminal', { projectId, projectName: '' });
  return usePopOutStore.getState().openInstanceKeys[key] === true;
}

/**
 * Show or hide one of the slot's two side panels. Browser and Changes share the
 * terminal's side, so opening one puts the other away; hiding the Browser HOLDS
 * it (the page stays loaded behind the terminal), exactly as the task window's
 * pill does.
 */
function toggleCommandTerminalSide(projectId: string, slot: string, side: 'browser' | 'changes'): void {
  const ownerKey = commandTerminalBrowserOwner(projectId, slot);
  const changesId = commandTerminalChangesEntityId(slot);
  const state = useSessionStore.getState();
  const browserOpen = state.browserOpenTasks.has(ownerKey);
  const changesOpen = state.changesOpenTasks.has(changesId);
  if (side === 'browser') {
    if (!browserOpen && changesOpen) state.toggleChangesOpen(changesId);
    state.toggleBrowserOpen(ownerKey);
  } else {
    if (!changesOpen && browserOpen) state.toggleBrowserOpen(ownerKey);
    state.toggleChangesOpen(changesId);
  }
}

/** The Globe pill, the kebab item and Mod+Shift+B: show or hide the slot's pane. */
export function toggleCommandTerminalBrowser(projectId: string, slot: string): void {
  toggleCommandTerminalSide(projectId, slot, 'browser');
}

/** Show or hide the slot's Changes panel, holding a live Browser pane it replaces. */
export function toggleCommandTerminalChanges(projectId: string, slot: string): void {
  toggleCommandTerminalSide(projectId, slot, 'changes');
}

// Owners whose saved layout this renderer has already read. Once per owner per
// renderer: a later read would undo what the user did since. Kept across a
// Fast Refresh, so a re-read cannot reopen a pane whose close failed to save.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const hydratedOwners: Set<string> = import.meta.hot?.data?.hydratedOwners ?? new Set<string>();
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.hydratedOwners = hydratedOwners;
  });
}

/**
 * Bring a slot's saved layout into this renderer's store: the pane open after a
 * restart, or in the detached Command Terminal window, which starts with an
 * empty store. Skipped once the store already says anything about the pane, so
 * a click made while the read was in flight wins.
 */
export async function hydrateCommandTerminalBrowser(projectId: string, slot: string): Promise<void> {
  const ownerKey = commandTerminalBrowserOwner(projectId, slot);
  if (hydratedOwners.has(ownerKey)) return;
  hydratedOwners.add(ownerKey);
  const saved = await window.electronAPI.browser.getCommandTerminalState(projectId, slot).catch(() => null);
  if (!saved) return;
  const state = useSessionStore.getState();
  if (saved.ratio !== undefined && state.dividerRatio[ownerKey] === undefined) {
    state.setDividerRatio(ownerKey, clampSplitRatio(saved.ratio));
  }
  if (saved.open && !state.browserOpenTasks.has(ownerKey) && !state.browserHeldTasks.has(ownerKey)) {
    state.setBrowserOpen(ownerKey, true);
  }
}

/**
 * Save each Command Terminal pane's open flag and split as they change. A task
 * saves the same two facts on its row (`scheduleDetailViewSave`, which skips a
 * `command-terminal::` key since it has no row), so this is the terminal's
 * equivalent. Only while the slot runs a terminal: the close main pushes when a
 * terminal ends for good must not write back the entry main just cleared.
 */
function subscribeCommandTerminalBrowserSaves(): () => void {
  return useSessionStore.subscribe((state, previous) => {
    if (state.browserOpenTasks === previous.browserOpenTasks && state.dividerRatio === previous.dividerRatio) return;
    const owners = new Set<string>();
    for (const key of state.browserOpenTasks) if (!previous.browserOpenTasks.has(key)) owners.add(key);
    for (const key of previous.browserOpenTasks) if (!state.browserOpenTasks.has(key)) owners.add(key);
    for (const key of Object.keys(state.dividerRatio)) {
      if (state.dividerRatio[key] !== previous.dividerRatio[key]) owners.add(key);
    }
    for (const ownerKey of owners) {
      const owner = parseCommandTerminalBrowserOwner(ownerKey);
      if (!owner) continue;
      if (!findLiveCommandTerminalSession(state.sessions, owner.projectId, owner.slot)) continue;
      void window.electronAPI.browser.setCommandTerminalState(owner.projectId, owner.slot, {
        open: state.browserOpenTasks.has(ownerKey),
        ratio: state.dividerRatio[ownerKey] ?? DEFAULT_SPLIT_RATIO,
      }).catch(() => undefined);
    }
  });
}

/**
 * Whether a page is alive for a terminal: a mounted guest (showing or held),
 * the offscreen form main reports, or a Browser window of its own. What the
 * globe on its Running row and the alive dot on its Globe pill read, as a task
 * card's globe reads `browserGuestTasks` and `browserOffscreenTasks`.
 */
export function useCommandTerminalBrowserAlive(projectId: string | null, slot: string): boolean {
  const ownerKey = projectId ? commandTerminalBrowserOwner(projectId, slot) : null;
  const inStore = useSessionStore((state) =>
    ownerKey !== null && (state.browserGuestTasks.has(ownerKey) || state.browserOffscreenTasks.has(ownerKey)));
  const poppedOut = usePopOutStore((state) =>
    ownerKey !== null && projectId !== null
    && state.openInstanceKeys[popOutInstanceKey('browser', { projectId, taskId: ownerKey })] === true);
  return inStore || poppedOut;
}

/** How long an agent-opened panel waits to show before the stamp gives up. */
const AGENT_OPEN_STAMP_WINDOW_MS = 15_000;

/** How long after the panel shows its windows keep being stamped: past the
 *  window the open creates and its terminal's arrival. */
const AGENT_OPEN_SETTLE_MS = 2_000;

/**
 * Stamp every Command Terminal window as opened by an AGENT, so no arriving
 * terminal takes the user's keyboard off the back of a panel the user did not
 * open (`resolveArrivalFocus`'s agent-window tier, which reads the focused
 * command window's stamp). The user's first press on a frame clears it
 * (`focusWindow`). Stamped again the moment the panel shows, since the open
 * may create the window it lands in.
 */
function stampCommandWindowsAgentOpened(): void {
  const store = commandWindowManager.store.getState();
  for (const windowId of Object.keys(store.windows)) store.markAgentOpened(windowId);
}

/**
 * Open the panel for an agent's open_pane: the same open the shortcut runs (it
 * waits on a restart's restore and reconciles the windows first), stamped so
 * nothing in it takes focus. A panel already showing is left as it is: no
 * window moves, nothing expands, and no terminal arrives.
 */
function openPanelForAgent(projectId: string): void {
  const state = useSessionStore.getState();
  if (state.commandBarVisible) return;
  if (useProjectStore.getState().currentProject?.id !== projectId) return;
  stampCommandWindowsAgentOpened();
  // The open can CREATE the window it lands in (`useEnsureCommandWindow`, after
  // the panel shows), and a window's own open focuses it, which clears a stamp.
  // So every window change re-stamps until the panel has shown and settled, or
  // the user presses anywhere: from that press on, focus is the user's to give.
  let settled = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    unsubscribeWindows();
    unsubscribeVisible();
    document.removeEventListener('pointerdown', finish, true);
    if (settleTimer) clearTimeout(settleTimer);
  };
  const unsubscribeWindows = commandWindowManager.store.subscribe((next, previous) => {
    if (next.windows === previous.windows && next.focusedWindowId === previous.focusedWindowId) return;
    stampCommandWindowsAgentOpened();
  });
  const unsubscribeVisible = useSessionStore.subscribe((next, previous) => {
    if (!next.commandBarVisible || previous.commandBarVisible) return;
    stampCommandWindowsAgentOpened();
    // Shown: its windows and terminals arrive within a few frames.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(finish, AGENT_OPEN_SETTLE_MS);
  });
  document.addEventListener('pointerdown', finish, true);
  settleTimer = setTimeout(finish, AGENT_OPEN_STAMP_WINDOW_MS);
  state.setPendingOpenCommandTerminal(true);
}

/**
 * Main's open and close requests for Command Terminal panes, the offscreen set,
 * and the saved layout, for one renderer. Mounted once in the main window
 * (`AppLayout`) and once in the detached Command Terminal window, which runs no
 * App.tsx and no board bridges. The board's `useBrowserPaneRequestBridge`
 * leaves every `command-terminal::` key to this.
 *
 * `scopeProjectId` is the detached window's project: it hosts that project's
 * panes and nothing else. The main window passes none, and leaves a project
 * whose panel is detached to that window.
 */
export function useCommandTerminalBrowserBridge(scopeProjectId?: string): void {
  useEffect(() => {
    const browser = window.electronAPI?.browser;
    if (!browser?.onPaneOpenRequest) return;
    // agent-focus-ok: this push opens the Command Terminal panel only through
    // `openPanelForAgent`, which stamps every command window agent-opened first,
    // so no terminal in it takes the keyboard.
    const unsubscribeOpen = browser.onPaneOpenRequest((projectId, ownerKey) => {
      if (!isCommandTerminalBrowserOwner(ownerKey)) return;
      if (scopeProjectId !== undefined && projectId !== scopeProjectId) return;
      if (scopeProjectId === undefined && isCommandTerminalPanelDetached(projectId)) return;
      const session = useSessionStore.getState();
      // Open before the panel shows, so the window mounts with its slot drawn.
      session.setBrowserOpen(ownerKey, true);
      session.refreshBrowserUrl(ownerKey);
      if (scopeProjectId === undefined) openPanelForAgent(projectId);
    });
    const unsubscribeClose = browser.onPaneCloseRequest?.((projectId, ownerKeys) => {
      if (scopeProjectId !== undefined && projectId !== scopeProjectId) return;
      const setBrowserOpen = useSessionStore.getState().setBrowserOpen;
      for (const ownerKey of ownerKeys) {
        if (isCommandTerminalBrowserOwner(ownerKey)) setBrowserOpen(ownerKey, false);
      }
    });
    const unsubscribeSaves = subscribeCommandTerminalBrowserSaves();
    return () => {
      unsubscribeOpen();
      unsubscribeClose?.();
      unsubscribeSaves();
    };
  }, [scopeProjectId]);
}
