/**
 * The Agent Monitor's implementation of `TaskDetailHostValue`.
 *
 * The board's host reads the live board / config / project stores, because its
 * task always belongs to the open project. A monitor row can belong to ANY
 * project, so this host resolves the same values from the per-project bundle
 * (`monitor.getTaskDetail`) instead, and its mutations go straight to the
 * project-stamped IPC.
 *
 * Deliberately NOT reusing the board store's actions: those apply an optimistic
 * local update to the OPEN project's task list, which for a background project's
 * task would either do nothing or corrupt the wrong board. The IPC underneath is
 * the same in both hosts (`tasks.update` / `move` / `delete` / `unarchive`, all
 * of which already take an explicit projectId per
 * .claude/rules/project-scoped-ipc.md); only the local echo differs, and here the
 * echo is a bundle refetch.
 *
 * One bundle per open task, keyed by (projectId, taskId), refetched on the
 * monitor's own change push so a rename or column move made elsewhere lands here
 * too.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useConfigStore } from '../../stores/config-store';
import { useMonitorStore } from '../../stores/monitor-store';
import { TaskDetailHostProvider } from '../dialogs/task-detail';
import type { TaskDetailHostValue } from '../dialogs/task-detail';
import type { Task, TaskDetailBundle } from '../../../shared/types';

interface MonitorTaskDetailHostProps {
  projectId: string;
  taskId: string;
  /** Rendered once the bundle resolves; receives the task to hand the window. */
  children: (task: Task) => ReactNode;
  /** The task or its project is gone - the layer closes the window. */
  onUnavailable: () => void;
}

export function MonitorTaskDetailHost({
  projectId,
  taskId,
  children,
  onUnavailable,
}: MonitorTaskDetailHostProps) {
  const [bundle, setBundle] = useState<TaskDetailBundle | null>(null);
  // Any monitor change can also mean this task changed (retitled, moved column),
  // so the bundle refetches on the same signal the rows do rather than polling.
  const monitorRows = useMonitorStore((state) => state.rows);
  const settingsOpen = useConfigStore((state) => state.settingsOpen);

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.monitor;
    if (!api?.getTaskDetail) return;
    try {
      const next = await api.getTaskDetail(projectId, taskId);
      if (!next) {
        onUnavailable();
        return;
      }
      setBundle(next);
    } catch (error) {
      console.error('[monitor] Failed to load task detail bundle:', error);
    }
  }, [projectId, taskId, onUnavailable]);

  useEffect(() => { void refresh(); }, [refresh, monitorRows]);

  const value = useMemo<TaskDetailHostValue | null>(() => {
    if (!bundle) return null;
    return {
      projectId: bundle.projectId,
      projectPath: bundle.projectPath,
      defaultAgent: bundle.defaultAgent,
      swimlanes: bundle.swimlanes,
      shortcuts: bundle.shortcuts,
      config: bundle.config,
      // The bundle carries only THIS task, not the whole board, so an append
      // position cannot be computed from a lane's length here. Position 0 is
      // deliberate and correct: the repository treats it as "top of the lane",
      // which is a real position rather than a guess at the bottom.
      laneTasks: () => [],
      updateTask: async (input) => {
        const updated = await window.electronAPI.tasks.update(input, bundle.projectId);
        await refresh();
        return updated;
      },
      deleteTask: async (id) => {
        await window.electronAPI.tasks.delete(id, bundle.projectId);
      },
      moveTask: async (input) => {
        await window.electronAPI.tasks.move(input, bundle.projectId);
        await refresh();
        return { ok: true };
      },
      unarchiveTask: async (input) => {
        await window.electronAPI.tasks.unarchive(input, bundle.projectId);
        await refresh();
      },
      // No optimistic archive echo: there is no local list to remove it from.
      archiveTask: () => {},
      updateAttachmentCount: () => {},
      refresh,
      // Only the board owns a move-confirmation dialog.
      isMoveConfirmPending: () => false,
      // The Board Manager cannot open over the monitor; Settings can.
      shortcutsSuppressed: settingsOpen,
    };
  }, [bundle, refresh, settingsOpen]);

  if (!value || !bundle) return null;
  return <TaskDetailHostProvider value={value}>{children(bundle.task)}</TaskDetailHostProvider>;
}
