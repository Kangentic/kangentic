import simpleGit from 'simple-git';
import fs from 'node:fs';
import path from 'node:path';
import type { GitDiffFilesInput, GitDiffFilesResult, GitDiffFileEntry, GitDiffScope, GitDiffStatus, GitFileContentInput, GitFileContentResult } from '../../shared/types';
import { countFileLines } from './line-count/count-lines';
import { lineCountClient } from './line-count/line-count-client';

/** Above this combined untracked-file byte size, counting is delegated to the
 *  line-count utilityProcess worker instead of running inline, so a large or
 *  numerous untracked tree (an untracked `resources/`, a generated bundle)
 *  never runs its byte-scan on the main event loop (which owns
 *  better-sqlite3, the PTYs, and IPC). Below it, counting inline is cheap
 *  enough that the worker's IPC round-trip would only add latency. */
const UNTRACKED_OFFLOAD_THRESHOLD_BYTES = 2 * 1024 * 1024;

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html',
  '.xml': 'xml', '.svg': 'xml',
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.toml': 'toml',
  '.ini': 'ini',
};

function inferLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (EXTENSION_LANGUAGE_MAP[extension]) return EXTENSION_LANGUAGE_MAP[extension];

  // Handle special filenames without extensions
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';

  return 'plaintext';
}

/**
 * Parse `git diff --name-status` output into a map of path -> status.
 * Format: `STATUS\tpath` or `R100\told-path\tnew-path` for renames.
 */
function parseNameStatus(output: string): Map<string, { status: GitDiffStatus; oldPath?: string }> {
  const result = new Map<string, { status: GitDiffStatus; oldPath?: string }>();
  // Split on `\r?\n` so a Windows CRLF terminator never leaves a trailing `\r`
  // on the parsed path (mirrors commit-graph.ts / blame.ts / file-history.ts).
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const statusCode = parts[0];
    if (statusCode.startsWith('R')) {
      // Rename: R100\told-path\tnew-path
      const oldPath = parts[1];
      const newPath = parts[2];
      if (newPath) {
        result.set(newPath, { status: 'R', oldPath });
      }
    } else if (statusCode.startsWith('C')) {
      // Copy: C100\told-path\tnew-path
      const newPath = parts[2];
      if (newPath) {
        result.set(newPath, { status: 'C' });
      }
    } else {
      const status = statusCode.charAt(0) as GitDiffStatus;
      if (['A', 'M', 'D'].includes(status)) {
        result.set(parts[1], { status });
      }
    }
  }
  return result;
}

/** The empty tree object every git repo has - used as the "parent" of a root commit. */
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class DiffService {
  private readonly gitDirectory: string;
  private mergeBaseCache: Map<string, string> = new Map();
  private parentRefCache: Map<string, string> = new Map();

  constructor(gitDirectory: string) {
    this.gitDirectory = gitDirectory;
  }

  /**
   * Resolve `<oid>^` (the commit's first parent) for a single-commit diff. A
   * root commit has no parent, so `<oid>^` fails to resolve - fall back to the
   * empty tree, which makes every file in the root commit appear as added.
   * Only a SUCCESSFUL resolution is cached (commit history is immutable); the
   * empty-tree fallback is deliberately not cached, so a transient rev-parse
   * failure (a momentary git error rather than a genuine root commit) is
   * retried on the next fetch instead of permanently poisoning this commit's
   * diff to "every file added against the empty tree".
   */
  private async resolveParentRef(git: ReturnType<typeof simpleGit>, commitOid: string): Promise<string> {
    const cached = this.parentRefCache.get(commitOid);
    if (cached) return cached;
    try {
      const result = await git.raw(['rev-parse', '--verify', `${commitOid}^`]);
      const parentRef = result.trim();
      this.parentRefCache.set(commitOid, parentRef);
      return parentRef;
    } catch {
      return EMPTY_TREE_HASH;
    }
  }

  /**
   * Find the merge-base between the base branch and HEAD.
   * This is the fork point - where the task branch diverged from the base.
   * Diffing against this (instead of the base branch tip) shows only changes
   * made on this branch, excluding changes merged into the base after forking.
   * Result is cached per base branch to avoid redundant git subprocess calls
   * (getDiffFiles and getFileContent both need the merge-base).
   */
  private async getMergeBase(git: ReturnType<typeof simpleGit>, baseBranch: string): Promise<string> {
    const cached = this.mergeBaseCache.get(baseBranch);
    if (cached) return cached;

    // Try origin ref first - local branch may be stale if repo hasn't pulled recently.
    // Fall back to local ref (works for repos without a remote, or non-standard remote names).
    for (const ref of [`origin/${baseBranch}`, baseBranch]) {
      try {
        const result = await git.raw(['merge-base', ref, 'HEAD']);
        const mergeBase = result.trim();
        this.mergeBaseCache.set(baseBranch, mergeBase);
        return mergeBase;
      } catch {
        continue;
      }
    }

    // Neither ref exists (e.g. repo uses 'master' not 'main') - fall back to HEAD
    // so the panel still shows uncommitted working tree changes.
    this.mergeBaseCache.set(baseBranch, 'HEAD');
    return 'HEAD';
  }

  /**
   * Resolve the `git diff` arguments + untracked policy for a scope.
   * - `working`: working tree vs index (`git diff`); include untracked new files.
   * - `staged`: index vs HEAD (`git diff --cached`); exclude untracked (not staged).
   * - `branch`: working tree vs the merge-base of base..HEAD; include untracked.
   *   When on the base branch itself the merge-base resolves to HEAD, so this
   *   shows only uncommitted working-tree changes.
   */
  private async resolveScopeDiffArgs(
    git: ReturnType<typeof simpleGit>,
    scope: GitDiffScope,
    baseBranch: string,
  ): Promise<{ summaryArgs: string[]; nameStatusArgs: string[]; includeUntracked: boolean }> {
    if (scope === 'working') {
      return { summaryArgs: [], nameStatusArgs: ['--name-status'], includeUntracked: true };
    }
    if (scope === 'staged') {
      return { summaryArgs: ['--cached'], nameStatusArgs: ['--cached', '--name-status'], includeUntracked: false };
    }
    const mergeBase = await this.getMergeBase(git, baseBranch);
    return { summaryArgs: [mergeBase], nameStatusArgs: ['--name-status', mergeBase], includeUntracked: true };
  }

  /**
   * Resolve the `git diff` arguments for a single-commit diff (`<oid>^..<oid>`),
   * the history browser's commit-detail selection. Commit history is immutable,
   * so there is no untracked-files concept here.
   */
  private async resolveCommitDiffArgs(
    git: ReturnType<typeof simpleGit>,
    commitOid: string,
  ): Promise<{ summaryArgs: string[]; nameStatusArgs: string[]; includeUntracked: boolean }> {
    const parentRef = await this.resolveParentRef(git, commitOid);
    return {
      summaryArgs: [parentRef, commitOid],
      nameStatusArgs: ['--name-status', parentRef, commitOid],
      includeUntracked: false,
    };
  }

  async getDiffFiles(input: GitDiffFilesInput): Promise<GitDiffFilesResult> {
    const git = simpleGit(this.gitDirectory);
    const { baseBranch, commitOid } = input;
    const scope = input.scope ?? 'branch';

    const { summaryArgs, nameStatusArgs, includeUntracked } = commitOid
      ? await this.resolveCommitDiffArgs(git, commitOid)
      : await this.resolveScopeDiffArgs(git, scope, baseBranch);

    // Run git commands in parallel for faster initial load.
    // git.status() fetches untracked files that git diff ignores - only needed
    // for the working/branch scopes (staged excludes untracked by definition).
    const [summary, nameStatusOutput, gitStatus] = await Promise.all([
      git.diffSummary(summaryArgs),
      git.diff(nameStatusArgs),
      includeUntracked ? git.status() : Promise.resolve(null),
    ]);
    const statusMap = parseNameStatus(nameStatusOutput);

    const files: GitDiffFileEntry[] = summary.files.map((file) => {
      const filePath = file.file;
      const statusInfo = statusMap.get(filePath);
      const isBinary = file.binary;

      // Determine status: prefer --name-status, fall back to heuristic
      let status: GitDiffStatus = 'M';
      let oldPath: string | undefined;
      if (statusInfo) {
        status = statusInfo.status;
        oldPath = statusInfo.oldPath;
      } else if (!isBinary) {
        if (file.insertions > 0 && file.deletions === 0) status = 'A';
        else if (file.insertions === 0 && file.deletions > 0) status = 'D';
      }

      return {
        path: filePath,
        status,
        insertions: isBinary ? 0 : file.insertions,
        deletions: isBinary ? 0 : file.deletions,
        oldPath,
        binary: isBinary,
      };
    });

    // Merge untracked (new) files from git status. git diff only covers
    // tracked files, so newly created files need to come from status.not_added.
    // Skipped for the staged scope (gitStatus is null there - untracked files
    // are not in the index).
    const trackedPaths = new Set(files.map((file) => file.path));
    const untrackedPaths = gitStatus
      ? gitStatus.not_added.filter((filePath) => !trackedPaths.has(filePath))
      : [];

    const untrackedEntries = await this.countUntrackedEntries(untrackedPaths);

    files.push(...untrackedEntries);
    const untrackedInsertions = untrackedEntries.reduce((sum, entry) => sum + entry.insertions, 0);

    return {
      files,
      totalInsertions: summary.insertions + untrackedInsertions,
      totalDeletions: summary.deletions,
    };
  }

  /**
   * Counts inserted lines (and detects binary content) for every untracked
   * path relative to `gitDirectory`. Small untracked sets are counted inline
   * (cheap enough that a worker round-trip would only add latency); once the
   * aggregate size crosses UNTRACKED_OFFLOAD_THRESHOLD_BYTES, the batch is
   * delegated to the line-count worker so the scan never runs on the main
   * event loop. Falls back to inline counting if the worker is unavailable.
   */
  private async countUntrackedEntries(untrackedPaths: string[]): Promise<GitDiffFileEntry[]> {
    if (untrackedPaths.length === 0) return [];

    const absolutePaths = untrackedPaths.map((filePath) => path.join(this.gitDirectory, filePath));
    const sizes = await Promise.all(
      absolutePaths.map(async (absolutePath) => {
        try {
          const stats = await fs.promises.stat(absolutePath);
          return stats.size;
        } catch {
          return 0;
        }
      }),
    );
    const aggregateBytes = sizes.reduce((sum, size) => sum + size, 0);

    if (aggregateBytes > UNTRACKED_OFFLOAD_THRESHOLD_BYTES) {
      const workerEntries = await lineCountClient.countFiles(absolutePaths);
      if (workerEntries) {
        return workerEntries.map((entry, index) => ({
          path: untrackedPaths[index],
          status: 'U' as const,
          insertions: entry.insertions,
          deletions: 0,
          binary: entry.binary,
        }));
      }
      // Worker unavailable (not spawned, crashed, timed out) - fall through
      // to inline counting so the diff still resolves.
    }

    return Promise.all(
      untrackedPaths.map(async (filePath, index): Promise<GitDiffFileEntry> => {
        try {
          const result = await countFileLines(absolutePaths[index]);
          return { path: filePath, status: 'U', insertions: result.insertions, deletions: 0, binary: result.binary };
        } catch {
          // File may have been deleted between status and read
          return { path: filePath, status: 'U', insertions: 0, deletions: 0, binary: false };
        }
      }),
    );
  }

  /**
   * Branch churn vs base (merge-base), including uncommitted + untracked
   * changes - the same scope the Changes panel shows. Reuses getMergeBase +
   * getDiffFiles so churn capture (git-stats-capture.ts) and the diff panel
   * share one merge-base implementation instead of two diverging copies.
   */
  async getChurnSummary(baseBranch: string): Promise<{ linesAdded: number; linesRemoved: number; filesChanged: number }> {
    const result = await this.getDiffFiles({ baseBranch, scope: 'branch', projectPath: this.gitDirectory });
    return {
      linesAdded: result.totalInsertions,
      linesRemoved: result.totalDeletions,
      filesChanged: result.files.length,
    };
  }

  async getFileContent(input: GitFileContentInput): Promise<GitFileContentResult> {
    const git = simpleGit(this.gitDirectory);
    const { baseBranch, filePath, status, oldPath, commitOid } = input;
    const scope = input.scope ?? 'branch';
    const language = inferLanguage(filePath);

    const needsOriginal = status !== 'A' && status !== 'U';
    const needsModified = status !== 'D';
    const showPath = oldPath ?? filePath;

    // Resolve the "original" (left) side per scope. The revision is joined with
    // `:path`: '' yields ":path" (the staged/index blob), 'HEAD' yields
    // "HEAD:path", and the merge-base yields "<base>:path". A commit selection
    // overrides scope entirely: original is that commit's parent tree.
    //   commit  -> <oid>^ (or the empty tree for a root commit)
    //   working -> index   (vs working tree on disk)
    //   staged  -> HEAD    (vs the index blob)
    //   branch  -> base    (vs working tree on disk)
    const resolveOriginalRevision = async (): Promise<string> => {
      if (commitOid) return this.resolveParentRef(git, commitOid);
      if (scope === 'working') return '';
      if (scope === 'staged') return 'HEAD';
      return this.getMergeBase(git, baseBranch);
    };
    // The "modified" (right) side reads from disk for working/branch, from the
    // staged index blob for the staged scope, and from the commit tree itself
    // (never disk) for a commit selection - history is immutable.
    const modifiedFromIndex = !commitOid && scope === 'staged';

    // Fetch original and modified in parallel - independent I/O whose overlap
    // cuts latency for modified files (the common case) by ~30-50%.
    const [original, modified] = await Promise.all([
      needsOriginal
        ? (async () => {
            try {
              const revision = await resolveOriginalRevision();
              return await git.show([`${revision}:${showPath}`]);
            } catch {
              return '';
            }
          })()
        : '',
      needsModified
        ? (async () => {
            try {
              if (commitOid) {
                return await git.show([`${commitOid}:${filePath}`]);
              }
              if (modifiedFromIndex) {
                return await git.show([`:${filePath}`]);
              }
              const workingDirectory = input.worktreePath ?? input.projectPath;
              const absolutePath = path.join(workingDirectory, filePath);
              return await fs.promises.readFile(absolutePath, 'utf-8');
            } catch {
              return '';
            }
          })()
        : '',
    ]);

    return { original, modified, language };
  }
}
