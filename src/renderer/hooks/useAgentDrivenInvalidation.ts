/**
 * Subscribes to the agent-driven `onXByAgent` IPC push channels and
 * routes them into the warm-switch cache or the live board/backlog
 * stores depending on whether the change targets the current project.
 *
 * Each listener follows the same shape:
 *   - If the push targets the current project, debounce-reload the
 *     live store (so a 50-issue MCP bulk import coalesces into a
 *     single reload).
 *   - Otherwise mark the target project's cache as stale so the next
 *     warm switch refetches instead of restoring obsolete data.
 *   - Toast if the push is agent-driven news (the toast is live user
 *     feedback regardless of which project is open).
 *
 * Why a hook and not inline in App.tsx: these listeners share the
 * identical decision pattern (current vs background project) and the
 * shared 250ms debouncers. Co-locating them keeps the invalidation
 * policy reviewable in one place rather than spread across 100 lines
 * of repetitive IPC wiring in App.tsx.
 *
 * Whether a push toasts is decided by PROVENANCE, not volume: a change an
 * agent made is news, a reconcile the app performed is not. Two channels
 * exist purely to carry the quiet half, and both invalidate without toasting:
 *   - `onSessionResync` fires after a column-model-change restart (and the
 *     orphan-worktree prune, and auto-spawn reconcile) to keep the board
 *     store's task.session_id current - a board-consistency reconcile the
 *     user already knows they triggered.
 *   - `onPrLinkChanged` fires when the app resolved a task's PR link itself:
 *     the refresh sweep, the session-idle auto-link, the re-resolve that
 *     follows a link write, or the task-detail "Link / refresh PR" control.
 *     Landing one PR used to raise three "Task updated by agent" toasts per
 *     task, two of them announcing a round trip that netted to no change.
 * (`backlog.onChangedByAgent` and `onLabelColorsChanged` are also silent, but
 * for a different reason: neither push names a subject worth announcing.)
 *
 * Not included here (and intentionally left in App.tsx):
 *   - `tasks.onAutoMoved`: agent-driven but tangled with notification
 *     policy (`shouldNotify`/`sendNotification`). Splitting its concerns
 *     across two hooks would obscure the auto-move flow more than the
 *     duplication of a one-line invalidate-or-reload helper costs.
 *   - `tasks.onSpawnProgress`: not an invalidation event; it pushes
 *     ephemeral progress labels into session-store. Lives with the
 *     other session-lifecycle listeners.
 */
import { useEffect } from 'react';
import { useBoardStore } from '../stores/board-store';
import { useBacklogStore } from '../stores/backlog-store';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import { useToastStore } from '../stores/toast-store';
import { invalidateProject, invalidateAllProjects } from '../stores/project-cache';
import { enqueueReload } from '../lib/session-update-coalescer';

export function useAgentDrivenInvalidation(): void {
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    // Unified debouncers for agent-driven board/backlog reloads. MCP bulk
    // operations and external imports emit one event per task/item touched; a
    // 50-issue GitHub import or a scripted `kangentic_create_task` loop
    // previously fired one full loadBoard() per event. 250ms coalesces rapid
    // bursts into a single reload while staying below the user-noticeable
    // threshold. Toasts are intentionally NOT debounced; they are the live
    // user feedback. The reload is routed through `enqueueReload` so a debounce
    // that fires mid-drag is held until drag end (deduped by key) instead of
    // reconciling the board and re-rendering a sortable lane on the pointer-move
    // thread. See session-update-coalescer's reload gate.
    let pendingBoardReload: ReturnType<typeof setTimeout> | null = null;
    let pendingBacklogReload: ReturnType<typeof setTimeout> | null = null;
    const scheduleBoardReload = () => {
      console.debug('[agent-push] scheduling board reload (250ms debounce)', { superseded: pendingBoardReload !== null });
      if (pendingBoardReload !== null) clearTimeout(pendingBoardReload);
      pendingBoardReload = setTimeout(() => {
        pendingBoardReload = null;
        console.debug('[agent-push] board reload debounce fired, enqueueing loadBoard');
        enqueueReload('board', () => useBoardStore.getState().loadBoard());
      }, 250);
    };
    const scheduleBacklogReload = () => {
      console.debug('[agent-push] scheduling backlog reload (250ms debounce)', { superseded: pendingBacklogReload !== null });
      if (pendingBacklogReload !== null) clearTimeout(pendingBacklogReload);
      pendingBacklogReload = setTimeout(() => {
        pendingBacklogReload = null;
        console.debug('[agent-push] backlog reload debounce fired, enqueueing loadBacklog');
        enqueueReload('backlog', () => useBacklogStore.getState().loadBacklog());
      }, 250);
    };
    cleanups.push(() => {
      if (pendingBoardReload !== null) {
        clearTimeout(pendingBoardReload);
        pendingBoardReload = null;
      }
      if (pendingBacklogReload !== null) {
        clearTimeout(pendingBacklogReload);
        pendingBacklogReload = null;
      }
    });

    const tasks = window.electronAPI?.tasks;
    if (tasks?.onCreatedByAgent) {
      cleanups.push(tasks.onCreatedByAgent((_taskId, taskTitle, columnName, createdByAgentProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const matchesActiveProject = !createdByAgentProjectId || createdByAgentProjectId === activeProjectId;
        console.debug('[agent-push] task:createdByAgent received', {
          pushProjectId: createdByAgentProjectId,
          activeProjectId,
          action: matchesActiveProject ? 'reload' : 'invalidate-cache',
        });
        if (matchesActiveProject) {
          scheduleBoardReload();
          scheduleBacklogReload();
        } else {
          // Background-project mutation: drop the cached snapshot so the
          // next switch to that project refetches instead of restoring stale data.
          invalidateProject(createdByAgentProjectId);
        }
        useToastStore.getState().addToast({
          message: `Task created by agent: "${taskTitle}" in ${columnName}`,
          variant: 'success',
        });
      }));
    }

    if (tasks?.onUpdatedByAgent) {
      cleanups.push(tasks.onUpdatedByAgent((_taskId, taskTitle, updatedByAgentProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const matchesActiveProject = !updatedByAgentProjectId || updatedByAgentProjectId === activeProjectId;
        console.debug('[agent-push] task:updatedByAgent received', {
          pushProjectId: updatedByAgentProjectId,
          activeProjectId,
          action: matchesActiveProject ? 'reload' : 'invalidate-cache',
        });
        if (matchesActiveProject) {
          scheduleBoardReload();
        } else {
          invalidateProject(updatedByAgentProjectId);
        }
        useToastStore.getState().addToast({
          message: `Task updated by agent: "${taskTitle}"`,
          variant: 'info',
        });
      }));
    }

    if (tasks?.onDeletedByAgent) {
      cleanups.push(tasks.onDeletedByAgent((_taskId, taskTitle, deletedByAgentProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const matchesActiveProject = !deletedByAgentProjectId || deletedByAgentProjectId === activeProjectId;
        console.debug('[agent-push] task:deletedByAgent received', {
          pushProjectId: deletedByAgentProjectId,
          activeProjectId,
          action: matchesActiveProject ? 'reload' : 'invalidate-cache',
        });
        if (matchesActiveProject) {
          scheduleBoardReload();
        } else {
          invalidateProject(deletedByAgentProjectId);
        }
        useToastStore.getState().addToast({
          message: `Task deleted by agent: "${taskTitle}"`,
          variant: 'info',
        });
      }));
    }

    if (tasks?.onSessionResync) {
      cleanups.push(tasks.onSessionResync((sessionResyncProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const matchesActiveProject = !sessionResyncProjectId || sessionResyncProjectId === activeProjectId;
        console.debug('[agent-push] task:sessionResync received', {
          pushProjectId: sessionResyncProjectId,
          activeProjectId,
          action: matchesActiveProject ? 'reload' : 'invalidate-cache',
        });
        if (matchesActiveProject) {
          scheduleBoardReload();
        } else {
          invalidateProject(sessionResyncProjectId);
        }
        // Deliberately no toast: this is a quiet board-consistency reconcile
        // after the user's own column model-change restart, not agent news.
      }));
    }

    if (tasks?.onPrLinkChanged) {
      cleanups.push(tasks.onPrLinkChanged((prLinkProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const matchesActiveProject = !prLinkProjectId || prLinkProjectId === activeProjectId;
        console.debug('[agent-push] task:prLinkChanged received', {
          pushProjectId: prLinkProjectId,
          activeProjectId,
          action: matchesActiveProject ? 'reload' : 'invalidate-cache',
        });
        if (matchesActiveProject) {
          scheduleBoardReload();
        } else {
          invalidateProject(prLinkProjectId);
        }
        // Deliberately no toast: the app resolved this PR link itself, so no
        // agent updated the task. The board still reloads because the card's
        // PR chip is stale. The agent's own update_task / link_pr call arrives
        // separately on onUpdatedByAgent and does toast.
      }));
    }

    const swimlanes = window.electronAPI?.swimlanes;
    if (swimlanes?.onUpdatedByAgent) {
      cleanups.push(swimlanes.onUpdatedByAgent((_swimlaneId, swimlaneName, updatedByAgentProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const matchesActiveProject = !updatedByAgentProjectId || updatedByAgentProjectId === activeProjectId;
        console.debug('[agent-push] swimlane:updatedByAgent received', {
          pushProjectId: updatedByAgentProjectId,
          activeProjectId,
          action: matchesActiveProject ? 'reload' : 'invalidate-cache',
        });
        if (matchesActiveProject) {
          scheduleBoardReload();
        } else {
          invalidateProject(updatedByAgentProjectId);
        }
        // Deliberately kind-agnostic. This one channel carries every column
        // mutation an agent can make - create, update, AND delete - so naming a
        // specific verb makes the toast lie two thirds of the time. "updated"
        // was actively wrong for a delete: it named a column that no longer
        // exists. Say what the payload actually tells us. Distinguishing the
        // three would mean threading a discriminator through the channel.
        useToastStore.getState().addToast({
          message: `Column changed by agent: "${swimlaneName}"`,
          variant: 'info',
        });
      }));
    }

    const backlog = window.electronAPI?.backlog;
    if (backlog?.onChangedByAgent) {
      cleanups.push(backlog.onChangedByAgent((changedProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const isBackgroundProject = changedProjectId && changedProjectId !== activeProjectId;
        console.debug('[agent-push] backlog:changedByAgent received', {
          pushProjectId: changedProjectId,
          activeProjectId,
          action: isBackgroundProject ? 'invalidate-cache' : 'reload',
        });
        if (isBackgroundProject) {
          invalidateProject(changedProjectId);
          return;
        }
        scheduleBacklogReload();
      }));
    }

    // Label colors changed by agent (MCP server created labels with colors)
    if (backlog?.onLabelColorsChanged) {
      cleanups.push(backlog.onLabelColorsChanged(() => {
        // Held until drag end if it lands mid-drag (label colors re-render
        // cards that use them). See session-update-coalescer's reload gate.
        enqueueReload('config', () => useConfigStore.getState().loadConfig());
        // Label colors live in the AppConfig shape, so every project's
        // effective config is now stale. Invalidate cached snapshots so
        // a future warm switch refetches instead of restoring old colors.
        invalidateAllProjects();
      }));
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, []);
}
