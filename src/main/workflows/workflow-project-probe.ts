import { peekProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';

/** What a board holds that the workflow engine has to read. */
export interface WorkflowProjectProbe {
  /** It homes a running or paused workflow, so the engine opens it. */
  homesActive: boolean;
  /** Every workflow any of its tasks belongs to, archived tasks and finished workflows included. */
  memberOf: ReadonlySet<string>;
}

const NOTHING_TO_READ: WorkflowProjectProbe = { homesActive: false, memberOf: new Set() };

/**
 * Look at a project's database the engine has not opened, without opening it
 * (`peekProjectDb`): no migrations, no handle kept. Two indexed reads
 * (`idx_workflows_state`, `idx_tasks_workflow`). A database from before
 * workflows has neither the table nor the column: `tasks.workflow_id` came in
 * the same migration as the `workflows` table, and that migration is one
 * transaction, so one schema check covers both reads.
 *
 * A missing file holds nothing to read. Throws when the file cannot be read
 * (locked, not a database), so the caller can tell "nothing there" from "could
 * not look".
 */
export function probeWorkflowProject(projectId: string): WorkflowProjectProbe {
  const probe = peekProjectDb(projectId, (db): WorkflowProjectProbe => {
    const hasWorkflows = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflows'").get() !== undefined;
    if (!hasWorkflows) return NOTHING_TO_READ;
    return {
      homesActive: new WorkflowRepository(db).hasActive(),
      memberOf: new TaskRepository(db).workflowIdsOnBoard(),
    };
  });
  return probe ?? NOTHING_TO_READ;
}
