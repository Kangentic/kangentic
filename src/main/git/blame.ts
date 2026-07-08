import simpleGit from 'simple-git';
import type { GitBlameInput, GitBlameLine, GitBlameResult } from '../../shared/types';

/**
 * Reads per-line blame for a file (`git blame --line-porcelain`), for the
 * Changes panel's DiffViewer blame gutter.
 *
 * Deliberately local and cheap, like {@link getCommitGraph}. Fails SAFE: any
 * git error (untracked file, binary, deleted, repo error) yields an empty
 * result so the gutter simply shows no annotations.
 */

/** SHA git uses for a line that has not been committed yet. */
const UNCOMMITTED_SHA_PATTERN = /^0+$/;

/** Matches a `--line-porcelain` block's header: `<40-char-sha> <origLine> <finalLine>[ <groupSize>]`. */
const BLAME_HEADER_PATTERN = /^([0-9a-f]{40}) \d+ (\d+)/;

/**
 * Parse `git blame --line-porcelain` output into per-line records. Extracted
 * as a pure function (mirrors `parseCommitGraphLog`) so it unit tests without
 * spawning git.
 *
 * With `--line-porcelain`, the full commit metadata block repeats for every
 * line (not just the first line of a same-commit run): a header line, then
 * `author ` / `author-time ` / ... meta lines, terminated by the tab-prefixed
 * source-line content.
 */
export function parseBlamePorcelain(stdout: string): GitBlameLine[] {
  const result: GitBlameLine[] = [];
  const rawLines = stdout.split(/\r?\n/);
  let index = 0;

  while (index < rawLines.length) {
    const headerMatch = rawLines[index].match(BLAME_HEADER_PATTERN);
    if (!headerMatch) {
      index++;
      continue;
    }
    const [, hash, finalLineText] = headerMatch;
    index++;

    let author = '';
    let authorTimeSeconds: number | null = null;
    while (index < rawLines.length && !rawLines[index].startsWith('\t')) {
      const metaLine = rawLines[index];
      if (metaLine.startsWith('author ')) {
        author = metaLine.slice('author '.length);
      } else if (metaLine.startsWith('author-time ')) {
        const parsed = Number(metaLine.slice('author-time '.length));
        authorTimeSeconds = Number.isFinite(parsed) ? parsed : null;
      }
      index++;
    }
    if (index < rawLines.length && rawLines[index].startsWith('\t')) {
      index++; // consume the source-line content line
    }

    const isUncommitted = UNCOMMITTED_SHA_PATTERN.test(hash);
    result.push({
      line: Number(finalLineText),
      hash,
      shortHash: isUncommitted ? '0000000' : hash.slice(0, 7),
      author: isUncommitted ? 'Uncommitted' : author,
      date: !isUncommitted && authorTimeSeconds !== null
        ? new Date(authorTimeSeconds * 1000).toISOString()
        : '',
    });
  }

  return result;
}

export async function getBlame(input: GitBlameInput): Promise<GitBlameResult> {
  const workingDirectory = input.worktreePath ?? input.projectPath;

  try {
    const git = simpleGit(workingDirectory);
    const rawBlame = await git.raw(['blame', '--line-porcelain', '--', input.filePath]);
    return { lines: parseBlamePorcelain(rawBlame) };
  } catch {
    return { lines: [] };
  }
}
