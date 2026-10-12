import type { WorkflowDraftTask, WorkflowTaskRunSettings } from '../../../shared/types';
import { DEFAULT_RUN_SETTINGS } from '../../../shared/workflow-run-settings';

/**
 * The New Task form's workflow mode (#732, sign-offs 9 and 25): what an edit
 * of a planned task opens on. Pure, so the unit tier can drive it.
 */

/**
 * What the form opens with when it edits a planned task: the planned row
 * itself (`initial: editing.planned`). Every field is required, so a host
 * cannot pass the text alone and leave the form to guess the task's board and
 * run settings: a Save from a form that guessed would move the task to the
 * workflow's own board and overwrite what its plan set.
 */
export type WorkflowTaskInitial = Pick<
  WorkflowDraftTask,
  'title' | 'description' | 'labels' | 'priority' | 'project_id' | 'existing_task_id'
> & WorkflowTaskRunSettings;

/** The run settings a planned row holds, with every absent one at its default (Add task has no row). */
export function runSettingsFrom(row: Partial<WorkflowTaskRunSettings> | undefined): WorkflowTaskRunSettings {
  return {
    base_branch: row?.base_branch ?? DEFAULT_RUN_SETTINGS.base_branch,
    use_worktree: row?.use_worktree ?? DEFAULT_RUN_SETTINGS.use_worktree,
    run_mode: row?.run_mode ?? DEFAULT_RUN_SETTINGS.run_mode,
    profile_id: row?.profile_id ?? DEFAULT_RUN_SETTINGS.profile_id,
    agent_override: row?.agent_override ?? DEFAULT_RUN_SETTINGS.agent_override,
    model_override: row?.model_override ?? DEFAULT_RUN_SETTINGS.model_override,
    effort_override: row?.effort_override ?? DEFAULT_RUN_SETTINGS.effort_override,
    permission_mode: row?.permission_mode ?? DEFAULT_RUN_SETTINGS.permission_mode,
  };
}

/**
 * Whether the form shows the task's board and run rows and sends them on Save:
 * in workflow mode, unless the plan takes the task in from a board, where it
 * keeps that board and its own settings.
 */
export function showsPlannedTaskRows(workflowMode: boolean, initial: Pick<WorkflowTaskInitial, 'existing_task_id'> | undefined): boolean {
  return workflowMode && !initial?.existing_task_id;
}
