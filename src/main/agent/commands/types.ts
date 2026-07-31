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
  onTaskDeleted: (task: Task) => void;
  onTaskMove: (input: { taskId: string; targetSwimlaneId: string; targetPosition: number }) => Promise<void>;
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
 * JSONL from disk. CommandBridge dispatches sync handlers inline so test
 * harnesses that read response files immediately after invocation keep
 * working; only Promise-returning handlers go through async dispatch.
 *
 * Do not narrow this back to `CommandResponse` without first migrating
 * every async handler.
 */
export type CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
) => CommandResponse | Promise<CommandResponse>;
