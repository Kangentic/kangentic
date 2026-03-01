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

    // Claude Code discovers commands and skills by walking up from cwd,
    // so the worktree copies produce duplicates in the autocomplete list.
    // Setting skip-worktree before deleting prevents git status from
    // reporting them as missing (which would block rebase/merge-back).
    await WorktreeManager.hideWorktreeDir(worktreePath, '.claude/commands');
    await WorktreeManager.hideWorktreeDir(worktreePath, '.claude/skills');

    // Copy specified files into the worktree
    const copiedClaudeFiles: string[] = [];
    for (const file of copyFiles) {
      const src = path.join(this.projectPath, file);
      const dest = path.join(worktreePath, file);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        // Track .claude/ files so we can mark them skip-worktree
        if (file.startsWith('.claude/') || file.startsWith('.claude\\')) {
          copiedClaudeFiles.push(file.replace(/\\/g, '/'));
        }
      }
    }

    // Mark copied .claude/ files as skip-worktree so hook injection
    // (e.g. settings.local.json writes) doesn't dirty the worktree index
    if (copiedClaudeFiles.length > 0) {
      const wtGit = simpleGit(worktreePath);
      try {
        await wtGit.raw(['update-index', '--skip-worktree', '--', ...copiedClaudeFiles]);
      } catch {
        // Non-fatal — worst case, files appear as modified in git status
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

  /**
   * Mark all tracked files under a relative directory as skip-worktree,
   * then delete the directory from disk.  This hides the files from
   * `git status` so they don't block rebase/merge.
   *
   * Called at worktree creation and can be re-called after rebase/merge
   * to re-clean directories that git restored.
   */
  static async hideWorktreeDir(worktreePath: string, relDir: string): Promise<void> {
    const absDir = path.join(worktreePath, relDir);
    if (!fs.existsSync(absDir)) return;

    const wtGit = simpleGit(worktreePath);
    try {
      const lsOutput = await wtGit.raw(['ls-files', relDir]);
      const trackedFiles = lsOutput.split('\n').filter(Boolean);
      if (trackedFiles.length > 0) {
        await wtGit.raw(['update-index', '--skip-worktree', '--', ...trackedFiles]);
      }
    } catch (err) {
      // skip-worktree failed — fall through to delete anyway; only
      // consequence is git status will show files as deleted.
      console.warn(`skip-worktree failed for ${relDir}`, err);
    }
    fs.rmSync(absDir, { recursive: true, force: true });
  }

  /**
   * Re-hide .claude/commands and .claude/skills in a worktree.
   * Call after rebase or merge to clean up directories that git restored.
   */
  static async rehideClaudeDirs(worktreePath: string): Promise<void> {
    await WorktreeManager.hideWorktreeDir(worktreePath, '.claude/commands');
    await WorktreeManager.hideWorktreeDir(worktreePath, '.claude/skills');
  }
}
