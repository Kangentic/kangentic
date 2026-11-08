/**
 * Bridges main's Browser-pane open/close requests (the
 * `kangentic_browser_open_pane` / `kangentic_browser_close_pane` MCP tools) to
 * this renderer's pane state.
 *
 * Pane open state is renderer-owned (`browserOpenTasks`) and the MCP server is
 * main-process, so an agent cannot open its own pane without a push. The push is
 * deliberately fire-and-forget: main has already validated the project, the
 * per-project browser gate, the task, and the URL before sending, and it then
 * waits on the PANE REGISTRY rather than on a reply from here. A registered live
 * guest is the only thing that proves the pane is actually driveable, which no
 * acknowledgement from this side could establish - and it keeps main free of a
 * correlated request/response pattern the codebase does not otherwise have (see
 * .claude/rules/derived-detail-ownership.md on why incremental renderer
 * bookkeeping was deliberately made impossible).
 *
 * This bridge never shows, raises or focuses a window. An agent needing a browser
 * is its own business, and a task window the user closed stays closed: the pane
 * mounts in a window born parked and runs out of sight, and the user's own click
 * on the card later un-parks that window with the same guest. It deliberately
 * does not go through `setDetailTaskId` and main's ownership arbiter, because that
 * path ends in `focusWindowOf`, a `restore()` plus `focus()` on the app's window.
 *
 * Mounted once by `WindowLayer`'s `BoardBridges`, alongside the task-detail
 * window bridge whose window store it reads.
 */

import { useEffect } from 'react';
import { useBoardStore } from '../../stores/board-store';
import { usePopOutStore } from '../../stores/pop-out-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useWindowStore } from '../store/window-store';
import { isCommandTerminalBrowserOwner } from '../../../shared/browser-owner';
import { BROWSER_PANE_OPEN_TIMEOUT_MS, type Task } from '../../../shared/types';
import { resolvePaneOpenAction } from './pane-open-action';
import { monitorMountsDetail, taskDetailWindowInput } from './window-parking';

/**
 * How long a window born parked may wait for its guest. Past main's own wait on
 * the pane, so the reaper can never drop a window main is still waiting on.
 */
const PARKED_GUEST_GRACE_MS = BROWSER_PANE_OPEN_TIMEOUT_MS + 2_000;

/**
 * Mount the task's detail hidden, so its Browser pane has a host.
 *
 * agent-focus-ok: the only window an agent's open_pane opens, and it opens
 * parked, so it joins neither focus nor the stacking order and no terminal
 * mounts in it. See `.claude/rules/agent-driven-focus.md`.
 */
function mountParkedDetailWindow(task: Task): void {
  // A stale signal still naming this task would swallow the user's next click on
  // its card as "no change", and that click is what shows this window.
  const session = useSessionStore.getState();
  if (session.detailTaskId === task.id) session.setDetailTaskId(null);
  useWindowStore.getState().openWindow({
    ...taskDetailWindowInput(task),
    parked: true,
    guestPendingUntil: Date.now() + PARKED_GUEST_GRACE_MS,
  });
}

function findBoardTask(taskId: string): Task | undefined {
  const board = useBoardStore.getState();
  return board.tasks.find((candidate) => candidate.id === taskId)
    ?? board.archivedTasks.find((candidate) => candidate.id === taskId);
}

/** Give the pane a host if it needs one. False when the board has not got the task yet. */
function hostPane(projectId: string, taskId: string): boolean {
  const action = resolvePaneOpenAction({
    projectId,
    currentProjectId: useProjectStore.getState().currentProject?.id ?? null,
    hasBoardWindow: Object.values(useWindowStore.getState().windows).some(
      (candidate) => candidate.kind === 'task-detail' && candidate.anchor === taskId,
    ),
    browserPoppedOut: usePopOutStore.getState().isOpen('browser', { projectId, taskId }),
    monitorMountsDetail: monitorMountsDetail(projectId, taskId),
  });
  if (action !== 'mount-parked') return true;
  const task = findBoardTask(taskId);
  if (!task) return false;
  mountParkedDetailWindow(task);
  return true;
}

/**
 * Host the pane once the board has the task. Main checked the task exists, so a
 * board without it has not caught up: a new task took 1.3 s to arrive with the
 * window hidden. Nothing would ask again, so wait for as long as main waits on the
 * pane. Returns what ends the wait; `onEnded` runs however it ends.
 */
export function hostPaneWhenBoardHasTask(projectId: string, taskId: string, onEnded: () => void): () => void {
  function stopWaiting(): void {
    stopWatchingBoard();
    clearTimeout(giveUp);
    onEnded();
  }
  const stopWatchingBoard = useBoardStore.subscribe((state, previous) => {
    if (state.tasks === previous.tasks && state.archivedTasks === previous.archivedTasks) return;
    if (findBoardTask(taskId) && hostPane(projectId, taskId)) stopWaiting();
  });
  const giveUp = setTimeout(() => {
    stopWaiting();
    // Main has already answered `pane-open-timeout`, so a flag left set would mount
    // a pane the agent stopped waiting for the next time the user opens this task.
    useSessionStore.getState().setBrowserOpen(taskId, false);
  }, BROWSER_PANE_OPEN_TIMEOUT_MS);
  return stopWaiting;
}

export function useBrowserPaneRequestBridge(): void {
  useEffect(() => {
    const browser = window.electronAPI?.browser;
    if (!browser?.onPaneOpenRequest) return;
    const boardWaits = new Map<string, () => void>();
    const unsubscribe = browser.onPaneOpenRequest((projectId, taskId) => {
      // A Command Terminal's pane is no task's: opening a task-detail window for
      // its key would open a window for a task that does not exist.
      // `useCommandTerminalBrowserBridge` owns those requests.
      if (isCommandTerminalBrowserOwner(taskId)) return;
      const session = useSessionStore.getState();

      // Open the pane BEFORE the window, so a window that mounts as a result
      // renders with the pane already there. Setting it afterwards
      // would change the task-detail split row's shape one commit after mount,
      // which is the remount hazard in
      // .claude/rules/retained-pane-never-remounts.md.
      session.setBrowserOpen(taskId, true);
      // Main seeded the task's URL sidecar just before pushing. A pane already
      // mounted on its empty state has no reason to refetch on its own, so nudge
      // it; this is a refetch, never a remount.
      session.refreshBrowserUrl(taskId);

      // A repeat push replaces any wait already running for this task.
      boardWaits.get(taskId)?.();
      if (hostPane(projectId, taskId)) return;
      boardWaits.set(taskId, hostPaneWhenBoardHasTask(projectId, taskId, () => boardWaits.delete(taskId)));
    });
    return () => {
      unsubscribe();
      for (const stopWaiting of [...boardWaits.values()]) stopWaiting();
    };
  }, []);

  useEffect(() => {
    const browser = window.electronAPI?.browser;
    if (!browser?.onPaneCloseRequest) return;
    return browser.onPaneCloseRequest((_projectId, taskIds) => {
      // The ids are computed by main from the pane registry, never re-derived
      // here: `browserOpenTasks` is not project-keyed and the board store only
      // holds the OPEN project's tasks, so a pane retained for a backgrounded
      // project would be invisible to any lookup this renderer could do.
      const setBrowserOpen = useSessionStore.getState().setBrowserOpen;
      for (const taskId of taskIds) {
        if (!isCommandTerminalBrowserOwner(taskId)) setBrowserOpen(taskId, false);
      }
    });
  }, []);
}
