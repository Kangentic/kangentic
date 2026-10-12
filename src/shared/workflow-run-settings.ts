import { DEFAULT_PERMISSIONS, type PermissionMode, type TaskRunMode, type WorkflowTaskRunSettings } from './types';

/**
 * A planned task's run settings (#732, sign-offs 9 and 25): its base branch,
 * Worktree or Project, and Column Settings with a profile or an agent
 * override. A draft keeps them in the task row's own shape, so Start copies
 * them onto the task it creates.
 */

/** Nothing chosen: Column Settings on the board's own columns, the board's base branch, the project's Worktrees setting. */
export const DEFAULT_RUN_SETTINGS: Readonly<WorkflowTaskRunSettings> = Object.freeze({
  base_branch: null,
  use_worktree: null,
  run_mode: 'column_settings',
  profile_id: null,
  agent_override: null,
  model_override: null,
  effort_override: null,
  permission_mode: null,
});

export const RUN_SETTINGS_FIELDS = [
  'base_branch',
  'use_worktree',
  'run_mode',
  'profile_id',
  'agent_override',
  'model_override',
  'effort_override',
  'permission_mode',
] as const satisfies ReadonlyArray<keyof WorkflowTaskRunSettings>;

export const RUN_MODES: readonly TaskRunMode[] = ['column_settings', 'agent_override'];

/** Every permission mode, from the one list that names them all. */
export const PERMISSION_MODES: readonly PermissionMode[] = DEFAULT_PERMISSIONS.map((entry) => entry.mode);

export function isRunMode(value: unknown): value is TaskRunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Stored run settings, read defensively: a field that is absent (a draft saved
 * before these existed) or malformed reads as its default, never a throw.
 */
export function readRunSettings(entry: Readonly<Record<string, unknown>>): WorkflowTaskRunSettings {
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
  const useWorktree = entry.use_worktree;
  return {
    base_branch: text(entry.base_branch),
    use_worktree: useWorktree === 1 ? 1 : useWorktree === 0 ? 0 : null,
    run_mode: isRunMode(entry.run_mode) ? entry.run_mode : 'column_settings',
    profile_id: text(entry.profile_id),
    agent_override: text(entry.agent_override),
    model_override: text(entry.model_override),
    effort_override: text(entry.effort_override),
    permission_mode: isPermissionMode(entry.permission_mode) ? entry.permission_mode : null,
  };
}

/** Whether a task's run settings differ from the default anywhere. */
export function hasRunSettings(settings: WorkflowTaskRunSettings): boolean {
  return RUN_SETTINGS_FIELDS.some((field) => settings[field] !== DEFAULT_RUN_SETTINGS[field]);
}
