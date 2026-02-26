import simpleGit, { SimpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Turn a task title into a filesystem-safe slug.
 * e.g. "Fix login bug (urgent!)" → "fix-login-bug-urgent"
 */
function slugify(text: string, maxLen = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
}

export class WorktreeManager {
  private git: SimpleGit;

  constructor(private projectPath: string) {
    this.git = simpleGit(projectPath);
  }

  /** Check whether the project path is inside a git repository. */
  static isGitRepo(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, '.git'));
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

    // Copy specified files into the worktree
    for (const file of copyFiles) {
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
    } catch {
      // Corrupted worktree (missing .git file) — remove manually and prune
      fs.rmSync(worktreePath, { recursive: true, force: true });
      await this.git.raw(['worktree', 'prune']);
    }
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
