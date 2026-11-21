/**
 * The Kangentic browser a task's links open in, by task id.
 *
 * A terminal gets its window's browser handed to it (`useTerminal`'s
 * `linkBrowser`). A link drawn elsewhere for the same task (the PR pill and the
 * artifacts on its board card, its header, its completed strip) has no such
 * prop, so the task window registers the browser here and the link asks for it
 * by task.
 *
 * A task whose window is closed can still open a link there: its agent is
 * running, so its window would show a terminal and a Browser pane beside it.
 * The link then opens the task window, as a click on the card does, and the
 * window loads the link once it has registered its browser. If the window
 * comes up without one (the pane was switched off, the session ended in
 * between), the link opens in the default browser instead, so that click is
 * not lost. One link waits per task: a second click while the window is still
 * coming up replaces the first, which then opens nowhere.
 *
 * A task whose Browser pane is in a window of its own opens a link there
 * directly, with no task window: main relays it to that window and raises it
 * (`pop-out-link-browser.ts`).
 *
 * A task with no running session, or a project with the Browser pane off, has
 * no Kangentic browser, and its links open in the default browser
 * (`link-open.ts`).
 *
 * Subscribable, so a tip that lists both browsers drops to one row the moment
 * the window closes.
 */

import { useSyncExternalStore } from 'react';
import { popOutInstanceKey } from '../../shared/pop-out';
import { useConfigStore } from '../stores/config-store';
import { usePopOutStore } from '../stores/pop-out-store';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import type { TerminalLinkBrowser } from './terminal-links/link-targets';
import { popOutLinkBrowser } from './pop-out-link-browser';

/** How long a link waits for its task window to offer a browser before it opens in the default one. */
export const PENDING_TASK_LINK_MS = 4000;

interface PendingTaskLink {
  url: string;
  timer: ReturnType<typeof setTimeout>;
}

interface TaskLinkBrowserState {
  browsers: Map<string, TerminalLinkBrowser>;
  listeners: Set<() => void>;
  /** A link waiting for its task's window to register a browser. One per task: a newer click replaces it. */
  pending: Map<string, PendingTaskLink>;
}

// Kept across a Fast Refresh of this module: the task windows that registered
// stay mounted and their effects do not run again (hmr-patterns.md, Pattern A).
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const state: TaskLinkBrowserState = import.meta.hot?.data?.taskLinkBrowserState ?? {
  browsers: new Map<string, TerminalLinkBrowser>(),
  listeners: new Set<() => void>(),
  pending: new Map<string, PendingTaskLink>(),
};
// A state kept from before `pending` existed.
state.pending ??= new Map<string, PendingTaskLink>();
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.taskLinkBrowserState = state;
  });
}

function notify(): void {
  for (const listener of state.listeners) listener();
}

function takePending(taskId: string): string | null {
  const pending = state.pending.get(taskId);
  if (!pending) return null;
  clearTimeout(pending.timer);
  state.pending.delete(taskId);
  return pending.url;
}

/** Offer `browser` for the task's links until the returned function runs. */
export function registerTaskLinkBrowser(taskId: string, browser: TerminalLinkBrowser): () => void {
  state.browsers.set(taskId, browser);
  notify();
  // A link that opened this window to get here.
  const waiting = takePending(taskId);
  if (waiting !== null) browser.open(waiting);
  return () => {
    // A newer registration for the same task (a window remounted) stays.
    if (state.browsers.get(taskId) !== browser) return;
    state.browsers.delete(taskId);
    notify();
  };
}

/** The Kangentic browser the task's open window offers now, or null. */
export function taskLinkBrowser(taskId: string | null | undefined): TerminalLinkBrowser | null {
  return taskId ? state.browsers.get(taskId) ?? null : null;
}

/**
 * The project of a task whose closed window would still give its links a
 * Kangentic browser, or null when it has none: the Browser pane is on for the
 * project and the task's agent is running, so a window shows its terminal and
 * the pane beside it, or the pane already lives in a window of its own. Never
 * in a pop-out window, which has no task windows. The project is the session's
 * own, so a Browser window is found by the key it was opened under.
 */
function reachableTaskBrowserProject(taskId: string): string | null {
  if (window.electronAPI?.popOut?.descriptor) return null;
  if (useConfigStore.getState().config.browser?.enabled === false) return null;
  if (!useProjectStore.getState().currentProject) return null;
  const session = useSessionStore.getState()._sessionByTaskId.get(taskId);
  if (!session || session.status !== 'running') return null;
  return session.projectId;
}

function isBrowserPoppedOut(projectId: string, taskId: string): boolean {
  return usePopOutStore.getState().openInstanceKeys[popOutInstanceKey('browser', { projectId, taskId })] === true;
}

/**
 * Open `url` in the task's Kangentic browser: in its open window's pane, in
 * the Browser window it was popped out to, or by opening the task window first.
 * Returns false when the task has no Kangentic browser to open it in, and the
 * caller opens the default browser.
 */
export function openInTaskBrowser(taskId: string, url: string, openExternal: (url: string) => void): boolean {
  const browser = taskLinkBrowser(taskId);
  if (browser) {
    browser.open(url);
    return true;
  }
  const projectId = reachableTaskBrowserProject(taskId);
  if (projectId === null) return false;
  // The pane is already on screen in a window of its own: no task window needed.
  if (isBrowserPoppedOut(projectId, taskId)) {
    popOutLinkBrowser(projectId, taskId, openExternal).open(url);
    return true;
  }
  takePending(taskId);
  const timer = setTimeout(() => {
    // The window came up without a browser, or never came up: do not lose the click.
    if (takePending(taskId) !== null) openExternal(url);
  }, PENDING_TASK_LINK_MS);
  state.pending.set(taskId, { url, timer });
  // The card's own open: the window mounts, registers its browser, and takes the link.
  useSessionStore.getState().setDetailTaskId(taskId);
  return true;
}

function subscribe(listener: () => void): () => void {
  state.listeners.add(listener);
  const unsubscribers = [
    // Every store `reachableTaskBrowserProject` reads, the open project included.
    useSessionStore.subscribe(listener),
    useConfigStore.subscribe(listener),
    usePopOutStore.subscribe(listener),
    useProjectStore.subscribe(listener),
  ];
  return () => {
    state.listeners.delete(listener);
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

/** Whether the task has a Kangentic browser a link can open in right now: its open window's, its pop-out's, or one its window would offer. */
export function useTaskLinkBrowserAvailable(taskId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (taskId ? taskLinkBrowser(taskId) !== null || reachableTaskBrowserProject(taskId) !== null : false));
}
