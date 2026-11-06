import fs from 'node:fs';
import type { TaskRepository } from '../../db/repositories/task-repository';
import { readLocalBranchSha } from '../../git/worktree-head';
import { worktreeSkipBeforeBase } from '../../git/worktree-manager';
import { DEFAULT_AGENT, type AppConfig, type Swimlane, type Task } from '../../../shared/types';

/**
 * Whether a task's recorded worktree folder is gone from disk. A task that never
 * had one is not missing anything.
 */
export function isWorktreeMissing(task: Pick<Task, 'worktree_path'>): boolean {
  return Boolean(task.worktree_path) && !fs.existsSync(task.worktree_path as string);
}

/**
 * Whether Resume would make this task's missing worktree again. The branch
 * outlives the folder, so `ensureTaskWorktree` can recreate it at the same path,
 * unless it would skip the task: worktrees are off, it is not a plain repository,
 * or the agent runs on a remote server.
 *
 * The same answer `ensureTaskWorktree` reaches, read from what a startup pass
 * holds. Agent resolution is its `resolveWorktreeCheckAgentName`, so `lane` must
 * already have the task's profile applied.
 */
export function canRecreateWorktree(
  task: Pick<Task, 'worktree_path' | 'use_worktree' | 'agent_override'>,
  lane: Pick<Swimlane, 'agent_override'> | null | undefined,
  projectDefaultAgent: string | null | undefined,
  projectPath: string,
  config: Pick<AppConfig, 'agent' | 'git'>,
): boolean {
  const agentName = task.agent_override ?? lane?.agent_override ?? projectDefaultAgent ?? DEFAULT_AGENT;
  if (config.agent.execution[agentName]?.mode === 'remote') return false;
  return worktreeSkipBeforeBase(task, projectPath, config.git.worktreesEnabled) === null;
}

/**
 * A task whose worktree directory is gone (deleted by hand, by a janitor, or by
 * a failed removal) and that nothing can make again becomes a no-worktree task
 * in the shared checkout. Only for such a task: where `canRecreateWorktree`
 * holds, a startup pass keeps every field and shows the task as not running,
 * because putting an agent in the shared checkout is not what the task asked for.
 *
 * The checkout facts die with the directory: `worktree_path`, `branch_name` (the
 * LOCAL branch a restore re-attaches to), and `resolved_base_branch` (the base
 * that checkout was cut from), and with the branch the repository's
 * `fork_point_sha`.
 *
 * The WORK does not die with it, and the PR ladder's durable anchors describe
 * the work: `pushed_branch` is a remote fact and stays untouched, and the
 * commit at the tip of the surviving local branch ref is captured into
 * `head_sha` before the name is dropped. A named ref is per task, not the
 * shared HEAD, so reading it here is sound where a HEAD read would not be.
 * Without the capture the task could never link its PR again if the resolver
 * happened to be down when the directory vanished, which is the shape that
 * stranded three tasks on 2026-09-10.
 *
 * Shared by the two startup passes (resume and auto-spawn) so the reasoning
 * lives once.
 */
export async function demoteMissingWorktree(
  taskRepo: TaskRepository,
  task: { id: string; branch_name: string | null },
  projectPath: string,
): Promise<void> {
  const capturedSha = task.branch_name ? await readLocalBranchSha(projectPath, task.branch_name) : null;
  taskRepo.update({
    id: task.id,
    worktree_path: null,
    branch_name: null,
    resolved_base_branch: null,
    ...(capturedSha ? { head_sha: capturedSha } : {}),
  });
  // The fallback is silent otherwise: record it so the board can say the
  // agent is now in the shared checkout, and why.
  taskRepo.setWorktreeSkipReason(task.id, 'worktree-missing');
}
