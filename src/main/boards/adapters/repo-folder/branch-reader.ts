import { gitAt, type GitClient } from '../../../git/git-client';
import { GitCommandError } from '../../../git/git-command-error';
import { RefusalError } from '../../../../shared/refusal';
import type { SourceProject } from '../../shared';
import { buildFolderTree, type FolderNode } from './folder-tree';

/** The commit a Repository folder source reads, and its files as a tree. */
export interface BranchRead {
  /** The full hash of the commit read. */
  commit: string;
  /** That commit's committer date, ISO 8601. */
  committedAt: string;
  tree: FolderNode;
}

/**
 * The commit `ref` names, or null when the repository has no such ref. The git
 * client resolves a failed command whose stderr is empty, which is exactly what
 * `rev-parse --verify --quiet` does for a missing ref, so an empty answer is the
 * missing case. A repository git cannot read at all still throws.
 */
async function resolveCommit(git: GitClient, ref: string): Promise<string | null> {
  const answer = (await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  return answer || null;
}

async function committerSeconds(git: GitClient, commit: string): Promise<number> {
  const answer = (await git.raw(['show', '-s', '--format=%ct', commit])).trim();
  const seconds = Number.parseInt(answer, 10);
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * The newer of local `<base>` and `origin/<base>`, with no fetch: the
 * descendant when one is an ancestor of the other, else the later committer
 * date. `merge-base` stands in for `merge-base --is-ancestor`, whose answer is
 * only its exit code, which the git client does not report. A repository with
 * neither ref is refused, never read as empty.
 */
export async function resolveBaseCommit(git: GitClient, baseBranch: string): Promise<string> {
  const [localCommit, originCommit] = await Promise.all([
    resolveCommit(git, `refs/heads/${baseBranch}`),
    resolveCommit(git, `refs/remotes/origin/${baseBranch}`),
  ]);
  if (localCommit && originCommit) {
    if (localCommit === originCommit) return localCommit;
    const mergeBase = (await git.raw(['merge-base', localCommit, originCommit])).trim();
    if (mergeBase === localCommit) return originCommit;
    if (mergeBase === originCommit) return localCommit;
    const [localSeconds, originSeconds] = await Promise.all([
      committerSeconds(git, localCommit),
      committerSeconds(git, originCommit),
    ]);
    return originSeconds > localSeconds ? originCommit : localCommit;
  }
  const onlyCommit = localCommit ?? originCommit;
  if (!onlyCommit) throw new RefusalError(`No branch ${baseBranch} in this repository.`);
  return onlyCommit;
}

/**
 * Read the base branch's files through git, never the working tree, so a
 * branch checked out in the project folder does not change what imports. Every
 * call goes through `gitAt`, so a remote project's git runs on its host.
 */
export async function readBranch(project: SourceProject): Promise<BranchRead> {
  const git = gitAt(project.path);
  let commit: string;
  try {
    commit = await resolveBaseCommit(git, project.baseBranch);
  } catch (error) {
    // A project folder that is no repository is the user's setup, not a defect: say so.
    if (error instanceof GitCommandError && error.gitCause === 'not_a_repository') {
      // refusal-wrap-ok: classified first: only git's own "not a repository" is wrapped.
      throw new RefusalError('This project is not a git repository.', { cause: error });
    }
    throw error;
  }
  const [listing, committedAt] = await Promise.all([
    // --full-tree: paths are repo-relative even when the project is a subfolder.
    git.raw(['ls-tree', '--full-tree', '-r', '-z', '--name-only', commit]),
    git.raw(['show', '-s', '--format=%cI', commit]),
  ]);
  return { commit, committedAt: committedAt.trim(), tree: buildFolderTree(listing.split('\0')) };
}

/**
 * The committer date of the last commit at or before `commit` that touched
 * `itemPath`. The path goes in as a literal pathspec: after `--` git still reads
 * `[`, `*`, `?` and a leading `:` as pattern syntax, so `[draft].md` would match
 * another file's history or none.
 */
export async function lastChangeOf(project: SourceProject, commit: string, itemPath: string): Promise<string | null> {
  const answer = (await gitAt(project.path).raw(['log', '-1', '--format=%cI', commit, '--', `:(literal)${itemPath}`])).trim();
  return answer || null;
}
