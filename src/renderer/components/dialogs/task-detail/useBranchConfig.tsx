import { useCallback, useMemo } from 'react';
import { useTaskDetailHost } from './task-detail-host';
import { useBranchSettings } from '../../../hooks/useBranchSettings';
import { DEFAULT_AGENT, type Task } from '../../../../shared/types';

/**
 * The edit form's Branch row state, fed from the HOSTING project: a worktree
 * for a background project's task must branch from that project's default
 * base, probe that project's folder, and check that project's agent execution
 * mode, never the open board's. The state machine itself is the shared
 * `useBranchSettings`, so the New Task dialog cannot drift from this form.
 */
export function useBranchConfig(task: Task, title: string, isInTodo: boolean) {
  const {
    config: { worktreesEnabled, defaultBaseBranch, agentExecution },
    projectPath,
    defaultAgent,
    swimlanes,
  } = useTaskDetailHost();

  // The agent this task would spawn on: its own override, else the column's,
  // else the project default. Same chain the spawn preamble resolves, minus
  // the profile fold; the main process records the real outcome after spawn.
  const laneAgent = swimlanes.find((lane) => lane.id === task.swimlane_id)?.agent_override ?? null;
  const resolvedAgent = task.agent_override ?? laneAgent ?? defaultAgent ?? DEFAULT_AGENT;
  const remoteAgent = agentExecution[resolvedAgent]?.mode === 'remote';

  const initial = useMemo(() => ({
    baseBranch: task.base_branch || '',
    customBranchName: task.branch_name || '',
    useWorktree: task.use_worktree != null ? Boolean(task.use_worktree) : null,
  }), [task.base_branch, task.branch_name, task.use_worktree]);

  const settings = useBranchSettings({
    title,
    initial,
    worktreesEnabled,
    defaultBaseBranch,
    active: isInTodo,
    projectPath: projectPath || null,
    remoteAgent,
  });

  const { reset } = settings;
  const resetToTask = useCallback(() => reset(initial), [reset, initial]);

  return { ...settings, resetToTask };
}

export type BranchConfigState = ReturnType<typeof useBranchConfig>;
