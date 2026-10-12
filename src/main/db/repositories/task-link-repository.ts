import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { TaskLink } from '../../../shared/types';
import { writeTransaction } from '../transaction';

/**
 * `task_links`: "blocked waits for blocker to reach Done", in the workflow's
 * home project database.
 *
 * Either end can be a task in another project's database, so nothing here
 * reads a task: the engine resolves each end through its own project
 * (`blocker_project_id`, `blocked_project_id`). A task delete removes the links
 * that name it in `TaskRepository.delete`, the one path every delete takes. A
 * project delete removes the links naming any of its tasks (`deleteForProject`),
 * since it deletes its database file without deleting its tasks one by one.
 */
export class TaskLinkRepository {
  constructor(private db: Database.Database) {}

  listForWorkflow(workflowId: string): TaskLink[] {
    return this.db
      .prepare('SELECT * FROM task_links WHERE workflow_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(workflowId) as TaskLink[];
  }

  /** What `blockedTaskId` waits for. */
  listBlockersOf(blockedTaskId: string): TaskLink[] {
    return this.db
      .prepare('SELECT * FROM task_links WHERE blocked_task_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(blockedTaskId) as TaskLink[];
  }

  /** What waits for `blockerTaskId`. */
  listBlockedBy(blockerTaskId: string): TaskLink[] {
    return this.db
      .prepare('SELECT * FROM task_links WHERE blocker_task_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(blockerTaskId) as TaskLink[];
  }

  /** Add a link. Linking the same pair twice is a no-op that returns the link already there. */
  insert(link: Omit<TaskLink, 'id' | 'created_at'>): TaskLink {
    const existing = this.db
      .prepare('SELECT * FROM task_links WHERE blocker_task_id = ? AND blocked_task_id = ?')
      .get(link.blocker_task_id, link.blocked_task_id) as TaskLink | undefined;
    if (existing) return existing;
    const created: TaskLink = { ...link, id: uuidv4(), created_at: new Date().toISOString() };
    this.db.prepare(`
      INSERT INTO task_links (id, workflow_id, blocker_project_id, blocker_task_id, blocked_project_id, blocked_task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id,
      created.workflow_id,
      created.blocker_project_id,
      created.blocker_task_id,
      created.blocked_project_id,
      created.blocked_task_id,
      created.created_at,
    );
    return created;
  }

  /** Remove one link. True when there was one. */
  delete(blockerTaskId: string, blockedTaskId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM task_links WHERE blocker_task_id = ? AND blocked_task_id = ?')
      .run(blockerTaskId, blockedTaskId);
    return result.changes > 0;
  }

  /** Every link that names a task, either end. Used by Remove from workflow. */
  deleteForTask(taskId: string): number {
    return this.db
      .prepare('DELETE FROM task_links WHERE blocker_task_id = ? OR blocked_task_id = ?')
      .run(taskId, taskId).changes;
  }

  /**
   * Every link with an end on a deleted project's board, as if each of its
   * tasks were deleted. Returns the workflows that lost a link, read in the
   * same transaction as the delete so the two agree.
   */
  deleteForProject(projectId: string): string[] {
    return writeTransaction(this.db, () => {
      const workflowIds = (this.db
        .prepare('SELECT DISTINCT workflow_id FROM task_links WHERE blocker_project_id = ? OR blocked_project_id = ?')
        .all(projectId, projectId) as Array<{ workflow_id: string }>).map((row) => row.workflow_id);
      this.db.prepare('DELETE FROM task_links WHERE blocker_project_id = ? OR blocked_project_id = ?').run(projectId, projectId);
      return workflowIds;
    })();
  }
}
