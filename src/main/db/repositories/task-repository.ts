import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Task, TaskCreateInput, TaskUpdateInput, TaskMoveInput } from '../../../shared/types';

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

  create(input: TaskCreateInput): Task {
    const now = new Date().toISOString();
    const id = uuidv4();
    // Get next position in the target swimlane
    const maxPos = this.db.prepare('SELECT COALESCE(MAX(position), -1) as max FROM tasks WHERE swimlane_id = ?').get(input.swimlane_id) as { max: number };
    const position = maxPos.max + 1;

    // Get next display_id (auto-incrementing human-readable ID)
    const maxDisplayId = this.db.prepare('SELECT COALESCE(MAX(display_id), 0) as max FROM tasks').get() as { max: number };
    const displayId = maxDisplayId.max + 1;

    const labels = input.labels ?? [];
    const priority = input.priority ?? 0;

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
      model_override: input.model_override ?? null,
      effort_override: input.effort_override ?? null,
      agent_override: input.agent_override ?? null,
      attachment_count: 0,
      detail_view_state: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, agent, session_id, worktree_path, branch_name, pr_number, pr_url, pr_state, head_sha, external_id, external_source, external_url, base_branch, use_worktree, labels, priority, model_override, effort_override, agent_override, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.display_id, task.title, task.description, task.swimlane_id, task.position, task.agent, task.session_id, task.worktree_path, task.branch_name, task.pr_number, task.pr_url, task.pr_state, task.head_sha, task.external_id, task.external_source, task.external_url, task.base_branch, task.use_worktree, JSON.stringify(labels), task.priority, task.model_override, task.effort_override, task.agent_override, task.created_at, task.updated_at);

    return task;
  }

  update(input: TaskUpdateInput): Task {
    const existing = this.getById(input.id);
    if (!existing) throw new Error(`Task ${input.id} not found`);

    const updated: Task = {
      ...existing,
      ...Object.fromEntries(Object.entries(input).filter(([_, v]) => v !== undefined)),
      updated_at: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE tasks SET title = ?, description = ?, swimlane_id = ?, position = ?, agent = ?, session_id = ?, worktree_path = ?, branch_name = ?, pr_number = ?, pr_url = ?, pr_state = ?, head_sha = ?, base_branch = ?, use_worktree = ?, labels = ?, priority = ?, model_override = ?, effort_override = ?, agent_override = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.title, updated.description, updated.swimlane_id, updated.position, updated.agent, updated.session_id, updated.worktree_path, updated.branch_name, updated.pr_number, updated.pr_url, updated.pr_state, updated.head_sha, updated.base_branch, updated.use_worktree, JSON.stringify(updated.labels), updated.priority, updated.model_override, updated.effort_override, updated.agent_override, updated.updated_at, updated.id);

    return updated;
  }

  /**
   * Update only the model/effort override fields on a task. Any field omitted
   * from `patch` is left untouched; passing `null` clears that override.
   * Used by the ContextBar popover (`task:setRuntimeOverride` IPC) so that
   * we don't have to load the full task and re-write every column.
   */
  updateOverrides(taskId: string, patch: { model_override?: string | null; effort_override?: string | null }): void {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Task ${taskId} not found`);
    const newModel = patch.model_override !== undefined ? patch.model_override : existing.model_override;
    const newEffort = patch.effort_override !== undefined ? patch.effort_override : existing.effort_override;
    this.db.prepare(
      'UPDATE tasks SET model_override = ?, effort_override = ?, updated_at = ? WHERE id = ?',
    ).run(newModel, newEffort, new Date().toISOString(), taskId);
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

  archive(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
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
