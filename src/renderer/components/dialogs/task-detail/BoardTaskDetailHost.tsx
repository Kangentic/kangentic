/**
 * The BOARD's implementation of `TaskDetailHostValue`, backed by the live board /
 * config / project stores.
 *
 * This is the identity host: every field resolves to exactly what the task-detail
 * surface used to read ambiently, so extracting the context changed no board
 * behaviour. It is the reference implementation a second host (the Agent
 * Monitor, whose task belongs to a project other than the open board's) is
 * written against.
 *
 * Mounted by `WindowLayer`, which wraps the board's task-detail windows.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useBoardStore } from '../../../stores/board-store';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import { TaskDetailHostProvider } from './task-detail-host';
import type { TaskDetailHostValue } from './task-detail-host';

export function BoardTaskDetailHost({ children }: { children: ReactNode }) {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? '');
  const projectPath = useProjectStore((state) => state.currentProject?.path ?? '');
  const defaultAgent = useProjectStore((state) => state.currentProject?.default_agent ?? null);

  const swimlanes = useBoardStore((state) => state.swimlanes);
  const shortcuts = useBoardStore((state) => state.shortcuts);
  const updateTask = useBoardStore((state) => state.updateTask);
  const deleteTask = useBoardStore((state) => state.deleteTask);
  const moveTask = useBoardStore((state) => state.moveTask);
  const unarchiveTask = useBoardStore((state) => state.unarchiveTask);
  const archiveTask = useBoardStore((state) => state.archiveTask);
  const updateAttachmentCount = useBoardStore((state) => state.updateAttachmentCount);
  const loadBoard = useBoardStore((state) => state.loadBoard);

  // Surfaces that stack ABOVE the board's windows and take the keyboard. The
  // edit form's Advanced section can open either one from inside a window, so a
  // single Escape meant for it must not also close the window underneath.
  const boardManagerOpen = useBoardStore((state) => state.boardManagerOpen);
  const settingsOpen = useConfigStore((state) => state.settingsOpen);

  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors);
  const defaultBaseBranch = useConfigStore((state) => state.config.git.defaultBaseBranch);
  const worktreesEnabled = useConfigStore((state) => state.config.git.worktreesEnabled);
  const browserEnabled = useConfigStore((state) => state.config.browser?.enabled);

  // Memoized so `LabelPills`' own React.memo is not defeated by a fresh object
  // identity every render (the trap TaskCard documents).
  const config = useMemo(() => ({
    labelColors: labelColors ?? {},
    defaultBaseBranch,
    worktreesEnabled,
    browserEnabled: browserEnabled !== false,
  }), [labelColors, defaultBaseBranch, worktreesEnabled, browserEnabled]);

  const value = useMemo<TaskDetailHostValue>(() => ({
    projectId,
    projectPath,
    defaultAgent,
    swimlanes,
    shortcuts,
    config,
    // Read at call time, not subscribed: this is only ever used to append at the
    // end of a lane during a move, and subscribing to the whole task list would
    // re-render every open detail window on any board change.
    laneTasks: (swimlaneId) =>
      useBoardStore.getState().tasks.filter((task) => task.swimlane_id === swimlaneId),
    updateTask,
    deleteTask,
    // The board store's own moveTask already forwards an interaction-time
    // projectId (see .claude/rules/project-scoped-ipc.md); pass this host's,
    // which for the board IS the current project.
    moveTask: (input, skipConfirmation) => moveTask(input, skipConfirmation, projectId || null),
    unarchiveTask,
    archiveTask,
    updateAttachmentCount,
    refresh: loadBoard,
    isMoveConfirmPending: () => useBoardStore.getState().pendingMoveConfirm !== null,
    shortcutsSuppressed: boardManagerOpen || settingsOpen,
  }), [
    projectId, projectPath, defaultAgent, swimlanes, shortcuts, config,
    updateTask, deleteTask, moveTask, unarchiveTask, archiveTask, updateAttachmentCount, loadBoard,
    boardManagerOpen, settingsOpen,
  ]);

  return <TaskDetailHostProvider value={value}>{children}</TaskDetailHostProvider>;
}
