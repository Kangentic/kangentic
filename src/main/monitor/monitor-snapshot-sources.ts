/**
 * What an Agent Monitor snapshot reads beyond the session registry and each
 * project's repositories, kept in its own module so the aggregator imports it
 * as a type only. The aggregator's unit tests then load no Electron and no
 * SQLite, and pass fakes for these two reads.
 */
import type { MonitorRowWorkflow } from '../../shared/types';
import { getExistingProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { browserPaneRegistry } from '../browser/browser-pane-registry';

export interface MonitorSnapshotSources {
  /** Every task with a browser running, read once per snapshot rather than per row. */
  browserTaskIds(): ReadonlySet<string>;
  /**
   * A task's workflow, read from the workflow's home project. Null when the
   * workflow is finished (a finished workflow draws no strip on the board
   * either) or its home project's database is gone.
   */
  readWorkflow(homeProjectId: string, workflowId: string): MonitorRowWorkflow | null;
}

export const monitorSnapshotSources: MonitorSnapshotSources = {
  browserTaskIds: () => browserPaneRegistry.taskIds(),
  readWorkflow(homeProjectId, workflowId) {
    // Not `getProjectDb`: a home id can outlive its project, and that would
    // create, migrate and seed an empty database for it.
    const database = getExistingProjectDb(homeProjectId);
    if (!database) return null;
    const workflow = new WorkflowRepository(database).getById(workflowId);
    if (!workflow || workflow.state === 'done') return null;
    return { id: workflow.id, title: workflow.title, colorSlot: workflow.color_slot };
  },
};
