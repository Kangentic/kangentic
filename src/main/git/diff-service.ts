import simpleGit from 'simple-git';
import fs from 'node:fs';
import path from 'node:path';
import type { GitDiffFilesInput, GitDiffFilesResult, GitDiffFileEntry, GitDiffStatus, GitFileContentInput, GitFileContentResult } from '../../shared/types';

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html',
  '.xml': 'xml', '.svg': 'xml',
  '.md': 'markdown', '.mdx': 'markdown',
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
  for (const line of output.split('\n')) {
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

export class DiffService {
  private readonly gitDirectory: string;
  private mergeBaseCache: Map<string, string> = new Map();

  constructor(gitDirectory: string) {
    this.gitDirectory = gitDirectory;
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

    try {
      const result = await git.raw(['merge-base', baseBranch, 'HEAD']);
      const ref = result.trim();
      this.mergeBaseCache.set(baseBranch, ref);
      return ref;
    } catch {
      // Base branch doesn't exist (e.g. repo uses 'master' not 'main') - fall back to HEAD
      // so the panel still shows uncommitted working tree changes.
      this.mergeBaseCache.set(baseBranch, 'HEAD');
      return 'HEAD';
    }
  }

  async getDiffFiles(input: GitDiffFilesInput): Promise<GitDiffFilesResult> {
    const git = simpleGit(this.gitDirectory);
    const { baseBranch } = input;

    // Always diff working tree against the merge-base (fork point).
    // This shows changes made on this branch including uncommitted edits.
    // When on the base branch itself (e.g. main), merge-base resolves to HEAD,
    // so only uncommitted working tree changes are shown.
    const diffRef = await this.getMergeBase(git, baseBranch);

    // Run both git commands in parallel for faster initial load
    const [summary, nameStatusOutput] = await Promise.all([
      git.diffSummary([diffRef]),
      git.diff(['--name-status', diffRef]),
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

    return {
      files,
      totalInsertions: summary.insertions,
      totalDeletions: summary.deletions,
    };
  }

  async getFileContent(input: GitFileContentInput): Promise<GitFileContentResult> {
    const git = simpleGit(this.gitDirectory);
    const { baseBranch, filePath, status, oldPath } = input;
    const language = inferLanguage(filePath);

    let original = '';
    let modified = '';

    // Fetch original content from the merge-base (fork point), not the base branch tip.
    // This ensures we show the file as it was when the branch was created.
    if (status !== 'A') {
      try {
        const showPath = oldPath ?? filePath;
        const mergeBase = await this.getMergeBase(git, baseBranch);
        original = await git.show([`${mergeBase}:${showPath}`]);
      } catch {
        // File doesn't exist at the fork point
        original = '';
      }
    }

    // Fetch modified content from working tree (includes uncommitted changes)
    if (status !== 'D') {
      const workingDir = input.worktreePath ?? input.projectPath;
      const absolutePath = path.join(workingDir, filePath);
      try {
        modified = await fs.promises.readFile(absolutePath, 'utf-8');
      } catch {
        // File might have been deleted after diff was computed
        modified = '';
      }
    }

    return { original, modified, language };
  }
}
