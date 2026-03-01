import simpleGit, { SimpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs';
import { slugify } from '../../shared/slugify';

export class WorktreeManager {
  private git: SimpleGit;

  constructor(private projectPath: string) {
    this.git = simpleGit(projectPath);
  }

  /** Check whether the project path is inside a git repository. */
  static isGitRepo(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, '.git'));
  }

  /** Check whether the project path is a git worktree (has `.git` as a file, not a directory). */
  static isInsideWorktree(projectPath: string): boolean {
    const dotGit = path.join(projectPath, '.git');
    try {
      return fs.statSync(dotGit).isFile();
    } catch {
      return false;
    }
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
      console.error(`Failed to create worktrees directory: ${worktreesDir}`, err);
      throw new Error(`Cannot create worktrees directory at ${worktreesDir}: ${(err as Error).message}`);
    }

    // Fetch the latest from origin so worktrees start from up-to-date code
    let startPoint = baseBranch;
    try {
      await this.git.raw(['fetch', 'origin', baseBranch]);
      startPoint = `origin/${baseBranch}`;
    } catch {
      // No remote, branch not on remote, or network unavailable — use local branch
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
      // Non-fatal — merge-back falls back to 'main'
    }

    // Exclude .claude/ from worktree via sparse-checkout.
    // Unlike skip-worktree, this survives rebase/merge/checkout —
    // no git contamination risk regardless of user's merge strategy.
    await wtGit.raw(['sparse-checkout', 'init', '--no-cone']);
    await wtGit.raw(['sparse-checkout', 'set', '/*', '!/.claude/']);

    // Copy specified files into the worktree (skip .claude/ entries —
    // sparse-checkout excludes the directory, and all settings/hooks
    // are delivered via --settings flag)
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
   * Only renames the branch ref — the worktree directory stays unchanged.
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
      console.error('Branch rename failed:', err);
      return null;
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    if (!fs.existsSync(worktreePath)) return;
    try {
      await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
      return;
    } catch {
      // git worktree remove failed — fall through to manual removal
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
        // EPERM — retry after next delay
      }
    }

    // All retries exhausted — prune what we can, log the stale path
    try { await this.git.raw(['worktree', 'prune']); } catch { /* best effort */ }
    console.warn(`[WorktreeManager] Could not remove worktree after retries: ${worktreePath}`);
  }

  async removeBranch(branchName: string): Promise<void> {
    try {
      await this.git.raw(['branch', '-D', branchName]);
    } catch { /* branch may not exist */ }
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
