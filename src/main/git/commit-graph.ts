import simpleGit from 'simple-git';
import { readWorktreeHead } from './worktree-head';
import type { GitCommitGraphCommit, GitCommitGraphInput, GitCommitGraphResult } from '../../shared/types';

/**
 * Reads the commit history of a worktree's branch as a graph (topo-ordered
 * commits with their parent links) for the task-detail Graph pane.
 *
 * Deliberately local and cheap (no remote fetch, no `gh` lookup), like {@link
 * getBranchSummary}: it runs on every pane open and fs.watch fire, so it must
 * not pay the cost of the Done-dialog probe.
 *
 * The range shows this branch's own commits plus a little context: the positive
 * refs `HEAD` and the resolved base ref pull in the branch commits, the merge
 * base, and any commits the base advanced past the fork; `--not
 * <mergeBase>~<baseContextCount>` trims the tail to the merge base plus a few
 * base ancestors so the graph has a visible root rather than all of history.
 *
 * Fails SAFE: any git error yields an all-empty result so the pane shows an
 * empty state rather than surfacing an error.
 */

/** One record per commit; `%x1f` (unit separator) splits fields without colliding with subject text. */
const COMMIT_FORMAT = '%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s';

const DEFAULT_MAX_COMMITS = 200;
const DEFAULT_BASE_CONTEXT_COUNT = 5;

/**
 * Parse `git log --format=<COMMIT_FORMAT>` output into commit records. Extracted
 * as a pure function (mirrors `parseNameStatus` in `diff-service.ts`) so it unit
 * tests without spawning git. One commit per line; fields split on `\x1f`.
 */
export function parseCommitGraphLog(stdout: string): GitCommitGraphCommit[] {
  const commits: GitCommitGraphCommit[] = [];
  // Split on `\r?\n` so a Windows CRLF line terminator never leaves a trailing
  // `\r` on the last field (the subject). Mirrors `worktree-list.ts`.
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Subject is last: rejoin any trailing fields so a stray separator in the
    // message can never truncate it (defensive; `%s` never contains \x1f).
    const [hash, shortHash, parentsField, authorName, authorTimestamp, ...subjectParts] = line.split('\x1f');
    if (!hash) continue;
    const parentsText = (parentsField ?? '').trim();
    commits.push({
      hash,
      shortHash: shortHash ?? '',
      parents: parentsText ? parentsText.split(' ') : [],
      authorName: authorName ?? '',
      authorTimestamp: authorTimestamp ?? '',
      subject: subjectParts.join('\x1f'),
    });
  }
  return commits;
}

export async function getCommitGraph(input: GitCommitGraphInput): Promise<GitCommitGraphResult> {
  const workingDirectory = input.worktreePath ?? input.projectPath;
  const maxCommits = input.maxCommits ?? DEFAULT_MAX_COMMITS;
  const baseContextCount = input.baseContextCount ?? DEFAULT_BASE_CONTEXT_COUNT;
  const emptyResult: GitCommitGraphResult = {
    commits: [],
    tipHash: null,
    baseHash: null,
    mergeBaseHash: null,
    currentBranch: null,
    truncated: false,
  };

  try {
    const git = simpleGit(workingDirectory);
    const { branch: currentBranch, sha: tipHash } = await readWorktreeHead(workingDirectory);

    // Resolve the base ref + merge base with the established preference order:
    // origin/<base> (the local ref may be stale) then local <base>. Mirrors
    // branch-summary.ts and diff-service.ts's getMergeBase.
    let baseRef: string | null = null;
    let baseHash: string | null = null;
    let mergeBaseHash: string | null = null;
    for (const candidate of [`origin/${input.baseBranch}`, input.baseBranch]) {
      try {
        // Assign the outer refs only after BOTH calls succeed. If merge-base
        // resolves but the following rev-parse throws (e.g. a concurrent
        // `fetch --prune` removes the ref between the two calls), the candidate
        // is abandoned - it must not leave a stale mergeBaseHash behind that
        // would then feed the trim arg and be returned with a null baseRef.
        const candidateMergeBase = (await git.raw(['merge-base', candidate, 'HEAD'])).trim();
        const candidateBaseHash = (await git.raw(['rev-parse', candidate])).trim();
        mergeBaseHash = candidateMergeBase;
        baseHash = candidateBaseHash;
        baseRef = candidate;
        break;
      } catch {
        // Ref does not exist (repo uses 'master', or no remote) - try the next.
        continue;
      }
    }

    // Build the range, widest-context first, and degrade on failure:
    //   1. HEAD + baseRef, trimmed to mergeBase~<N> (full topology with context)
    //   2. drop --not (shallow clone / early history has no mergeBase~<N>)
    //   3. HEAD only (base ref unresolved, or merge base unresolvable)
    const baseArg = baseRef ? [baseRef] : [];
    const trimArg =
      mergeBaseHash && baseContextCount > 0 ? ['--not', `${mergeBaseHash}~${baseContextCount}`] : [];
    const commonArgs = ['log', '--topo-order', `--max-count=${maxCommits + 1}`, `--format=${COMMIT_FORMAT}`];
    const attempts: string[][] = [
      [...commonArgs, 'HEAD', ...baseArg, ...trimArg],
      [...commonArgs, 'HEAD', ...baseArg],
      [...commonArgs, 'HEAD'],
    ];

    let rawLog: string | null = null;
    for (const args of attempts) {
      try {
        rawLog = await git.raw(args);
        break;
      } catch {
        continue;
      }
    }
    if (rawLog === null) {
      // Even `git log HEAD` failed (unborn branch / not a repo): still report the
      // resolved branch context so the pane can say "no commits yet".
      return { ...emptyResult, tipHash, currentBranch };
    }

    const parsed = parseCommitGraphLog(rawLog);
    const truncated = parsed.length > maxCommits;
    const commits = truncated ? parsed.slice(0, maxCommits) : parsed;

    return { commits, tipHash, baseHash, mergeBaseHash, currentBranch, truncated };
  } catch {
    return emptyResult;
  }
}
