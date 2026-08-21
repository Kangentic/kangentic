import type Database from 'better-sqlite3';
import type { BoardProfile, Task, Swimlane } from '../../../shared/types';

export interface CommandContext {
  getProjectDb: () => Database.Database;
  getProjectPath: () => string;
  /**
   * This project's Board Profiles, read from `kangentic.json`. Profiles are
   * config-only (no DB table), so `getProjectDb` cannot reach them.
   *
   * Bound to the request's project rather than the active one: a cross-project
   * `create_task` must resolve `profile: "Heavy"` against the board it is
   * filing into, not the board on screen. Returns `[]` when the project has
   * none, which is the normal state.
   */
  getBoardProfiles: () => BoardProfile[];
  /**
   * Persist this project's Board Profiles, replacing the whole list, and tell
   * an open renderer to re-read them.
   *
   * Whole-list rather than per-profile because that is the shape
   * `kangentic.json` stores and the Column Manager already writes; the profile
   * handlers do the add/edit/remove against a copy and hand back the result.
   */
  setBoardProfiles: (profiles: BoardProfile[]) => void;
  onTaskCreated: (task: Task, columnName: string, swimlaneId: string) => void;
  onTaskUpdated: (task: Task) => void;
  /**
   * The quiet twin of `onTaskUpdated`, for a PR link/state the APP reconciled
   * rather than the agent: the forced re-resolve that follows a link write.
   * It invalidates the board without claiming an agent updated the task, so it
   * raises no toast (see `IPC.TASK_PR_LINK_CHANGED`).
   *
   * Optional because ~23 test suites hand-build a context; the only production
   * builder is `buildCommandContextForProject`, which the mobile bridge reuses.
   * A builder that omits it loses the board reload AND the board event for
   * these writes, not just the toast - so implement it, do not rely on the
   * caller's `?.`.
   */
  onTaskPrLinkChanged?: (task: Task) => void;
  onTaskDeleted: (task: Task) => void;
  onTaskMove: (input: { taskId: string; targetSwimlaneId: string; targetPosition: number }) => Promise<void>;
  /**
   * Tasks were re-sequenced WITHIN one column. Distinct from `onTaskMove`
   * because a reorder is presentation only: no column change, no session
   * spawn/suspend, no worktree. It must not go through `handleTaskMove`, which
   * aborts any in-flight move for the task before it takes the lock and would
   * therefore kill a user's concurrent cross-column drag of the same card.
   *
   * Takes the column and the ids in their new order, so the push can name the
   * column rather than an arbitrary card.
   */
  onTasksReordered: (swimlane: Swimlane, orderedTaskIds: string[]) => void;
  /**
   * Also used for a newly CREATED column: both mean "this board's columns changed".
   *
   * `previous` is the pre-edit row, and the implementation needs it to work out
   * what actually changed for each task in the column (a model/effort delta to
   * inject, an `auto_spawn` flip to reconcile). Omitted or null for a create,
   * which has no tasks to reconcile.
   */
  onSwimlaneUpdated: (swimlane: Swimlane, previous?: Swimlane | null) => void;
  /**
   * A column was deleted. Separate from `onSwimlaneUpdated` only because the
   * caller passes a pre-delete snapshot of a row that no longer exists.
   *
   * Like the update callback, the implementation MUST write back to
   * `kangentic.json`: the file re-seeds the DB on project open, so a delete that
   * skips the write-back is silently undone the next time the project is opened.
   */
  onSwimlaneDeleted: (swimlane: Swimlane) => void;
  onBacklogChanged: () => void;
  onLabelColorsChanged: (colors: Record<string, string>) => void;
}

export interface CommandResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

/**
 * Handlers may be sync or async. Most are sync (DB-only operations via the
 * synchronous better-sqlite3 driver), but some need to await I/O - e.g.
 * `get_transcript`'s structured branch reads Claude Code's native session
 * JSONL from disk, and `create_task` probes git for a branch conflict before
 * writing its row.
 *
 * Every consumer awaits: `runHandler` (mcp-http/handler-helpers.ts), the mobile
 * bridge's board-tool handler, and the devtools command proxy. The file-based
 * CommandBridge that once required sync handlers to dispatch inline is gone.
 *
 * Do not narrow this back to `CommandResponse` without first migrating
 * every async handler.
 */
export type CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
) => CommandResponse | Promise<CommandResponse>;
