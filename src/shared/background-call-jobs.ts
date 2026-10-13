import type { BackgroundCallJob } from './types';

/**
 * The background call jobs in the one order every surface lists them: the
 * usage dashboard's Background card and history table, and the MCP usage line.
 */
export const BACKGROUND_CALL_JOBS: readonly BackgroundCallJob[] = [
  'condition_check',
  'workflow_step',
  'task_summary',
  'task_title',
  'terminal_name',
];

/** Each job as a plural noun, for a card cell or a table row. */
export const BACKGROUND_CALL_JOB_LABELS: Record<BackgroundCallJob, string> = {
  condition_check: 'Condition checks',
  workflow_step: 'Workflow steps',
  task_summary: 'Task summaries',
  task_title: 'Task titles',
  terminal_name: 'Terminal names',
};

export function isBackgroundCallJob(value: string): value is BackgroundCallJob {
  return (BACKGROUND_CALL_JOBS as readonly string[]).includes(value);
}
