/**
 * A checkout's git work state, for the Changes button's badge and the actions
 * beside it (src/shared/git-work-state.ts).
 *
 * Local and cheap: it never fetches. `unpushedCommitCount` is commits on no
 * remote-tracking branch, not `@{upstream}..HEAD`. A task branch is cut from
 * `origin/<base>` and tracks it, and agents push under another name
 * (`git push origin HEAD:<branch>`), so the upstream count never clears after
 * a push.
 */

import { runGitWithTimeout } from './git-spawn';
import { readRemotes, type GitRemote } from './git-remotes';
import { remoteGitRunnerFor, RemoteGitUnavailableError } from './remote-git';
import { isOptionShapedRef } from './base-ref';
import { canCreatePullRequest } from '../pr/pr-registry';
import type { GitWorkState, GitWorkStateInput } from '../../shared/git-work-state';

const READ_TIMEOUT_MS = 20_000;

/** What `git status --porcelain=v2 --branch -z` says about the checkout. */
export interface PorcelainStatus {
  branch: string | null;
  /** False before the first commit. */
  hasCommit: boolean;
  /** The upstream, only when its remote-tracking ref exists. */
  upstream: string | null;
  uncommittedFileCount: number;
  stagedFileCount: number;
  conflictedFileCount: number;
}

export function parsePorcelainStatus(output: string): PorcelainStatus {
  const status: PorcelainStatus = {
    branch: null,
    hasCommit: true,
    upstream: null,
    uncommittedFileCount: 0,
    stagedFileCount: 0,
    conflictedFileCount: 0,
  };
  let namedUpstream: string | null = null;
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) {
      status.hasCommit = record !== '# branch.oid (initial)';
    } else if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length);
      status.branch = head === '(detached)' ? null : head;
    } else if (record.startsWith('# branch.upstream ')) {
      namedUpstream = record.slice('# branch.upstream '.length);
    } else if (record.startsWith('# branch.ab ')) {
      // Printed only when the upstream's ref exists.
      status.upstream = namedUpstream;
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      status.uncommittedFileCount += 1;
      if (record[2] !== '.') status.stagedFileCount += 1;
      // A rename's record is followed by its old path as a record of its own.
      if (record.startsWith('2 ')) index += 1;
    } else if (record.startsWith('u ')) {
      status.uncommittedFileCount += 1;
      status.conflictedFileCount += 1;
    } else if (record.startsWith('? ')) {
      status.uncommittedFileCount += 1;
    }
  }
  return status;
}

/** The state plus what a push needs and the renderer does not. */
export interface GitWorkDetail extends GitWorkState {
  /** The remote a push goes to, or null with none. */
  pushRemote: string | null;
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runGitWithTimeout(directory, args, { timeoutMs: READ_TIMEOUT_MS });
  return stdout;
}

/** Null when git refused (a ref that does not exist). A host that could not be asked still throws. */
async function tryGit(directory: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(directory, args);
  } catch (error) { // report-ok: a missing ref is an expected answer here, and a down host is rethrown
    if (error instanceof RemoteGitUnavailableError) throw error;
    return null;
  }
}

function parseCount(output: string | null): number {
  return output === null ? 0 : Number.parseInt(output.trim(), 10) || 0;
}

/** `origin/feature/x` as the remote that owns it and its branch, or null for a local upstream. */
function splitUpstream(upstream: string, remotes: readonly GitRemote[]): { remote: string; branch: string } | null {
  const owner = remotes
    .filter((remote) => upstream.startsWith(`${remote.name}/`))
    .sort((left, right) => right.name.length - left.name.length)[0];
  return owner ? { remote: owner.name, branch: upstream.slice(owner.name.length + 1) } : null;
}

/** Whether a base names a remote's branch: `main`, or `origin/main`. */
function namesBranch(base: string | null | undefined, remote: string, branch: string): boolean {
  return base === branch || base === `${remote}/${branch}`;
}

async function readPushTarget(
  directory: string,
  input: GitWorkStateInput,
  status: PorcelainStatus,
  remotes: readonly GitRemote[],
  onBaseBranch: boolean,
): Promise<{ remote: string | null; branch: string | null }> {
  const primary = remotes[0]?.name ?? null;
  if (!primary || status.branch === null) return { remote: primary, branch: null };
  // Both: a worktree cut from `develop` still tracks it after its task's base became `main`.
  const isBase = (remote: string, branch: string): boolean => (
    namesBranch(input.baseBranch, remote, branch) || namesBranch(input.cutFromBranch, remote, branch)
  );

  const upstream = status.upstream ? splitUpstream(status.upstream, remotes) : null;
  // A task branch tracks the base it was cut from. That is not where it was published.
  if (upstream && (onBaseBranch || !isBase(upstream.remote, upstream.branch))) {
    return { remote: upstream.remote, branch: upstream.branch };
  }

  const names = [input.pushedBranch, status.branch]
    .filter((name): name is string => Boolean(name) && !isOptionShapedRef(name as string))
    .filter((name) => onBaseBranch || !isBase(primary, name));
  if (names.length === 0) return { remote: primary, branch: null };
  const refs = await tryGit(directory, ['for-each-ref', '--format=%(refname)', ...names.map((name) => `refs/remotes/${primary}/${name}`)]);
  const existing = new Set((refs ?? '').split(/\r?\n/).filter(Boolean));
  // for-each-ref also matches everything under a name, so compare exactly.
  const published = names.find((name) => existing.has(`refs/remotes/${primary}/${name}`));
  return { remote: primary, branch: published ?? null };
}

async function countAheadOfBase(directory: string, baseBranch: string): Promise<number> {
  if (isOptionShapedRef(baseBranch)) return 0;
  for (const baseRef of [`origin/${baseBranch}`, baseBranch]) {
    const output = await tryGit(directory, ['rev-list', '--count', `${baseRef}..HEAD`]);
    if (output !== null) return parseCount(output);
  }
  return 0;
}

/**
 * Read a checkout's work state. Throws when git cannot read the folder, and
 * `RemoteGitUnavailableError` when a host could not be asked.
 */
export async function readGitWorkDetail(input: GitWorkStateInput): Promise<GitWorkDetail> {
  const directory = input.worktreePath ?? input.projectPath;
  const status = parsePorcelainStatus(await git(directory, [
    '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z',
  ]));
  const remotes = (await readRemotes(directory)) ?? [];
  const { branch } = status;
  const onBaseBranch = branch !== null
    && (branch === input.baseBranch || remotes.some((remote) => namesBranch(input.baseBranch, remote.name, branch)));
  const isRemoteProject = remoteGitRunnerFor(directory) !== null;
  const [unpushed, aheadOfBaseCount, pushTarget, creatable] = await Promise.all([
    // A merged PR's commits can be on no remote branch once its branch is deleted.
    status.hasCommit && remotes.length > 0 && !input.prMerged
      ? tryGit(directory, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
      : null,
    status.hasCommit && !onBaseBranch ? countAheadOfBase(directory, input.baseBranch) : 0,
    status.hasCommit ? readPushTarget(directory, input, status, remotes, onBaseBranch) : { remote: remotes[0]?.name ?? null, branch: null },
    // PR linking is local-only for a project on a host (docs/platforms/ssh-remote.md).
    isRemoteProject ? false : canCreatePullRequest(directory),
  ]);
  return {
    branch: status.branch,
    onBaseBranch,
    uncommittedFileCount: status.uncommittedFileCount,
    stagedFileCount: status.stagedFileCount,
    conflictedFileCount: status.conflictedFileCount,
    unpushedCommitCount: parseCount(unpushed),
    aheadOfBaseCount,
    hasRemote: remotes.length > 0,
    pushTarget: pushTarget.branch,
    pushRemote: pushTarget.remote,
    // A pull request is created on the primary remote, so a branch that pushes to another has none to offer.
    canCreatePullRequest: creatable && pushTarget.remote === (remotes[0]?.name ?? null),
  };
}

/** The renderer's read: null when git cannot read the folder, so no badge is drawn. */
export async function readGitWorkState(input: GitWorkStateInput): Promise<GitWorkState | null> {
  try {
    return await readGitWorkDetail(input);
  } catch (error) { // report-ok: a folder that is not a repository is an expected answer, and a down host is rethrown
    if (error instanceof RemoteGitUnavailableError) throw error;
    return null;
  }
}
