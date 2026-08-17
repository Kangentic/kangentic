import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Task, TaskCreateInput, TaskUpdateInput, TaskMoveInput, ArchivedTasksPreview, AutoCommandState } from '../../../shared/types';
import { worktreeFolderUnderRoot } from '../../../shared/worktree-folder';

/** Raw row from SQLite - labels stored as JSON string. */
interface TaskRow extends Omit<Task, 'labels'> {
  labels: string;
}

function rowToTask(row: TaskRow): Task {
  let labels: string[] = [];
  try {
    labels = JSON.parse(row.labels);
  } catch { /* default to empty */ }
  return { ...row, labels };
}

/**
 * The four "Advanced pin" fields. A task either pins these for its whole life OR
 * rides a Board Profile's per-column ladder - never both.
 *
 * `auto_command` is deliberately absent: it is an MCP-only escape hatch rather
 * than an Advanced pin, so a task may carry it alongside a profile. It likewise
 * never implies `run_mode: 'agent_override'`, which is why an MCP-set
 * auto-command does not trip the first-spawn lock.
 */
const ADVANCED_PIN_FIELDS = ['agent_override', 'model_override', 'effort_override', 'permission_mode'] as const;

type AdvancedPinFields = Pick<Task, typeof ADVANCED_PIN_FIELDS[number]>;
type ExclusiveFields = AdvancedPinFields & Pick<Task, 'profile_id' | 'run_mode'>;

const CLEARED_PINS = {
  agent_override: null,
  model_override: null,
  effort_override: null,
  permission_mode: null,
} as const;

/**
 * Enforce profile-vs-pin mutual exclusivity and keep `run_mode` consistent with
 * it, deciding by what the CALLER asked for rather than by the merged result.
 *
 * This is the single write-time chokepoint for the invariant, so IPC, MCP, the
 * mobile bridge, and every other caller inherit it rather than each remembering
 * the rule. It is load-bearing beyond tidiness:
 * `lockAdvancedOverridesOnFirstSpawn` fires on `run_mode === 'agent_override'`,
 * so a profile task that also claimed override mode would get all four fields
 * frozen to its first column's values and its ladder would silently flatten.
 *
 * `requested` must contain only the fields the caller explicitly provided
 * (`undefined` = untouched). Reading intent from `requested` rather than from the
 * merged `next` is what makes "pin a model on a task that currently rides a
 * profile" do the obvious thing - switch it to Custom - instead of the merged
 * view seeing a non-null profile_id and throwing the new pin away.
 *
 * Precedence, highest first:
 *   1. A profile assignment wins outright: it is the more specific intent, and
 *      it is how the UI expresses "switch this task off its Custom pins onto a
 *      ladder". It clears the pins AND forces `'column_settings'`.
 *   2. Pinning any of the four, or asking for `'agent_override'` explicitly,
 *      means override mode and detaches from the profile. The explicit mode
 *      matters on its own: "Agent Override with everything left on inherit"
 *      pins nothing, and is exactly the state the derived-mode approach lost.
 *   3. Asking for `'column_settings'` clears the pins, mirroring what the
 *      dialog's Column Settings card does locally.
 * A write touching none of them leaves all three alone.
 */
function applyProfileExclusivity(next: ExclusiveFields, requested: Partial<ExclusiveFields>): ExclusiveFields {
  if (requested.profile_id != null) {
    return { ...next, ...CLEARED_PINS, run_mode: 'column_settings' };
  }
  const pinsAnyField = ADVANCED_PIN_FIELDS.some((field) => requested[field] != null);
  if (pinsAnyField || requested.run_mode === 'agent_override') {
    return { ...next, profile_id: null, run_mode: 'agent_override' };
  }
  if (requested.run_mode === 'column_settings') {
    return { ...next, ...CLEARED_PINS, run_mode: 'column_settings' };
  }
  return next;
}

export class TaskRepository {
  constructor(private db: Database.Database) {}

  private static readonly SELECT_WITH_COUNT = `
    SELECT t.*, COALESCE(ac.cnt, 0) as attachment_count
    FROM tasks t
    LEFT JOIN (
      SELECT task_id, COUNT(*) as cnt
      FROM task_attachments
      GROUP BY task_id
    ) ac ON ac.task_id = t.id`;

  list(swimlaneId?: string): Task[] {
    if (swimlaneId) {
      const rows = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
        WHERE t.swimlane_id = ? AND t.archived_at IS NULL
        ORDER BY t.position ASC`).all(swimlaneId) as TaskRow[];
      return rows.map(rowToTask);
    }
    const rows = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.archived_at IS NULL
      ORDER BY t.swimlane_id, t.position ASC`).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  getById(id: string): Task | undefined {
    const row = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.id = ?`).get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getByDisplayId(displayId: number): Task | undefined {
    const row = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.display_id = ?`).get(displayId) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getBySessionId(sessionId: string): Task | undefined {
    const row = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.session_id = ? AND t.archived_at IS NULL
      LIMIT 1`).get(sessionId) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Find the active (non-archived) task owning a git branch. Used by PR linking
   * to map a branch->PR result back to a task without a live session. Branch
   * names are effectively unique per task; picks the most recently updated to be
   * safe if duplicates ever exist.
   */
  getByBranchName(branchName: string): Task | undefined {
    const row = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.branch_name = ? AND t.archived_at IS NULL
      ORDER BY t.updated_at DESC
      LIMIT 1`).get(branchName) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Allocate the next display_id. MONOTONIC: the high-water mark in
   * `project_meta` only moves forward, so deleting the highest-numbered task
   * never hands its number to the next one created. That matters because a
   * task's worktree directory is named after its display_id, and a recycled
   * number could adopt a leftover directory belonging to the deleted task.
   *
   * `MAX(display_id)` stays in the calculation so the counter self-heals if the
   * meta row is lost or the database is restored from an older copy.
   *
   * Callers must already be inside a transaction.
   */
  private allocateDisplayId(): number {
    const storedHighWater = this.db
      .prepare("SELECT value FROM project_meta WHERE key = 'display_id_high_water'")
      .get() as { value: string } | undefined;
    const parsedHighWater = storedHighWater ? Number.parseInt(storedHighWater.value, 10) : 0;
    const highWater = Number.isFinite(parsedHighWater) ? parsedHighWater : 0;

    const maxDisplayId = this.db
      .prepare('SELECT COALESCE(MAX(display_id), 0) as max FROM tasks')
      .get() as { max: number };

    const displayId = Math.max(highWater, maxDisplayId.max) + 1;
    this.db.prepare(`INSERT INTO project_meta (key, value) VALUES ('display_id_high_water', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(displayId));
    return displayId;
  }

  /**
   * Record a task's worktree directory name. Write-once: the `worktree_folder IS
   * NULL` guard means a second call with a different value is a no-op, so a
   * task's worktree can never be relocated by a later write. See the JSDoc on
   * `Task.worktree_folder`.
   */
  setWorktreeFolder(id: string, folder: string): void {
    this.db
      .prepare('UPDATE tasks SET worktree_folder = ? WHERE id = ? AND worktree_folder IS NULL')
      .run(folder, id);
  }

  /**
   * Persist a freshly created worktree: its path, its branch, and the directory
   * name that must never change again.
   *
   * Atomic on purpose. Written as two statements, a crash in between would leave
   * `worktree_path` set with `worktree_folder` still null; the
   * `basename(worktree_path)` fallback would mask that until the task reached
   * Done, which nulls the path and would lose the folder permanently.
   */
  recordWorktree(id: string, worktreePath: string, branchName: string, worktreeFolder: string): void {
    this.db.transaction(() => {
      this.update({ id, worktree_path: worktreePath, branch_name: branchName });
      this.setWorktreeFolder(id, worktreeFolder);
    })();
  }

  /**
   * Recover, and persist, the worktree directory name a task used BEFORE the
   * numeric scheme, for a task whose `worktree_path` has already been cleared.
   * Returns null when there is nothing to recover, in which case the task takes
   * the numeric name on its next creation.
   *
   * This exists because a Done move nulls `worktree_path`, so a pre-existing
   * task moved back out is a fresh creation with no record of where it used to
   * live. `sessions.cwd` is that record: it holds the exact historical worktree
   * path for every task that ever ran an agent, and survives Done cleanup (the
   * only `DELETE FROM sessions` is `deleteByTaskId`, called from full-reset
   * paths whose tasks correctly fall through to the numeric name here).
   *
   * The `worktreesRoot` anchor is what makes this safe. Kangentic can be opened
   * AT a worktree path (an opened worktree, or a /preview ephemeral project), in
   * which case the project root itself contains `.kangentic/worktrees/` and a
   * bare marker search would hand a task that never had a worktree the enclosing
   * worktree's folder name - permanently, since the column is write-once. Only a
   * direct child of this project's own worktrees root counts.
   */
  recoverLegacyWorktreeFolder(taskId: string, worktreesRoot: string): string | null {
    const latestSession = this.db
      .prepare('SELECT cwd FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(taskId) as { cwd: string } | undefined;
    const folder = worktreeFolderUnderRoot(worktreesRoot, latestSession?.cwd);
    if (folder) this.setWorktreeFolder(taskId, folder);
    return folder;
  }

  create(input: TaskCreateInput): Task {
    return this.db.transaction(() => this.createWithinTransaction(input))();
  }

  /**
   * The raw `position` that appends past everything currently in a swimlane.
   *
   * Counts ARCHIVED rows too, unlike `list()`. That asymmetry is deliberate and
   * long-standing: archiving leaves `position` untouched, so an append that
   * ignored archived rows could reuse a position an archived task still holds.
   * Callers placing a task by ordinal slot need this as their append anchor -
   * see `resolveRawPosition` in `agent/commands/task-ordering.ts`.
   */
  nextPositionInSwimlane(swimlaneId: string): number {
    const maxPosition = this.db.prepare('SELECT COALESCE(MAX(position), -1) as max FROM tasks WHERE swimlane_id = ?').get(swimlaneId) as { max: number };
    return maxPosition.max + 1;
  }

  private createWithinTransaction(input: TaskCreateInput): Task {
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const id = uuidv4();
    const position = this.nextPositionInSwimlane(input.swimlane_id);

    const displayId = this.allocateDisplayId();

    const labels = input.labels ?? [];
    const priority = input.priority ?? 0;

    const exclusive = applyProfileExclusivity({
      agent_override: input.agent_override ?? null,
      model_override: input.model_override ?? null,
      effort_override: input.effort_override ?? null,
      permission_mode: input.permission_mode ?? null,
      profile_id: input.profile_id ?? null,
      run_mode: input.run_mode ?? 'column_settings',
    }, input);

    const task: Task = {
      id,
      display_id: displayId,
      title: input.title,
      description: input.description,
      swimlane_id: input.swimlane_id,
      position,
      agent: null,
      session_id: null,
      worktree_path: null,
      worktree_folder: null,
      branch_name: input.customBranchName?.trim() || null,
      pr_number: null,
      pr_url: null,
      pr_state: null,
      head_sha: null,
      external_id: input.externalId ?? null,
      external_source: input.externalSource ?? null,
      external_url: input.externalUrl ?? null,
      base_branch: input.baseBranch || null,
      use_worktree: input.useWorktree != null ? (input.useWorktree ? 1 : 0) : null,
      labels,
      priority,
      model_override: exclusive.model_override,
      effort_override: exclusive.effort_override,
      agent_override: exclusive.agent_override,
      permission_mode: exclusive.permission_mode,
      auto_command: input.auto_command ?? null,
      profile_id: exclusive.profile_id,
      run_mode: exclusive.run_mode,
      attachment_count: 0,
      // A brand-new task has never run an auto_command. These four columns are
      // written only by `recordAutoCommandOutcome`, never by create/update.
      auto_command_state: null,
      auto_command_text: null,
      auto_command_error: null,
      auto_command_at: null,
      detail_view_state: null,
      archived_at: null,
      created_at: createdAt,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, agent, session_id, worktree_path, branch_name, pr_number, pr_url, pr_state, head_sha, external_id, external_source, external_url, base_branch, use_worktree, labels, priority, model_override, effort_override, agent_override, permission_mode, auto_command, profile_id, run_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.display_id, task.title, task.description, task.swimlane_id, task.position, task.agent, task.session_id, task.worktree_path, task.branch_name, task.pr_number, task.pr_url, task.pr_state, task.head_sha, task.external_id, task.external_source, task.external_url, task.base_branch, task.use_worktree, JSON.stringify(labels), task.priority, task.model_override, task.effort_override, task.agent_override, task.permission_mode, task.auto_command, task.profile_id, task.run_mode, task.created_at, task.updated_at);

    return task;
  }

  update(input: TaskUpdateInput): Task {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Task ${input.id} not found`);

    const merged: Task = {
      ...existing,
      ...Object.fromEntries(Object.entries(input).filter(([_, v]) => v !== undefined)),
      updated_at: new Date().toISOString(),
    };
    // Decide exclusivity from `input` (what the caller asked to change), not
    // `merged` - otherwise pinning a model on a task that currently rides a
    // profile would see the inherited profile_id and discard the new pin.
    const updated: Task = { ...merged, ...applyProfileExclusivity(merged, input) };

    this.db.prepare(`
      UPDATE tasks SET title = ?, description = ?, swimlane_id = ?, position = ?, agent = ?, session_id = ?, worktree_path = ?, branch_name = ?, pr_number = ?, pr_url = ?, pr_state = ?, head_sha = ?, base_branch = ?, use_worktree = ?, labels = ?, priority = ?, model_override = ?, effort_override = ?, agent_override = ?, permission_mode = ?, profile_id = ?, run_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.title, updated.description, updated.swimlane_id, updated.position, updated.agent, updated.session_id, updated.worktree_path, updated.branch_name, updated.pr_number, updated.pr_url, updated.pr_state, updated.head_sha, updated.base_branch, updated.use_worktree, JSON.stringify(updated.labels), updated.priority, updated.model_override, updated.effort_override, updated.agent_override, updated.permission_mode, updated.profile_id, updated.run_mode, updated.updated_at, updated.id);

    return updated;
  }

  /**
   * Update only the model/effort override fields on a task. Any field omitted
   * from `patch` is left untouched; passing `null` clears that override.
   * Used by the ContextBar popover (`task:setRuntimeOverride` IPC) so that
   * we don't have to load the full task and re-write every column.
   *
   * Pinning a value here is a pin like any other, so it clears `profile_id` and
   * switches `run_mode` to `'agent_override'` via the same exclusivity rule.
   * Both columns are in the SET list below for that reason - deriving the mode
   * and then not writing it would throw the switch away. This DOES fire in
   * practice: `ModelEffortPicker`
   * (the ContextBar / PreSpawnContextBar model and effort pills) has no
   * awareness of `profile_id`, so picking a concrete model or effort on a task
   * riding a profile detaches it from the ladder here, with no confirmation in
   * the UI. Clearing a value to null is not a pin and leaves `profile_id`
   * intact. Gating the picker on `profile_id` is a deliberate open question
   * (block, warn, or allow); until it is answered this repository is the only
   * enforcement point, which is why the rule lives here rather than in the UI.
   */
  updateOverrides(taskId: string, patch: { model_override?: string | null; effort_override?: string | null }): void {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Task ${taskId} not found`);
    const newModel = patch.model_override !== undefined ? patch.model_override : existing.model_override;
    const newEffort = patch.effort_override !== undefined ? patch.effort_override : existing.effort_override;
    const exclusive = applyProfileExclusivity(
      { ...existing, model_override: newModel, effort_override: newEffort },
      patch,
    );
    this.db.prepare(
      'UPDATE tasks SET model_override = ?, effort_override = ?, profile_id = ?, run_mode = ?, updated_at = ? WHERE id = ?',
    ).run(exclusive.model_override, exclusive.effort_override, exclusive.profile_id, exclusive.run_mode, new Date().toISOString(), taskId);
  }

  /**
   * Persist the task-detail dialog's layout blob (serialized
   * `TaskDetailViewState`, or null to clear). Deliberately does NOT bump
   * `updated_at`: view-state churn (every divider drag) must not reorder the
   * board or trip "recently updated". The generic `update()` column list
   * omits `detail_view_state`, so a normal task edit never clobbers it.
   */
  setDetailViewState(taskId: string, detailViewState: string | null): void {
    this.db.prepare('UPDATE tasks SET detail_view_state = ? WHERE id = ?').run(detailViewState, taskId);
  }

  move(input: TaskMoveInput): void {
    const { taskId, targetSwimlaneId, targetPosition } = input;
    const task = this.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const tx = this.db.transaction(() => {
      // Remove from old position - shift down tasks above in old swimlane
      this.db.prepare('UPDATE tasks SET position = position - 1 WHERE swimlane_id = ? AND position > ?')
        .run(task.swimlane_id, task.position);

      // Make room in new position - shift up tasks at and above target position
      this.db.prepare('UPDATE tasks SET position = position + 1 WHERE swimlane_id = ? AND position >= ?')
        .run(targetSwimlaneId, targetPosition);

      // Move the task
      this.db.prepare('UPDATE tasks SET swimlane_id = ?, position = ?, updated_at = ? WHERE id = ?')
        .run(targetSwimlaneId, targetPosition, new Date().toISOString(), taskId);
    });
    tx();
  }

  /**
   * Rewrite a column's task order as dense positions (0..n-1) in one
   * transaction. This is the write behind the MCP placement surface:
   * `kangentic_reorder_tasks`, and `kangentic_move_task`'s same-column
   * `position`.
   *
   * A dense rewrite rather than a sequence of `move()` calls, for three
   * reasons. It is atomic. It is immune to the ordinal-vs-raw hazard `move()`
   * inherits from gapped positions (`archive()` leaves `position` untouched and
   * `create` takes `MAX(position) + 1` over archived rows, so a column's live
   * cards can sit at 0, 5, 9). And it HEALS those gaps, in any column where
   * every id passed is a member of that column - which is what both callers
   * guarantee. A stray id consumes its slot as a no-op (the `swimlane_id`
   * guard), so a caller that skipped that check would leave the column gapped
   * rather than dense.
   *
   * It writes `position` and NOTHING ELSE - deliberately, and this is
   * load-bearing rather than an omission. `move()` bumps `updated_at` only on
   * the row that actually moved; its two position-shift UPDATEs leave siblings
   * alone. `lane-pins.ts` builds on exactly that: a lane pin holds while the
   * server keeps telling the pre-move story, and it drops the moment a payload
   * differs in {presence, lane, `updated_at`}, so a sibling merely shifting
   * position must not carry a fresh stamp or it spuriously drops a pin and the
   * user's in-flight card snaps back mid-drag. Stamping every reordered row
   * would break that. The board still repaints, because
   * `structural-sharing.ts` compares `position` field-by-field rather than
   * keying off `updated_at`. The `position != ?` guard keeps re-issuing the
   * same order a no-write, and the `swimlane_id` guard makes an id from another
   * column a no-op rather than a cross-column corruption.
   *
   * Deliberately NOT wrapped in `withTaskLock`
   * (`.claude/rules/task-lifecycle-lock.md`, which is path-scoped to
   * `src/main/ipc/**` and so does not auto-load at the call sites): that lock is
   * per-task and documented non-reentrant, so there is no correct way to hold it
   * for the N tasks a reorder mutates. The rule's own carve-out covers this
   * instead - the whole rewrite is synchronous, so it cannot interleave with
   * anything and there is no race to serialize. Two accepted residuals, both
   * presentation-only and both self-healing on the next drag or reorder:
   * `handleTaskMove` captures a task's `originalPosition` before its unlocked
   * git I/O and restores it on rollback, so a reorder landing inside that window
   * makes the rollback restore a stale position; and `handleMoveTask`'s
   * CROSS-column path resolves an ordinal to a raw anchor synchronously but
   * hands it to a fire-and-forget `onTaskMove`, so a reorder of the destination
   * lane before that write lands leaves the incoming card beside a different
   * neighbour than the one the anchor named.
   */
  reorderWithinSwimlane(swimlaneId: string, orderedTaskIds: string[]): void {
    const updatePositionStatement = this.db.prepare(
      'UPDATE tasks SET position = ? WHERE id = ? AND swimlane_id = ? AND position != ?',
    );
    const tx = this.db.transaction(() => {
      orderedTaskIds.forEach((taskId, index) => {
        updatePositionStatement.run(index, taskId, swimlaneId, index);
      });
    });
    tx();
  }

  archive(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  }

  /**
   * Clear the archive flag WITHOUT moving the task, the exact inverse of
   * `archive()`.
   *
   * `unarchive()` below also rewrites swimlane_id and position, which suits the
   * restore-from-the-Completed-list flow that picks a destination. A task move
   * has already placed the row by the time it needs this, so re-running the
   * placement there would fight `move()`'s own sibling reordering.
   */
  clearArchived(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
  }

  /**
   * Record the outcome of this task's most recent auto_command delivery.
   *
   * Deliberately NOT part of `update()`: this is engine telemetry, not a user
   * edit, so it must not bump `updated_at` and trip the board's
   * something-changed paths on every column move.
   */
  recordAutoCommandOutcome(
    id: string,
    outcome: { state: AutoCommandState; command: string; error: string | null },
  ): void {
    this.db.prepare(
      'UPDATE tasks SET auto_command_state = ?, auto_command_text = ?, auto_command_error = ?, auto_command_at = ? WHERE id = ?',
    ).run(outcome.state, outcome.command, outcome.error, new Date().toISOString(), id);
  }

  unarchive(id: string, targetSwimlaneId: string, position: number): Task {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET archived_at = NULL, swimlane_id = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(targetSwimlaneId, position, now, id);
    return this.getById(id)!;
  }

  listArchived(): Task[] {
    const rows = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.archived_at IS NOT NULL
      ORDER BY t.archived_at DESC`).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * The newest `limit` archived tasks plus the total archived count. Lets the
   * board hydrate the Done column's count + inline preview without fetching the
   * whole archive (which can be many MB once hundreds of tasks accumulate). The
   * full list is fetched via `listArchived` only when the Completed dialog opens.
   */
  listArchivedPreview(limit: number): ArchivedTasksPreview {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE archived_at IS NOT NULL')
      .get() as { count: number };
    const rows = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.archived_at IS NOT NULL
      ORDER BY t.archived_at DESC
      LIMIT ?`).all(boundedLimit) as TaskRow[];
    return { totalCount: count, tasks: rows.map(rowToTask) };
  }

  /**
   * One page of archived tasks, newest first, plus the total archived count.
   *
   * Sibling of `listArchivedPreview` for a caller that scrolls rather than
   * previews: the mobile bridge's Done column pages through the archive, and
   * neither existing method fits - `listArchivedPreview` has no offset, and
   * `listArchived` loads the whole archive (the exact cost that method's own
   * doc comment warns about) to serve one screenful.
   */
  listArchivedPage(limit: number, offset: number): ArchivedTasksPreview {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const boundedOffset = Math.max(0, Math.floor(offset));
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE archived_at IS NOT NULL')
      .get() as { count: number };
    const rows = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.archived_at IS NOT NULL
      ORDER BY t.archived_at DESC
      LIMIT ? OFFSET ?`).all(boundedLimit, boundedOffset) as TaskRow[];
    return { totalCount: count, tasks: rows.map(rowToTask) };
  }

  /**
   * Tasks in a given swimlane, including archived ones. Used by resource
   * cleanup where `archived_at` is not relevant to disk-state reconciliation
   * (e.g. retrying worktree removal for Done-role tasks whose initial
   * deletion failed - those are archived immediately on move to Done).
   */
  listAllInSwimlane(swimlaneId: string): Task[] {
    const rows = this.db.prepare(`${TaskRepository.SELECT_WITH_COUNT}
      WHERE t.swimlane_id = ?
      ORDER BY t.position ASC`).all(swimlaneId) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Rename a label across all tasks. Returns count of modified tasks. */
  renameLabel(oldName: string, newName: string): number {
    const allRows = this.db.prepare('SELECT id, labels FROM tasks').all() as Array<{ id: string; labels: string }>;
    let modifiedCount = 0;
    const now = new Date().toISOString();
    const updateStatement = this.db.prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?');

    this.db.transaction(() => {
      for (const row of allRows) {
        let labels: string[];
        try { labels = JSON.parse(row.labels); } catch { continue; }
        const index = labels.indexOf(oldName);
        if (index === -1) continue;
        labels[index] = newName;
        const unique = [...new Set(labels)];
        updateStatement.run(JSON.stringify(unique), now, row.id);
        modifiedCount++;
      }
    })();

    return modifiedCount;
  }

  /** Remove a label from all tasks. Returns count of modified tasks. */
  deleteLabel(name: string): number {
    const allRows = this.db.prepare('SELECT id, labels FROM tasks').all() as Array<{ id: string; labels: string }>;
    let modifiedCount = 0;
    const now = new Date().toISOString();
    const updateStatement = this.db.prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?');

    this.db.transaction(() => {
      for (const row of allRows) {
        let labels: string[];
        try { labels = JSON.parse(row.labels); } catch { continue; }
        const filtered = labels.filter((label) => label !== name);
        if (filtered.length === labels.length) continue;
        updateStatement.run(JSON.stringify(filtered), now, row.id);
        modifiedCount++;
      }
    })();

    return modifiedCount;
  }

  delete(id: string): void {
    const task = this.getById(id);
    if (!task) return;

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      // Shift down tasks above the deleted one
      this.db.prepare('UPDATE tasks SET position = position - 1 WHERE swimlane_id = ? AND position > ?')
        .run(task.swimlane_id, task.position);
    });
    tx();
  }
}
