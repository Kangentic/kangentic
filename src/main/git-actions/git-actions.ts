/**
 * Commit, push and create a pull request for a task's checkout or a Command
 * Terminal's. Kangentic runs git itself. A step an agent can fix goes to the
 * agent by itself (failure-delivery.ts); one it cannot is returned for a toast.
 *
 * No project git lock and no task lock across a step: a hook can run for
 * minutes, and both locks would hold every worktree and every move meanwhile.
 * Git's own index lock and `withDirectoryAction` cover the folder. A task row is
 * written under its task lock, briefly, after.
 */

import type { IpcContext } from '../ipc/ipc-context';
import type {
  GitActionResult,
  GitCommitInput,
  GitCreatePullRequestInput,
  GitWorkState,
} from '../../shared/git-work-state';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { withTaskLock } from '../ipc/task-lifecycle-lock';
import { remoteGitRunnerFor, RemoteGitUnavailableError } from '../git/remote-git';
import { isOptionShapedRef } from '../git/base-ref';
import type { GitWorkDetail } from '../git/work-state';
import {
  createPullRequest as createPullRequestOnHost,
  PRCreateError,
  PRResolverTransientError,
  PRResolverUnavailableError,
  resolvePRForBranch,
} from '../pr/pr-registry';
import { linkPR } from '../pr/pr-linking';
import { RefusalError } from '../../shared/refusal';
import { assertTargetReady, readTargetWork, withDirectoryAction, type ResolvedGitTarget } from './action-target';
import { commitChanges, pushCommits, pushDestination, type StepOutcome } from './commit-and-push';
import { deliverGitFailure, gitActionsReporter, type AskedGitAction } from './failure-delivery';
import { FAILURE_OUTPUT_MAX_CHARS } from './failure';

const DONE: GitActionResult = { outcome: 'done' };

/** The checkout's state, or the refusal a checkout that cannot be read becomes. */
async function readReadyWork(context: IpcContext, resolved: ResolvedGitTarget): Promise<GitWorkDetail> {
  let work: GitWorkDetail;
  try {
    work = await readTargetWork(resolved);
  } catch (error) { // report-ok: an unreadable checkout is an expected state, shown to the user
    throw new RefusalError(error instanceof RemoteGitUnavailableError ? error.message : 'Git could not read this checkout');
  }
  assertTargetReady(context, resolved, work);
  return work;
}

function pushLabel(work: GitWorkDetail): string | null {
  const destination = pushDestination(work);
  return destination ? `${destination.remote}/${destination.branch}` : null;
}

/**
 * Remember where the task's work was pushed when that is not its own branch, as
 * an agent's push is (`recordPushedBranchForSession`). A push Kangentic makes
 * raises no `branch-pushed`.
 */
async function recordPush(context: IpcContext, resolved: ResolvedGitTarget, work: GitWorkDetail): Promise<void> {
  const destination = pushDestination(work);
  const taskId = resolved.task?.id;
  if (!destination || !taskId) return;
  const { tasks, swimlanes } = getProjectRepos(context, resolved.projectId);
  await withTaskLock(taskId, async () => {
    const fresh = tasks.getById(taskId);
    if (!fresh || swimlanes.getById(fresh.swimlane_id)?.role === 'todo') return;
    if (destination.branch === fresh.branch_name || destination.branch === fresh.pushed_branch) return;
    if (destination.branch === resolved.baseBranch || destination.branch === fresh.resolved_base_branch) return;
    tasks.update({ id: taskId, pushed_branch: destination.branch });
  });
}

async function push(context: IpcContext, resolved: ResolvedGitTarget, work: GitWorkDetail): Promise<StepOutcome> {
  const failure = await pushCommits(resolved.directory, work);
  if (!failure) await recordPush(context, resolved, work);
  return failure;
}

export function commitTarget(context: IpcContext, resolved: ResolvedGitTarget, input: GitCommitInput): Promise<GitActionResult> {
  const message = input.message.trim();
  if (!message) throw new RefusalError('The commit needs a message');
  return withDirectoryAction(resolved.directory, async () => {
    const work = await readReadyWork(context, resolved);
    if (work.conflictedFileCount > 0) throw new RefusalError('Resolve the conflicts first');
    const asked: AskedGitAction = {
      step: 'commit',
      message,
      stagedOnly: work.stagedFileCount > 0,
      pushAfter: input.pushAfter,
      pushTo: pushLabel(work),
    };
    const commitFailure = await commitChanges(resolved.directory, work, message);
    if (commitFailure) return deliverGitFailure(context, resolved, asked, commitFailure);
    if (!input.pushAfter) return DONE;
    const pushFailure = await push(context, resolved, work);
    return pushFailure ? deliverGitFailure(context, resolved, asked, pushFailure) : DONE;
  });
}

export function pushTarget(context: IpcContext, resolved: ResolvedGitTarget): Promise<GitActionResult> {
  return withDirectoryAction(resolved.directory, async () => {
    const work = await readReadyWork(context, resolved);
    const failure = await push(context, resolved, work);
    return failure
      ? deliverGitFailure(context, resolved, { step: 'push', pushTo: pushLabel(work) }, failure)
      : DONE;
  });
}

/** The open pull request of a branch, or null. A host that cannot say reads as none: the create then says why. */
async function openPullRequestOf(directory: string, head: string, baseBranch: string): Promise<{ number: number; url: string } | null> {
  try {
    const found = await resolvePRForBranch(directory, head, baseBranch);
    if (!found || (found.state !== 'open' && found.state !== 'draft')) return null;
    return { number: found.number, url: found.url };
  } catch (error) { // report-ok: an unavailable resolver is an expected answer, and the create reports it to the user
    if (error instanceof PRResolverUnavailableError || error instanceof PRResolverTransientError) return null;
    throw error;
  }
}

/** Point the task at its new pull request, then have the linker read its state. */
async function linkCreated(context: IpcContext, resolved: ResolvedGitTarget, pullRequest: { number: number; url: string }): Promise<void> {
  const taskId = resolved.task?.id;
  if (!taskId) return;
  const { tasks } = getProjectRepos(context, resolved.projectId);
  await withTaskLock(taskId, async () => {
    if (!tasks.getById(taskId)) return;
    tasks.update({ id: taskId, pr_url: pullRequest.url, pr_number: pullRequest.number, pr_state: null, pr_merge_readiness: null });
  });
  // Outside the lock: linkPR takes it. The link is already written, so a miss only delays the chip.
  void linkPR(context, { projectId: resolved.projectId, taskId, force: true, preserveLinkOnNotFound: true })
    .catch((error: unknown) => gitActionsReporter.report(error, { tags: { stage: 'link_created_pr' } }));
}

export function createPullRequestForTarget(
  context: IpcContext,
  resolved: ResolvedGitTarget,
  input: GitCreatePullRequestInput,
): Promise<GitActionResult> {
  const title = input.title.trim();
  if (!title) throw new RefusalError('The pull request needs a title');
  if (!input.baseBranch || isOptionShapedRef(input.baseBranch)) throw new RefusalError('Choose a branch to merge into');
  if (remoteGitRunnerFor(resolved.directory)) throw new RefusalError('Not available for a project on a host yet');
  const request: GitCreatePullRequestInput = { ...input, title };
  return withDirectoryAction(resolved.directory, async () => {
    const work = await readReadyWork(context, resolved);
    const destination = pushDestination(work);
    if (!destination) throw new RefusalError('This repository has no remote');
    const head = destination.branch;
    if (head === input.baseBranch) throw new RefusalError('The branch is the one it would merge into');
    if (!work.canCreatePullRequest) throw new RefusalError('No pull request can be created on the remote this branch pushes to');
    const asked: AskedGitAction = { step: 'create-pull-request', pullRequest: request, head };

    if (needsPush(work)) {
      const pushFailure = await push(context, resolved, work);
      if (pushFailure) return deliverGitFailure(context, resolved, asked, pushFailure);
    }

    let pullRequest = await openPullRequestOf(resolved.directory, head, input.baseBranch);
    if (!pullRequest) {
      try {
        pullRequest = await createPullRequestOnHost(resolved.directory, {
          head,
          base: input.baseBranch,
          title,
          body: request.body,
          draft: request.draft,
        });
      } catch (error) { // report-ok: the platform's refusals go to the agent or the user, and anything else is rethrown
        // A create that timed out may still have landed.
        pullRequest = await openPullRequestOf(resolved.directory, head, input.baseBranch);
        if (!pullRequest) {
          if (error instanceof PRCreateError) {
            return deliverGitFailure(context, resolved, asked, {
              for: 'agent',
              step: 'create-pull-request',
              output: error.output.slice(-FAILURE_OUTPUT_MAX_CHARS),
            });
          }
          if (error instanceof PRResolverUnavailableError || error instanceof PRResolverTransientError) {
            return { outcome: 'failed', step: 'create-pull-request', message: error.message.split('\n')[0] };
          }
          throw error;
        }
      }
    }
    await linkCreated(context, resolved, pullRequest);
    return { outcome: 'done', pullRequest };
  });
}

function needsPush(work: Pick<GitWorkState, 'unpushedCommitCount' | 'pushTarget'>): boolean {
  return work.unpushedCommitCount > 0 || work.pushTarget === null;
}
