import simpleGit from 'simple-git';
import type { GitFileHistoryCommit, GitFileHistoryInput, GitFileHistoryResult } from '../../shared/types';

/**
 * Reads the commits that touched a single file (`git log --follow`), newest
 * first, for the Changes panel's per-file history popover.
 *
 * Deliberately local and cheap, like {@link getCommitGraph}: no remote fetch,
 * no `gh` lookup. Fails SAFE: any git error yields an empty result so the
 * popover shows an empty state rather than surfacing an error.
 */

/** One record per commit; `%x1f` (unit separator) splits fields without colliding with subject text. */
const FILE_HISTORY_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%s';

const DEFAULT_MAX_COMMITS = 100;

/**
 * Parse `git log --format=<FILE_HISTORY_FORMAT>` output into commit records.
 * Extracted as a pure function (mirrors `parseCommitGraphLog`) so it unit
 * tests without spawning git.
 */
export function parseFileHistoryLog(stdout: string): GitFileHistoryCommit[] {
  const commits: GitFileHistoryCommit[] = [];
  // Split on `\r?\n` so a Windows CRLF line terminator never leaves a trailing
  // `\r` on the last field (the subject). Mirrors `commit-graph.ts`.
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Subject is last: rejoin any trailing fields so a stray separator in the
    // message can never truncate it (defensive; `%s` never contains \x1f).
    const [hash, shortHash, authorName, authorTimestamp, ...subjectParts] = line.split('\x1f');
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: shortHash ?? '',
      authorName: authorName ?? '',
      authorTimestamp: authorTimestamp ?? '',
      subject: subjectParts.join('\x1f'),
    });
  }
  return commits;
}

export async function getFileHistory(input: GitFileHistoryInput): Promise<GitFileHistoryResult> {
  const workingDirectory = input.worktreePath ?? input.projectPath;
  const maxCommits = input.maxCommits ?? DEFAULT_MAX_COMMITS;

  try {
    const git = simpleGit(workingDirectory);
    const rawLog = await git.raw([
      'log',
      '--follow',
      `--max-count=${maxCommits}`,
      `--format=${FILE_HISTORY_FORMAT}`,
      '--',
      input.filePath,
    ]);
    return { commits: parseFileHistoryLog(rawLog) };
  } catch {
    // Untracked file, path never committed, or repo error - empty history.
    return { commits: [] };
  }
}
