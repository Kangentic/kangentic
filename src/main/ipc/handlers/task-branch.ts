import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { simpleGit } from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import {
  getProjectRepos,
  ensureTaskWorktree,
} from '../helpers';
import { resolveProjectContext } from '../helpers/project-repos';
// Directly from the submodule for the same reason as resolveProjectContext:
// it is a pure context reader, and handler tests that vi.mock the helpers
// barrel should keep exercising the real resolution.
import { resolveEffectiveBaseBranch, findLiveSessionInDirectory } from '../helpers/task-git';
import { withTaskLock } from '../task-lifecycle-lock';
import { WorktreeManager } from '../../git/worktree-manager';
import { fetchIfStale, type FetchFailureReason } from '../../git/fetch-throttle';
import { refResolvesLocally } from '../../git/base-branch';
import type { IpcContext } from '../ipc-context';
import type { Task, TaskSwitchBranchInput, TaskUpdateFromBaseInput, TaskUpdateFromBaseResult } from '../../../shared/types';

export interface CarryResult {
  carriedTracked: boolean;
  carriedUntracked: string[];
  failedUntracked: string[];
  applyFailed: boolean;
}

/**
 * Carry uncommitted changes (tracked + untracked) from a project directory
 * to a newly-created worktree. Best-effort: never throws.
 */
export async function carryUncommittedChanges(
  projectPath: string,
  worktreePath: string,
  taskIdSlug: string,
): Promise<CarryResult> {
  const result: CarryResult = {
    carriedTracked: false,
    carriedUntracked: [],
    failedUntracked: [],
    applyFailed: false,
  };

  try {
    const mainGit = simpleGit(projectPath);
    const status = await mainGit.status();

    if (status.files.length === 0 && status.not_added.length === 0) {
      return result;
    }

    // Carry tracked changes (staged + unstaged) via diff/apply
    const diff = await mainGit.diff(['HEAD']);
    if (diff) {
      const worktreeGit = simpleGit(worktreePath);
      const patchFile = path.join(os.tmpdir(), `kangentic-patch-${taskIdSlug}.patch`);
      try {
        fs.writeFileSync(patchFile, diff);
        await worktreeGit.raw('apply', '--3way', patchFile);
        result.carriedTracked = true;
      } catch {
        result.applyFailed = true;
      } finally {
        try { fs.unlinkSync(patchFile); } catch { /* ignore cleanup failure */ }
      }
    }

    // Carry untracked files (git diff HEAD ignores these)
    const untrackedFiles = status.not_added;
    for (const filePath of untrackedFiles) {
      const source = path.join(projectPath, filePath);
      const destination = path.join(worktreePath, filePath);
      // Guard against path traversal (e.g. ../../../etc/passwd)
      const resolvedDestination = path.resolve(destination);
      if (!resolvedDestination.startsWith(path.resolve(worktreePath))) {
        result.failedUntracked.push(filePath);
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
        fs.copyFileSync(source, resolvedDestination);
        result.carriedUntracked.push(filePath);
      } catch {
        result.failedUntracked.push(filePath);
      }
    }
  } catch (error) {
    console.error('[carryUncommittedChanges] Unexpected error:', error);
  }

  return result;
}

/**
 * Refuse a branch mutation while the task's own recorded session is live. One
 * definition for both handlers below, so a future change to what counts as
 * "active" cannot land in only one of them. This is the row-keyed HALF of the
 * protection; TASK_UPDATE_FROM_BASE additionally runs a cwd-keyed occupancy
 * check right before its merge, because sessions no task row points at (a
 * run_script action's `<id>-script` session, a recovery spawn whose
 * `session_id` write has not landed yet) are invisible to this predicate.
 */
function assertNoActiveTaskSession(context: IpcContext, task: Task, action: string): void {
  if (!task.session_id) return;
  const activeSession = context.sessionManager.listSessions()
    .find(session => session.id === task.session_id && (session.status === 'running' || session.status === 'queued'));
  if (activeSession) {
    throw new Error(`Cannot ${action} while a session is running. Suspend the session first.`);
  }
}

export function registerTaskBranchHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.TASK_SWITCH_BRANCH, async (_, input: TaskSwitchBranchInput, projectId?: string | null) => {
    const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, projectId);
    if (!resolvedProjectId) throw new Error('No project is currently open');

    const { tasks } = getProjectRepos(context, resolvedProjectId);
    const task = tasks.getById(input.taskId);
    if (!task) throw new Error(`Task ${input.taskId} not found`);

    // Guard: must not have a running PTY session
    assertNoActiveTaskSession(context, task, 'switch branch');

    const db = getProjectDb(resolvedProjectId);
    const sessionRepo = new SessionRepository(db);

    if (input.enableWorktree && !task.worktree_path) {
      // --- Path B: Enable worktree ---
      if (!resolvedProjectPath) throw new Error('No project path available');

      // Update base branch and use_worktree before creating the worktree
      tasks.update({
        id: task.id,
        base_branch: input.newBaseBranch || null,
        use_worktree: 1,
      });
      Object.assign(task, tasks.getById(task.id));

      // Create the worktree. The explicit projectId matters: a task-detail
      // window can belong to a background project, and without it a failed
      // base fetch's spawn warning would stamp the ambient (wrong) project.
      await ensureTaskWorktree(context, task, tasks, resolvedProjectPath, { projectId: resolvedProjectId });
      const updatedTask = tasks.getById(task.id);
      if (!updatedTask?.worktree_path) {
        throw new Error('Failed to create worktree');
      }

      // Best-effort: carry uncommitted changes from main repo to worktree
      try {
        const carryResult = await carryUncommittedChanges(
          resolvedProjectPath, updatedTask.worktree_path, task.id.slice(0, 8),
        );
        if (carryResult.carriedTracked || carryResult.carriedUntracked.length > 0) {
          console.log(`[TASK_SWITCH_BRANCH] Carried uncommitted changes to worktree (tracked: ${carryResult.carriedTracked}, untracked: ${carryResult.carriedUntracked.length})`);
        }
        if (carryResult.applyFailed) {
          console.warn(`[TASK_SWITCH_BRANCH] Could not apply tracked changes to worktree. They remain in the main repo.`);
        }
        if (carryResult.failedUntracked.length > 0) {
          console.warn(`[TASK_SWITCH_BRANCH] Could not copy ${carryResult.failedUntracked.length} untracked file(s) to worktree.`);
        }
      } catch {
        // Best-effort, non-fatal
      }

      // Update session record CWD for seamless resume
      const latestRecord = sessionRepo.getLatestForTask(task.id);
      if (latestRecord && latestRecord.status === 'suspended') {
        sessionRepo.updateCwd(latestRecord.id, updatedTask.worktree_path);
        console.log(`[TASK_SWITCH_BRANCH] Updated session ${latestRecord.id.slice(0, 8)} CWD to worktree`);
      }

      // Update git config in the new worktree (best-effort)
      if (input.newBaseBranch) {
        try {
          const worktreeGit = simpleGit(updatedTask.worktree_path);
          await worktreeGit.addConfig('kangentic.baseBranch', input.newBaseBranch);
        } catch {
          // Non-fatal
        }
      }

      return tasks.getById(task.id)!;
    }

    if (task.worktree_path) {
      // --- Path A: Switch base branch (worktree exists) ---
      if (!fs.existsSync(task.worktree_path)) {
        throw new Error(`Worktree directory not found: ${task.worktree_path}`);
      }

      tasks.update({ id: task.id, base_branch: input.newBaseBranch || null });

      // Update git config in the worktree (best-effort)
      try {
        const worktreeGit = simpleGit(task.worktree_path);
        await worktreeGit.addConfig('kangentic.baseBranch', input.newBaseBranch);
      } catch {
        console.warn(`[TASK_SWITCH_BRANCH] Could not update git config in worktree`);
      }

      return tasks.getById(task.id)!;
    }

    // --- Path C: No worktree, no enableWorktree ---
    tasks.update({ id: task.id, base_branch: input.newBaseBranch || null });
    return tasks.getById(task.id)!;
  });

  ipcMain.handle(IPC.TASK_UPDATE_FROM_BASE, async (_, input: TaskUpdateFromBaseInput, projectId?: string | null): Promise<TaskUpdateFromBaseResult> => {
    const { projectId: resolvedProjectId, projectPath: resolvedProjectPath } = resolveProjectContext(context, projectId);
    if (!resolvedProjectId || !resolvedProjectPath) throw new Error('No project is currently open');
    const projectPath = resolvedProjectPath;

    // withTaskLock so a concurrent move cannot spawn an agent into the tree
    // mid-merge (spawn paths take the same task lock first, then the git
    // queue - the same ordering as here, so no inversion).
    return withTaskLock(input.taskId, async (): Promise<TaskUpdateFromBaseResult> => {
      const { tasks } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getById(input.taskId);
      if (!task) throw new Error(`Task ${input.taskId} not found`);

      // A running or queued PTY session owns the tree, and fast-forwarding
      // files under a live agent is exactly the "silently move an agent's
      // tree" this action must not do.
      assertNoActiveTaskSession(context, task, 'update from base');

      // v1 scope: worktree tasks only. A non-worktree task gets its base
      // fast-forwarded at spawn time (ensureTaskBranchCheckout); updating the
      // SHARED checkout on demand would additionally need an "is the main
      // checkout currently on this task's branch" guard.
      if (!task.worktree_path || !fs.existsSync(task.worktree_path)) {
        throw new Error('This task has no worktree to update.');
      }
      const worktreePath = task.worktree_path;

      const baseBranch = resolveEffectiveBaseBranch(context, task, projectPath);
      return WorktreeManager.withGitLock(projectPath, async (): Promise<TaskUpdateFromBaseResult> => {
        // A ref object rather than a plain let: closure assignments never
        // widen a let's control-flow narrowing, while property narrowing
        // resets at the await.
        const fetchFailure: { current: { reason: FetchFailureReason; message: string } | null } = { current: null };
        const fetched = await fetchIfStale(simpleGit(projectPath), projectPath, baseBranch, {
          onOutcome: (outcome) => {
            if (outcome.kind === 'failed') fetchFailure.current = { reason: outcome.reason, message: outcome.message };
          },
        });
        if (fetchFailure.current?.reason === 'no-remote') {
          return { status: 'no-remote', baseBranch };
        }
        const baseRef = `origin/${baseBranch}`;
        // Same re-verify as createWorktree: fetchIfStale's return is not proof
        // the tracking ref landed (throttle hits skip the fetch entirely).
        const verified = fetched === baseRef && await refResolvesLocally(projectPath, baseRef);
        if (!verified) {
          return {
            status: 'fetch-failed',
            baseBranch,
            reason: fetchFailure.current?.message ?? `'${baseRef}' did not resolve after fetch`,
          };
        }

        const worktreeGit = simpleGit(worktreePath);
        // The merge below moves whatever ref the worktree has checked out.
        // Nothing stops a user (or an agent) from checking out another branch
        // or detaching HEAD inside the tree, and a success toast claiming the
        // task's branch advanced when some other ref did would be a lie -
        // verify identity first, like checkoutBranch's own postcondition.
        if (task.branch_name) {
          const headBranch = (await worktreeGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
          if (headBranch !== task.branch_name) {
            throw new Error(`The worktree is checked out to '${headBranch}', not the task's branch '${task.branch_name}'. Check the task's branch out first.`);
          }
        }
        const status = await worktreeGit.status();
        const trackedChanges = status.files.filter(
          (file) => file.index !== '?' && file.working_dir !== '?',
        );
        if (trackedChanges.length > 0) return { status: 'dirty-tree', baseBranch };

        const revListOutput = (await worktreeGit.raw(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`])).trim();
        const [behindRaw, aheadRaw] = revListOutput.split(/\s+/);
        const behind = Number.parseInt(behindRaw, 10) || 0;
        const ahead = Number.parseInt(aheadRaw, 10) || 0;
        if (behind === 0) return { status: 'already-up-to-date', baseBranch };

        // Cwd-keyed occupancy check, immediately before the mutation (no
        // await between them): the session_id guard above misses sessions no
        // task row points at - a run_script action's `<id>-script` session in
        // this worktree, or a startup-recovery spawn that has a live PTY here
        // but has not written `task.session_id` yet.
        const occupant = findLiveSessionInDirectory(context, worktreePath);
        if (occupant) {
          throw new Error('Cannot update from base while an agent is running in this worktree. Stop it first.');
        }

        try {
          await worktreeGit.raw(['merge', '--ff-only', baseRef]);
          return { status: 'updated', baseBranch, commitCount: behind };
        } catch (mergeError) {
          const mergeMessage = mergeError instanceof Error ? mergeError.message : String(mergeError);
          // An untracked file colliding with an incoming one refuses the merge
          // with "would be overwritten". The dirty-tree check above deliberately
          // ignores untracked files, so without this the failure reports as
          // cannot-ff with ahead 0 - "this branch has its own commits" when it
          // has none. It IS an uncommitted-changes problem, so report it as one.
          if (/would be overwritten/i.test(mergeMessage)) {
            return { status: 'dirty-tree', baseBranch };
          }
          return { status: 'cannot-ff', baseBranch, ahead, behind };
        }
      }, { label: `update-from-base:${input.taskId.slice(0, 8)}` });
    });
  });
}
