import { gitAt, type GitClient } from './git-client';
import { DiffService, EMPTY_TREE_HASH } from './diff-service';
import { parseCommitGraphLog } from './commit-graph';
import type {
  GitCommitGraphCommit,
  GitDiffFileEntry,
  GitDiffRange,
  GitTaskChangesEmptyReason,
  GitTaskChangesFile,
} from '../../shared/types';

/**
 * What a completed task changed, read from git alone, so it works after Done
 * removed the worktree: the objects and branch refs live in the project's
 * repository, which every worktree shares.
 *
 * The whole change is one span of history when one exists, tried in order:
 *
 * 1. The landed run. The commits the index links to the task, when they sit
 *    one after another on the base's first-parent history (a rebase merge, a
 *    squash, a fast-forward), are the range `oldest^..newest`. Tried first
 *    because these are the hashes the Summary lists: after a rebase merge the
 *    task's own branch still holds the pre-rebase commits, whose hashes match
 *    nothing the user saw.
 * 2. The linked commits on their own, when they are in the clone but not one
 *    run: no range, and the files are the union of their diffs.
 * 3. The task's branch, when it never merged: from the newest of its recorded
 *    fork point, its merge-base with the base, and its reflog creation point,
 *    to its tip. Only when the tip is not already on the base: a captured
 *    `head_sha` can be the base's own tip (a worktree that pulled the base after
 *    the merge), and a range to it would list other tasks' work.
 *
 * Otherwise nothing, with the reason.
 */

/** The most commits a task lists; past it the list is cut and says so. */
export const TASK_CHANGES_MAX_COMMITS = 300;
/**
 * With no range the files are each commit's own diff, so their number is
 * bounded. Below the list's cap, so every file's `newestCommitSha` names a
 * commit the result lists.
 */
const UNION_MAX_COMMITS = 50;
/** Commit diffs run a few at a time: each is two git children. */
const UNION_CONCURRENCY = 4;

/** `%x1f`-separated, as commit-graph.ts reads it. */
const COMMIT_FORMAT = '%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s';
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface TaskChangesResolveInput {
  /** The project's repository (never a worktree, which may be gone). */
  repoPath: string;
  /** The task's base, `resolved_base_branch ?? base_branch ?? default`. */
  baseBranch: string;
  branchName: string | null;
  headSha: string | null;
  forkPointSha: string | null;
  /** The commits the index links to the task, full hashes; null when indexing is off. */
  linkedCommitShas: readonly string[] | null;
}

export interface TaskChangesResolution {
  range: GitDiffRange | null;
  commits: GitCommitGraphCommit[];
  /** True when the task had more commits than the cap, so the list was cut. */
  truncated: boolean;
  files: GitTaskChangesFile[];
  totals: { insertions: number; deletions: number; filesChanged: number } | null;
  emptyReason: GitTaskChangesEmptyReason | null;
}

export async function resolveTaskChanges(input: TaskChangesResolveInput): Promise<TaskChangesResolution> {
  const git = gitAt(input.repoPath);
  const diffService = new DiffService(input.repoPath);
  const baseRefs = await resolveBaseRefs(git, input.baseBranch);
  const candidates = input.linkedCommitShas === null
    ? null
    : [...new Set(input.linkedCommitShas.filter((sha) => FULL_SHA.test(sha)))];
  const linked = candidates === null ? null : candidates.slice(0, TASK_CHANGES_MAX_COMMITS);
  // Only the cap cuts the list. Linked commits this clone lacks are not shown
  // either, but they are not "older ones left out", and the Summary's Commits
  // card already counts what the index linked.
  const linkedTruncated = candidates !== null && candidates.length > TASK_CHANGES_MAX_COMMITS;

  if (linked && linked.length > 0) {
    const { commits: present, oldestCommon } = await commitsInClone(git, linked);
    if (present.length > 0) {
      const run = await landedRun(git, present, oldestCommon, baseRefs);
      if (run) return withRangeFiles(diffService, input, run.range, run.commits, run.truncated || linkedTruncated);
      return withUnionFiles(diffService, input, present, linkedTruncated);
    }
  }

  const branchRange = await unmergedBranchRange(git, input, baseRefs);
  if (branchRange) return withRangeFiles(diffService, input, branchRange.range, branchRange.commits, branchRange.truncated);

  let emptyReason: GitTaskChangesEmptyReason = 'no-commits';
  if (linked === null) emptyReason = 'indexing-off';
  else if (linked.length > 0) emptyReason = 'not-in-clone';
  return { range: null, commits: [], truncated: false, files: [], totals: null, emptyReason };
}

/**
 * The base, as the refs that name it. `primary` is the one a branch is
 * measured against: `origin/<base>` (the local base may be stale), unless the
 * local base is ahead of it (a merge not pushed yet), else the local base, else
 * null. `all` is every ref that resolves: a commit on either is on the base.
 */
interface BaseRefs {
  primary: string | null;
  all: string[];
}

async function resolveBaseRefs(git: GitClient, baseBranch: string): Promise<BaseRefs> {
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const localRef = `refs/heads/${baseBranch}`;
  const [remoteSha, localSha] = await Promise.all([resolveCommit(git, remoteRef), resolveCommit(git, localRef)]);
  const all = [remoteSha ? remoteRef : null, localSha ? localRef : null].filter((ref): ref is string => ref !== null);
  const localAhead = remoteSha !== null && localSha !== null && remoteSha !== localSha && await isAncestor(git, remoteSha, localSha);
  return { primary: localAhead ? localRef : (all[0] ?? null), all };
}

async function isOnBase(git: GitClient, sha: string, baseRefs: BaseRefs): Promise<boolean> {
  for (const ref of baseRefs.all) {
    if (await isAncestor(git, sha, ref)) return true;
  }
  return false;
}

async function resolveCommit(git: GitClient, ref: string): Promise<string | null> {
  try {
    const sha = (await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
    return sha || null;
  } catch {
    return null;
  }
}

async function mergeBaseOf(git: GitClient, args: string[]): Promise<string[]> {
  try {
    return (await git.raw(['merge-base', ...args])).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function isAncestor(git: GitClient, ancestor: string, descendant: string): Promise<boolean> {
  const [base] = await mergeBaseOf(git, [ancestor, descendant]);
  return base === ancestor;
}

/**
 * The listed commits that exist here, newest first, with their metadata, in
 * one call: `--ignore-missing` drops a hash this clone does not have instead
 * of failing the whole read. Also their common ancestor (`merge-base
 * --octopus`), which the ordering reads and the landed run reuses, or null
 * when there are fewer than two or they share none.
 */
async function commitsInClone(git: GitClient, shas: readonly string[]): Promise<{ commits: GitCommitGraphCommit[]; oldestCommon: string | null }> {
  let found: GitCommitGraphCommit[];
  try {
    const output = await git.raw(['log', '--no-walk=sorted', '--ignore-missing', `--format=${COMMIT_FORMAT}`, ...shas]);
    found = parseCommitGraphLog(output);
  } catch {
    return { commits: [], oldestCommon: null };
  }
  return orderNewestFirst(git, found);
}

/**
 * Commit dates cannot order a task's commits: a rebase merge gives every one
 * of them the same committer time. Ancestry can. Everything the commits reach
 * that their common ancestor does not, in topological order, is bounded by the
 * span they cover; the common ancestor itself is the oldest when it is one of
 * them. Falls back to the date order when they share no ancestor or the walk
 * fails.
 */
async function orderNewestFirst(git: GitClient, commits: GitCommitGraphCommit[]): Promise<{ commits: GitCommitGraphCommit[]; oldestCommon: string | null }> {
  if (commits.length < 2) return { commits, oldestCommon: null };
  const shas = commits.map((commit) => commit.hash);
  const [common] = await mergeBaseOf(git, ['--octopus', ...shas]);
  if (!common) return { commits, oldestCommon: null };
  let walked: string[];
  try {
    walked = (await git.raw(['rev-list', '--topo-order', ...shas, `^${common}`])).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return { commits, oldestCommon: common };
  }
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  if (byHash.has(common)) walked.push(common);
  const ordered = walked.flatMap((sha) => byHash.get(sha) ?? []);
  return { commits: ordered.length === commits.length ? ordered : commits, oldestCommon: common };
}

/**
 * The linked commits as one run on the base's first-parent history, or null.
 * The newest is the one tip none of the others reaches (`merge-base
 * --independent`), the oldest their common ancestor (`--octopus`, read once by
 * `commitsInClone`); the run is everything between them along first parents,
 * and it must be exactly the linked set and on the base.
 */
async function landedRun(
  git: GitClient,
  present: readonly GitCommitGraphCommit[],
  oldestCommon: string | null,
  baseRefs: BaseRefs,
): Promise<{ range: GitDiffRange; commits: GitCommitGraphCommit[]; truncated: boolean } | null> {
  if (baseRefs.all.length === 0) return null;
  const shas = present.map((commit) => commit.hash);
  const tips = shas.length === 1 ? shas : await mergeBaseOf(git, ['--independent', ...shas]);
  if (tips.length !== 1) return null;
  const newest = tips[0];
  const oldest = shas.length === 1 ? shas[0] : oldestCommon;
  if (!oldest || !shas.includes(oldest)) return null;
  if (!await isOnBase(git, newest, baseRefs)) return null;

  const oldestCommit = present.find((commit) => commit.hash === oldest);
  if (!oldestCommit || oldestCommit.parents.length > 1) return null;
  const rangeBase = oldestCommit.parents[0] ?? EMPTY_TREE_HASH;
  const exclude = oldestCommit.parents[0] ? [`^${oldestCommit.parents[0]}`] : [];
  let runCommits: GitCommitGraphCommit[];
  try {
    const output = await git.raw(['log', '--first-parent', `--max-count=${TASK_CHANGES_MAX_COMMITS + 1}`, `--format=${COMMIT_FORMAT}`, newest, ...exclude]);
    runCommits = parseCommitGraphLog(output);
  } catch {
    return null;
  }
  const wanted = new Set(shas);
  if (runCommits.length !== wanted.size || runCommits.some((commit) => !wanted.has(commit.hash))) return null;
  return { range: { base: rangeBase, head: newest }, commits: runCommits, truncated: false };
}

/**
 * The task's branch as a range, when its tip is not on the base yet. The tip
 * is the branch ref when it still exists (it moves with the work), else the
 * captured `head_sha`.
 */
async function unmergedBranchRange(
  git: GitClient,
  input: TaskChangesResolveInput,
  baseRefs: BaseRefs,
): Promise<{ range: GitDiffRange; commits: GitCommitGraphCommit[]; truncated: boolean } | null> {
  const branchTip = input.branchName ? await resolveCommit(git, `refs/heads/${input.branchName}`) : null;
  const head = branchTip ?? (input.headSha && FULL_SHA.test(input.headSha) ? await resolveCommit(git, input.headSha) : null);
  if (!head || !baseRefs.primary) return null;
  if (await isOnBase(git, head, baseRefs)) return null;

  const [mergeBase] = await mergeBaseOf(git, [head, baseRefs.primary]);
  if (!mergeBase) return null;
  let start = mergeBase;
  const candidates = [
    input.forkPointSha && FULL_SHA.test(input.forkPointSha) ? input.forkPointSha : null,
    input.branchName ? await reflogCreationPoint(git, input.branchName) : null,
  ];
  // The newest start that is still on the branch's own history wins: a base
  // rewritten under the branch moves the merge-base back to whatever the two
  // still share, far behind where the task started.
  for (const candidate of candidates) {
    if (!candidate || candidate === start) continue;
    if (await isAncestor(git, candidate, head) && await isAncestor(git, start, candidate)) start = candidate;
  }
  if (start === head) return null;

  let commits: GitCommitGraphCommit[];
  try {
    const output = await git.raw(['log', '--first-parent', `--max-count=${TASK_CHANGES_MAX_COMMITS + 1}`, `--format=${COMMIT_FORMAT}`, head, `^${start}`]);
    commits = parseCommitGraphLog(output);
  } catch {
    return null;
  }
  if (commits.length === 0) return null;
  const truncated = commits.length > TASK_CHANGES_MAX_COMMITS;
  return { range: { base: start, head }, commits: commits.slice(0, TASK_CHANGES_MAX_COMMITS), truncated };
}

/** The commit the branch was created at, from its reflog's oldest entry, or null. */
async function reflogCreationPoint(git: GitClient, branchName: string): Promise<string | null> {
  try {
    const entries = (await git.raw(['reflog', 'show', '--format=%H %gs', `refs/heads/${branchName}`])).trim().split(/\r?\n/);
    const oldest = entries[entries.length - 1] ?? '';
    const match = /^([0-9a-f]{40,64}) branch: Created from /.exec(oldest);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function byChurn(left: GitDiffFileEntry, right: GitDiffFileEntry): number {
  return (right.insertions + right.deletions) - (left.insertions + left.deletions) || left.path.localeCompare(right.path);
}

async function withRangeFiles(
  diffService: DiffService,
  input: TaskChangesResolveInput,
  range: GitDiffRange,
  commits: GitCommitGraphCommit[],
  truncated: boolean,
): Promise<TaskChangesResolution> {
  const diff = await diffService.getDiffFiles({ projectPath: input.repoPath, baseBranch: input.baseBranch, range });
  return {
    range,
    commits,
    truncated,
    files: [...diff.files].sort(byChurn),
    totals: { insertions: diff.totalInsertions, deletions: diff.totalDeletions, filesChanged: diff.files.length },
    emptyReason: null,
  };
}

/**
 * No single range: each file's lines summed over the commits that touched it
 * (newest commits first, so a file keeps its newest status and commit). Each
 * commit is diffed as the range from its first parent (the empty tree for a
 * root), which `git diff <commit>` would otherwise look up with a `rev-parse`
 * child of its own.
 */
async function withUnionFiles(
  diffService: DiffService,
  input: TaskChangesResolveInput,
  commits: GitCommitGraphCommit[],
  truncated: boolean,
): Promise<TaskChangesResolution> {
  const diffed = commits.slice(0, UNION_MAX_COMMITS);
  const diffs: Array<GitDiffFileEntry[]> = new Array(diffed.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < diffed.length) {
      const index = next++;
      try {
        const commit = diffed[index];
        const range = { base: commit.parents[0] ?? EMPTY_TREE_HASH, head: commit.hash };
        diffs[index] = (await diffService.getDiffFiles({ projectPath: input.repoPath, baseBranch: input.baseBranch, range })).files;
      } catch {
        diffs[index] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UNION_CONCURRENCY, diffed.length) }, worker));

  const byPath = new Map<string, GitTaskChangesFile>();
  diffed.forEach((commit, index) => {
    for (const file of diffs[index] ?? []) {
      const existing = byPath.get(file.path);
      if (existing) {
        existing.insertions += file.insertions;
        existing.deletions += file.deletions;
      } else {
        byPath.set(file.path, { ...file, newestCommitSha: commit.hash });
      }
    }
  });
  return {
    range: null,
    commits: commits.slice(0, TASK_CHANGES_MAX_COMMITS),
    truncated,
    files: [...byPath.values()].sort(byChurn),
    totals: null,
    emptyReason: null,
  };
}
