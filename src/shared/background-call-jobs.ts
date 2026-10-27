import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
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

/**
 * Each job as a plural noun, for a card cell or a table row. Resolved where
 * they show: `translateText` on the stats page, `englishText` for an agent.
 */
export const BACKGROUND_CALL_JOB_LABELS: Record<BackgroundCallJob, MessageDescriptor> = {
  condition_check: msg`Condition checks`,
  workflow_step: msg`Workflow steps`,
  task_summary: msg`Task summaries`,
  task_title: msg`Task titles`,
  terminal_name: msg`Terminal names`,
};

export function isBackgroundCallJob(value: string): value is BackgroundCallJob {
  return (BACKGROUND_CALL_JOBS as readonly string[]).includes(value);
}
