import { remoteGitRunnerFor } from '../git/remote-git';
import { withTempTextFile } from '../shared/temp-text-file';
import type { GitWorkDetail } from '../git/work-state';
import { classifyGitRun, FAILURE_OUTPUT_MAX_CHARS, type GitActionFailure } from './failure';
import { outputTail, runGitCaptured, type CapturedGitRun } from './run-git-captured';

/** The outcome of one git step: the step's failure, or null when it worked. */
export type StepOutcome = GitActionFailure | null;

function failureOf(step: GitActionFailure['step'], run: CapturedGitRun): GitActionFailure {
  return classifyGitRun(step, run, outputTail(run, FAILURE_OUTPUT_MAX_CHARS));
}

/**
 * Undo `git add -A` after a commit that failed. Nothing was staged before it
 * (that is when it runs), so unstaging everything restores the index exactly.
 * Left staged, the next Commit would take these versions and miss what the agent
 * changed to fix the hook. `restore --staged`, not `reset`, which would also drop
 * a merge in progress. Before the first commit there is no HEAD to restore from, and
 * only then is `rm --cached` the same undo: with a HEAD it stages the deletion of
 * every file, which the next Commit would take.
 */
async function unstageAll(directory: string, hasHead: boolean): Promise<void> {
  await runGitCaptured(directory, hasHead
    ? ['restore', '--staged', '--', ':/']
    : ['rm', '-r', '--cached', '-q', '--', '.']);
}

/** Commit what is staged, or every change when nothing is. Never skips hooks. */
export async function commitChanges(directory: string, work: GitWorkDetail, message: string): Promise<StepOutcome> {
  const stageAll = work.stagedFileCount === 0;
  let hasHead = true;
  if (stageAll) {
    // Only git's own "no such revision" (exit 1) means there is no commit yet.
    hasHead = (await runGitCaptured(directory, ['rev-parse', '--verify', '--quiet', 'HEAD'])).exitCode !== 1;
    const added = await runGitCaptured(directory, ['add', '-A', '--', ':/']);
    if (added.exitCode !== 0) return failureOf('commit', added);
  }
  // A host has no file of this computer's, so its message is an argument there.
  const committed = remoteGitRunnerFor(directory)
    ? await runGitCaptured(directory, ['commit', '-m', message])
    : await withTempTextFile(message, (filePath) => runGitCaptured(directory, ['commit', '-F', filePath]));
  if (committed.exitCode === 0) return null;
  if (stageAll) await unstageAll(directory, hasHead);
  return failureOf('commit', committed);
}

/** The branch a push goes to, and whether it is the branch's first. */
export function pushDestination(work: GitWorkDetail): { remote: string; branch: string; publish: boolean } | null {
  if (work.branch === null || work.pushRemote === null) return null;
  return { remote: work.pushRemote, branch: work.pushTarget ?? work.branch, publish: work.pushTarget === null };
}

/**
 * Push HEAD to its branch on the remote, named in full so `push.default` cannot
 * change where it lands. Never forces. `-u` only on the first push, when the
 * branch is its own.
 */
export async function pushCommits(directory: string, work: GitWorkDetail): Promise<StepOutcome> {
  const destination = pushDestination(work);
  if (!destination) return { for: 'user', step: 'push', message: 'This repository has no remote' };
  const pushed = await runGitCaptured(directory, [
    'push',
    ...(destination.publish ? ['-u'] : []),
    destination.remote,
    `HEAD:refs/heads/${destination.branch}`,
  ]);
  return pushed.exitCode === 0 ? null : failureOf('push', pushed);
}
