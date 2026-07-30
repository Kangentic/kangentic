/**
 * React context that hands the task-detail surface everything it needs to know
 * about the PROJECT its task belongs to, so the surface itself never reads
 * ambient `currentProject` / `useBoardStore` state.
 *
 * Why this exists: the task detail is a task-scoped surface, and
 * `.claude/rules/pop-out-surface-registry.md` already states the rule -
 * "task-scoped surfaces resolve their own data from `params` ({ taskId,
 * projectId }), never from ambient currentProject/currentTask state". It read
 * ambient state anyway, which is fine while the only host is the board (whose
 * task is always the current project's) and wrong the moment a second host wants
 * to show a task from a DIFFERENT project. The Agent Monitor is that second host.
 *
 * The shape deliberately mirrors `window-manager/context.tsx`, which solved the
 * same problem one level up: the window engine is mounted more than once, and
 * every shared component reads its instance from context instead of importing a
 * module singleton, so the layers never cross-talk. Same idea, different axis.
 *
 * Two implementations are expected:
 *   - the BOARD host, backed by the live board / config / project stores, so the
 *     board's behaviour is byte-for-byte what it was before this context existed;
 *   - the MONITOR host, backed by a per-project bundle fetched for the row's
 *     project, whose mutations go straight to the project-stamped IPC (the board
 *     store holds a different project, so its optimistic update would be wrong).
 *
 * Enforcement: `tests/unit/task-detail-host-decoupling.test.ts` fails if any file
 * under `task-detail/` or `TaskDetailWindow.tsx` re-imports the project or board
 * store, so a future edit cannot silently re-couple the surface.
 */

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type {
  ShortcutConfig,
  Swimlane,
  Task,
  TaskMoveInput,
  TaskUnarchiveInput,
  TaskUpdateInput,
} from '../../../../shared/types';
import type { MoveTaskResult } from '../../../stores/board-store/task-slice';

/** The per-project config values the task-detail surface actually reads. */
export interface TaskDetailHostConfig {
  /** Label -> color map for LabelPills. */
  labelColors: Record<string, string>;
  /** Fallback base branch when the task pins none. */
  defaultBaseBranch: string;
  /** Whether this project creates worktrees at all. */
  worktreesEnabled: boolean;
  /** Whether the embedded Browser pane is offered. */
  browserEnabled: boolean;
}

export interface TaskDetailHostValue {
  /** The project the hosted task belongs to. NOT necessarily the open board's. */
  projectId: string;
  /** Absolute path of that project, for shortcut cwd and @-mention search. */
  projectPath: string;
  /** That project's default agent, for the ContextBar's capability lookup. */
  defaultAgent: string | null;

  swimlanes: Swimlane[];
  shortcuts: (ShortcutConfig & { source: 'team' | 'local' })[];
  config: TaskDetailHostConfig;

  /** Tasks currently sitting in a lane. Used only to append at the end on a move. */
  laneTasks: (swimlaneId: string) => Task[];

  updateTask: (input: TaskUpdateInput) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (input: TaskMoveInput, skipConfirmation?: boolean) => Promise<MoveTaskResult>;
  unarchiveTask: (input: TaskUnarchiveInput) => Promise<void>;
  archiveTask: (id: string) => void;
  updateAttachmentCount: (taskId: string, delta: number) => void;
  /** Re-read this host's own data after a write that bypassed it. */
  refresh: () => Promise<void>;

  /**
   * True when `moveTask` opened a confirmation instead of moving, so a caller
   * knows not to close the window or toast success. Only the board host can
   * raise one (it owns the confirm dialog); other hosts return false.
   */
  isMoveConfirmPending: () => boolean;

  /**
   * True while another surface is stacked above this host and owns the keyboard,
   * so the window's Escape and shortcuts must stand down. A single Escape meant
   * for that surface must not also close the window underneath (or raise its
   * discard confirm).
   *
   * Which surfaces those are is the HOST's knowledge, not the window's: the board
   * layer can have the Board Manager over it, a monitor layer cannot. Asking the
   * host one question keeps the window from enumerating every host's chrome.
   */
  shortcutsSuppressed: boolean;
}

const TaskDetailHostContext = createContext<TaskDetailHostValue | null>(null);

export function TaskDetailHostProvider(
  { value, children }: { value: TaskDetailHostValue; children: ReactNode },
) {
  return (
    <TaskDetailHostContext.Provider value={value}>{children}</TaskDetailHostContext.Provider>
  );
}

/**
 * The hosting project's context. Throws rather than falling back to the current
 * project: a silent fallback is exactly the bug this context exists to prevent
 * (a monitor-hosted task quietly writing to whichever board happens to be open).
 */
export function useTaskDetailHost(): TaskDetailHostValue {
  const value = useContext(TaskDetailHostContext);
  if (!value) {
    throw new Error('useTaskDetailHost must be used within a TaskDetailHostProvider');
  }
  return value;
}
