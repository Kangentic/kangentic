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
 * Mounted once by `WindowLayer`'s `BoardBridges`, alongside the task-detail
 * window bridge whose window store it reads.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useWindowStore } from '../store/window-store';

/** Whether the board layer already has a task-detail window for this task. */
function hasDetailWindowFor(taskId: string): boolean {
  return Object.values(useWindowStore.getState().windows).some(
    (candidate) => candidate.kind === 'task-detail' && candidate.anchor === taskId,
  );
}

export function useBrowserPaneRequestBridge(): void {
  useEffect(() => {
    const browser = window.electronAPI?.browser;
    if (!browser?.onPaneOpenRequest) return;
    // Tracked so the deferred re-set below cannot outlive this effect: a timer
    // that fires after teardown would write to a store instance nothing renders.
    let pendingReopen: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = browser.onPaneOpenRequest((_projectId, taskId) => {
      const session = useSessionStore.getState();

      // Open the pane BEFORE asking for the window, so a window that mounts as a
      // result renders with the pane already showing. Setting it afterwards
      // would change the task-detail split row's shape one commit after mount,
      // which is the remount hazard in
      // .claude/rules/retained-pane-never-remounts.md.
      session.setBrowserOpen(taskId, true);
      // Main seeded the task's URL sidecar just before pushing. A pane already
      // mounted on its empty state has no reason to refetch on its own, so nudge
      // it; this is a refetch, never a remount.
      session.refreshBrowserUrl(taskId);

      if (hasDetailWindowFor(taskId)) return;

      // Route through the normal signal so main's ownership arbiter decides
      // where the detail opens (it may already be hosted by the Agent Monitor).
      // A stale signal still naming this task would be a no-op change and would
      // never re-fire the effect that acts on it, so clear it first and set it
      // in a later task - two commits, one re-fire.
      if (session.detailTaskId === taskId) {
        session.setDetailTaskId(null);
        if (pendingReopen) clearTimeout(pendingReopen);
        pendingReopen = setTimeout(() => {
          pendingReopen = null;
          const current = useSessionStore.getState();
          // Only restore what we cleared. Anything else that claimed the signal
          // in the gap (a card click, a search-palette open, another push) is
          // newer than this request and must not be silently redirected back.
          if (current.detailTaskId === null) current.setDetailTaskId(taskId);
        }, 0);
        return;
      }
      session.setDetailTaskId(taskId);
    });
    return () => {
      if (pendingReopen) clearTimeout(pendingReopen);
      unsubscribe();
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
      for (const taskId of taskIds) setBrowserOpen(taskId, false);
    });
  }, []);
}
