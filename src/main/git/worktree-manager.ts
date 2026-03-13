import { execFileSync } from 'node:child_process';
import simpleGit, { SimpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs';
import { slugify } from '../../shared/slugify';

// ---------------------------------------------------------------------------
// Free functions -- lightweight checks, no simple-git dependency
// ---------------------------------------------------------------------------

/** Check whether the project path is inside a git repository. */
export function isGitRepo(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.git'));
}

/** Check whether the project path is a git worktree (has `.git` as a file, not a directory). */
export function isInsideWorktree(projectPath: string): boolean {
  const dotGit = path.join(projectPath, '.git');
  try {
    return fs.statSync(dotGit).isFile();
  } catch {
    return false;
  }
}

/**
 * Check whether the project path IS a Kangentic-managed worktree checkout.
 *
 * A preview project's path looks like `<parent>/.kangentic/worktrees/<slug>`.
 * We check that the immediate parent dir is `worktrees` and its parent is
 * `.kangentic`. This avoids false positives when the app itself runs from
 * inside a worktree (e.g. the CWD contains `.kangentic/worktrees/` early
 * in the path, but the project isn't itself a preview worktree).
 */
export function isKangenticWorktree(projectPath: string): boolean {
  // Normalize all separators to forward slashes so the check works on any OS
  const normalized = projectPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 3) return false;
  const parentSegment = segments[segments.length - 2];
  const grandparentSegment = segments[segments.length - 3];
  return parentSegment === 'worktrees' && grandparentSegment === '.kangentic';
}

/** Check whether a file is tracked by git (committed or staged). */
export function isFileTracked(projectPath: string, filePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', filePath], {
      cwd: projectPath, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WorktreeManager class
// ---------------------------------------------------------------------------

export class WorktreeManager {
  private git: SimpleGit;

  constructor(private projectPath: string, git?: SimpleGit) {
    this.git = git ?? simpleGit(projectPath);
  }

  /**
   * Guard + create worktree in one call. Returns null if any guard fails
   * (already has worktree, worktrees disabled, not a git repo, is a worktree).
   */
  async ensureWorktree(
    task: { id: string; title: string; worktree_path: string | null; base_branch?: string | null; use_worktree?: number | null },
    gitConfig: { worktreesEnabled: boolean; defaultBaseBranch: string; copyFiles: string[] },
  ): Promise<{ worktreePath: string; branchName: string } | null> {
    if (task.worktree_path) return null;
    const shouldUseWorktree = task.use_worktree != null
      ? Boolean(task.use_worktree)
      : gitConfig.worktreesEnabled;
    if (!shouldUseWorktree) return null;
    if (!isGitRepo(this.projectPath)) return null;
    if (isInsideWorktree(this.projectPath)) return null;

    const baseBranch = task.base_branch || gitConfig.defaultBaseBranch || 'main';
    return this.createWorktree(task.id, task.title, baseBranch, gitConfig.copyFiles);
  }

  /**
   * Create a worktree for a task. The worktree folder and branch are named
   * using a slug derived from the task title, with the taskId suffix to
   * guarantee uniqueness.
   */
  async createWorktree(
    taskId: string,
    taskTitle: string,
    baseBranch: string = 'main',
    copyFiles: string[] = [],
  ): Promise<{ worktreePath: string; branchName: string }> {
    const slug = slugify(taskTitle) || 'task';
    const shortId = taskId.slice(0, 8);
    const folderName = `${slug}-${shortId}`;
    const branchName = `kanban/${folderName}`;
    const worktreePath = path.join(this.projectPath, '.kangentic', 'worktrees', folderName);

    // Ensure worktrees dir exists
    const worktreesDir = path.join(this.projectPath, '.kangentic', 'worktrees');
    try {
      fs.mkdirSync(worktreesDir, { recursive: true });
    } catch (err) {
      console.error(`[WORKTREE] Failed to create worktrees directory: ${worktreesDir}`, err);
      throw new Error(`Cannot create worktrees directory at ${worktreesDir}: ${(err as Error).message}`);
    }

    // Fetch the latest from origin so worktrees start from up-to-date code
    let startPoint = baseBranch;
    try {
      await this.git.raw(['fetch', 'origin', baseBranch]);
      startPoint = `origin/${baseBranch}`;
    } catch {
      // No remote, branch not on remote, or network unavailable -- use local branch
    }

    // Create worktree with a new branch
    await this.git.raw(['worktree', 'add', '-b', branchName, worktreePath, startPoint]);

    // Store the base branch in git config so agents can read it via
    // `git config kangentic.baseBranch` without accessing files outside the worktree.
    // Custom kangentic.* keys have no side effects on any git operation.
    const wtGit = simpleGit(worktreePath);
    try {
      await wtGit.raw(['config', 'kangentic.baseBranch', baseBranch]);
    } catch {
      // Non-fatal -- merge-back falls back to 'main'
    }

    // Exclude only .claude/commands/ from worktree via sparse-checkout.
    // Commands walk up the directory tree from worktree CWD to the main repo's
    // .claude/commands/, so excluding them prevents duplicate discovery.
    // Skills and agents do NOT walk up. They are only discovered from the project
    // root's .claude/ directory. Since the worktree is its own project root (has a
    // .git file), skills and agents must be present in the worktree checkout.
    // .claude/settings.json is kept so Claude resolves permissions naturally.
    // Requires git 2.25+; older versions (some Linux distros) skip gracefully.
    try {
      await wtGit.raw(['sparse-checkout', 'init', '--no-cone']);
      await wtGit.raw(['sparse-checkout', 'set', '/*', '!/.claude/commands/']);
    } catch (sparseError) {
      console.warn('[WORKTREE] Sparse-checkout not available (requires git 2.25+), skipping:', sparseError);
    }

    // Copy specified files into the worktree (skip .claude/ entries --
    // sparse-checkout keeps .claude/ but excludes commands/,
    // and hooks are delivered via --settings flag pointing to session directory)
    for (const file of copyFiles) {
      if (file.startsWith('.claude/') || file.startsWith('.claude\\')) continue;
      const src = path.join(this.projectPath, file);
      const dest = path.join(worktreePath, file);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    return { worktreePath, branchName };
  }

  /**
   * Rename the git branch for a task after a title edit.
   * Only renames the branch ref -- the worktree directory stays unchanged.
   * Returns the new branch name on success, null if skipped or failed.
   */
  async renameBranch(
    taskId: string,
    oldBranchName: string,
    newTitle: string,
  ): Promise<string | null> {
    const slug = slugify(newTitle) || 'task';
    const shortId = taskId.slice(0, 8);
    const newBranchName = `kanban/${slug}-${shortId}`;

    if (newBranchName === oldBranchName) return null; // slug didn't change

    try {
      await this.git.raw(['branch', '-m', oldBranchName, newBranchName]);
      return newBranchName;
    } catch (err) {
      console.error('[WORKTREE] Branch rename failed:', err);
      return null;
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    if (!fs.existsSync(worktreePath)) return;
    try {
      await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
      return;
    } catch {
      // git worktree remove failed -- fall through to manual removal
    }

    // On Windows the PTY process may still hold file handles for a short time
    // after being killed. Retry rmSync with increasing delays to let handles
    // release before giving up.
    const delays = [200, 500, 1500];
    for (const delay of delays) {
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        await this.git.raw(['worktree', 'prune']);
        return;
      } catch {
        // EPERM -- retry after next delay
      }
    }

    // All retries exhausted -- prune what we can, log the stale path
    try { await this.git.raw(['worktree', 'prune']); } catch { /* best effort */ }
    console.warn(`[WorktreeManager] Could not remove worktree after retries: ${worktreePath}`);
  }

  async removeBranch(branchName: string): Promise<void> {
    try {
      await this.git.raw(['branch', '-D', branchName]);
    } catch { /* branch may not exist */ }
  }

  /**
   * List remote branches sorted by most recent commit first.
   * Fetches from origin first (fails silently if offline).
   */
  async listRemoteBranches(): Promise<string[]> {
    try { await this.git.raw(['fetch', '--prune']); } catch { /* offline OK */ }
    // %(refname:short) shortens origin/HEAD to bare "origin" -- filter by
    // requiring the origin/ prefix before stripping it, which excludes both
    // the HEAD symref and any non-origin remotes.
    const raw = await this.git.raw(['branch', '-r', '--sort=-committerdate', '--format=%(refname:short)']);
    const seen = new Set<string>();
    return raw.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('origin/') && !l.endsWith('/HEAD'))
      .map(l => l.slice('origin/'.length))
      .filter(l => {
        if (!l || seen.has(l)) return false;
        seen.add(l);
        return true;
      });
  }

  async listWorktrees(): Promise<string[]> {
    const result = await this.git.raw(['worktree', 'list', '--porcelain']);
    const worktrees: string[] = [];
    for (const line of result.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktrees.push(line.replace('worktree ', ''));
      }
    }
    return worktrees;
  }

}
