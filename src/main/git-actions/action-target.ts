import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext } from '../ipc/ipc-context';
import type { Task } from '../../shared/types';
import { taskGitBase, type GitActionTarget } from '../../shared/git-work-state';
import { getProjectRepos, resolveProjectContext } from '../ipc/helpers/project-repos';
import { resolveProjectDefaultBaseBranch } from '../ipc/helpers/default-base-branch';
import { isTurnSettled } from '../pty/turn-settled';
import { readGitWorkDetail, type GitWorkDetail } from '../git/work-state';
import { remoteGitRunnerFor } from '../git/remote-git';
import { RefusalError } from '../../shared/refusal';

/** The checkout an action runs in, resolved by main: the renderer names a task or a terminal, never a folder. */
export interface ResolvedGitTarget {
  target: GitActionTarget;
  projectId: string;
  projectPath: string;
  directory: string;
  task: Task | null;
  /** The base the checkout's work is measured against. */
  baseBranch: string;
  /** The task's or terminal's own live agent session. */
  sessionId: string | null;
}

export function resolveGitTarget(context: IpcContext, target: GitActionTarget, projectId?: string | null): ResolvedGitTarget {
  const { projectId: resolvedProjectId, projectPath } = resolveProjectContext(context, projectId);
  if (!resolvedProjectId || !projectPath) throw new RefusalError('No project is open');
  const defaultBase = resolveProjectDefaultBaseBranch(context, projectPath);

  if (target.kind === 'terminal') {
    const session = context.sessionManager.findLiveCommandTerminalSession(resolvedProjectId, target.slot);
    return {
      target,
      projectId: resolvedProjectId,
      projectPath,
      directory: projectPath,
      task: null,
      baseBranch: defaultBase,
      sessionId: session?.id ?? null,
    };
  }

  const { tasks, swimlanes } = getProjectRepos(context, resolvedProjectId);
  const task = tasks.getById(target.taskId);
  if (!task) throw new RefusalError('Task not found');
  const laneRole = swimlanes.getById(task.swimlane_id)?.role;
  if (task.archived_at !== null || laneRole === 'done') throw new RefusalError('This task is done');
  if (laneRole === 'todo') throw new RefusalError('This task has not started');
  return {
    target,
    projectId: resolvedProjectId,
    projectPath,
    directory: task.worktree_path ?? projectPath,
    task,
    baseBranch: taskGitBase(task, defaultBase),
    sessionId: context.sessionManager.findLiveSessionByTaskId(task.id)?.id ?? null,
  };
}

/** The work state of a target's checkout. */
export function readTargetWork(resolved: ResolvedGitTarget): Promise<GitWorkDetail> {
  return readGitWorkDetail({
    worktreePath: resolved.directory,
    projectPath: resolved.projectPath,
    baseBranch: resolved.baseBranch,
    cutFromBranch: resolved.task?.resolved_base_branch ?? null,
    pushedBranch: resolved.task?.pushed_branch ?? null,
    prMerged: resolved.task?.pr_state === 'merged',
  });
}

function isSameDirectory(first: string, second: string): boolean {
  return path.relative(path.resolve(first), path.resolve(second)) === '';
}

/**
 * Refuse a checkout an action must not touch. An agent mid-turn in that folder
 * is writing files: committing then takes half of them. Any agent in the folder
 * counts, since a task with no worktree shares the project's checkout with the
 * Command Terminals and with other tasks. The folder is the one its command was
 * built for: a host session's own `cwd` is the host's path, and a UNC one's is home.
 */
export function assertTargetReady(context: IpcContext, resolved: ResolvedGitTarget, work: GitWorkDetail): void {
  if (!remoteGitRunnerFor(resolved.directory) && !fs.existsSync(resolved.directory)) {
    throw new RefusalError('The folder is gone');
  }
  if (work.branch === null) throw new RefusalError('No branch is checked out');
  const { task } = resolved;
  if (task?.worktree_path && task.branch_name && work.branch !== task.branch_name) {
    throw new RefusalError(`The worktree is on '${work.branch}', not this task's branch`);
  }
  const busy = context.sessionManager.listSessions().some((session) => {
    if (session.status !== 'running' || session.workflowId) return false;
    const folder = context.sessionManager.getSessionCommandCwd(session.id) ?? session.cwd;
    return Boolean(folder)
      && isSameDirectory(folder, resolved.directory)
      && !isTurnSettled(context.sessionManager, session.id, { acceptHeld: true });
  });
  if (busy) throw new RefusalError('The agent is working. Try again when its turn ends.');
}

/** One action per folder at a time: two would race on the same index. */
const runningDirectories = new Set<string>();

export async function withDirectoryAction<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory);
  if (runningDirectories.has(key)) throw new RefusalError('A commit or push is already running here');
  runningDirectories.add(key);
  try {
    return await run();
  } finally {
    runningDirectories.delete(key);
  }
}
