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
    const worktreePath = path.join(this.projectPath, '.worktrees', folderName);

    // Ensure .worktrees dir exists
    fs.mkdirSync(path.join(this.projectPath, '.worktrees'), { recursive: true });

    // Create worktree with a new branch
    await this.git.raw(['worktree', 'add', '-b', branchName, worktreePath, baseBranch]);

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

  async removeWorktree(worktreePath: string): Promise<void> {
    if (fs.existsSync(worktreePath)) {
      await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
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
