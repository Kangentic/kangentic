/**
 * What the New Task form's workflow mode opens an edit on. The host passes
 * the planned row itself, so the form shows the task's board and run settings
 * as stored, and the type refuses a host that passes only the text: a form
 * that guessed the rest would move the task to the workflow's own board and
 * overwrite what its plan set.
 */
import { describe, it, expect } from 'vitest';
import { runSettingsFrom, showsPlannedTaskRows, type WorkflowTaskInitial } from '../../src/renderer/components/dialogs/workflow-task-form';
import { DEFAULT_RUN_SETTINGS } from '../../src/shared/workflow-run-settings';
import type { WorkflowDraftTask } from '../../src/shared/types';

const PHONE_TASK: WorkflowDraftTask = {
  key: 'task-2', title: 'Token picker', description: 'Planned.', project_id: 'mobile', existing_task_id: null,
  route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [], labels: [], priority: 0,
  canvas_x: null, canvas_y: null,
  ...DEFAULT_RUN_SETTINGS, base_branch: 'develop', run_mode: 'agent_override', agent_override: 'codex',
};

describe('the planned row an edit opens on', () => {
  it('is the draft row itself, which carries every stored setting', () => {
    // A WorkflowDraftTask is a WorkflowTaskInitial: the host passes `editing.planned` as it is.
    const initial: WorkflowTaskInitial = PHONE_TASK;
    expect(runSettingsFrom(initial)).toEqual({
      ...DEFAULT_RUN_SETTINGS, base_branch: 'develop', run_mode: 'agent_override', agent_override: 'codex',
    });
  });

  it('shows the board and run rows in workflow mode, except for a task the plan takes in from a board', () => {
    expect(showsPlannedTaskRows(true, undefined)).toBe(true);
    expect(showsPlannedTaskRows(true, PHONE_TASK)).toBe(true);
    expect(showsPlannedTaskRows(true, { existing_task_id: 'task-on-the-board' })).toBe(false);
    // The board's own form has no workflow rows.
    expect(showsPlannedTaskRows(false, undefined)).toBe(false);
  });
});

describe('runSettingsFrom', () => {
  it('reads what a row holds, and the default for what it lacks', () => {
    expect(runSettingsFrom(undefined)).toEqual(DEFAULT_RUN_SETTINGS);
    expect(runSettingsFrom({ base_branch: 'develop', use_worktree: 0 })).toEqual({ ...DEFAULT_RUN_SETTINGS, base_branch: 'develop', use_worktree: 0 });
  });
});
