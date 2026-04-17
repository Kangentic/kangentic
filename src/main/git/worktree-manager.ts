import simpleGit, { SimpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs';
import { slugify, computeSlugBudget, computeAutoBranchName } from '../../shared/slugify';
import { isGitRepo, isInsideWorktree } from './git-checks';
import { linkNodeModules, removeNodeModulesPath } from './node-modules-link';
import { fetchIfStale } from './fetch-throttle';

/** Background prune debounce per project. */
const backgroundPruneTimestamps = new Map<string, number>();
const BACKGROUND_PRUNE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Per-project serial queue for git-mutating operations
// ---------------------------------------------------------------------------

/**
 * Promise chain per project path. Each git-mutating call chains onto the
 * previous promise so operations execute in FIFO order. Different projects
 * run independently. This eliminates git lock contention that occurs when
 * multiple worktree operations hit the same .git directory concurrently.
 */
const projectQueues = new Map<string, Promise<unknown>>();

/** Normalize project path for use as a queue key (Windows is case-insensitive). */
function queueKey(projectPath: string): string {
  return process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
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
   * Serialize a git-mutating operation on this project's queue.
   * Operations on the same project execute in FIFO order; different
   * projects run independently.
   */
  withLock<T>(operation: () => Promise<T>): Promise<T> {
    return WorktreeManager.withGitLock(this.projectPath, operation);
  }

  /**
   * Serialize a git-mutating operation on the given project's queue.
   * A failed operation does not block subsequent ones.
   */
  static withGitLock<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
    const key = queueKey(projectPath);
    const previous = projectQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, () => operation());
    // Store a caught version so unhandled rejections don't leak
    projectQueues.set(key, result.catch(() => {}));
    return result;
  }

  /** Remove the queue entry for a project (e.g. on project close/delete). */
  static clearQueue(projectPath: string): void {
    projectQueues.delete(queueKey(projectPath));
  }

  /**
   * Guard + create worktree in one call. Returns null if any guard fails
   * (already has worktree, worktrees disabled, not a git repo, is a worktree).
   */
  async ensureWorktree(
    task: { id: string; title: string; worktree_path: string | null; branch_name?: string | null; base_branch?: string | null; use_worktree?: number | null },
    gitConfig: { worktreesEnabled: boolean; defaultBaseBranch: string; copyFiles: string[] },
    options?: { onProgress?: (phase: string) => void; signal?: AbortSignal },
  ): Promise<{ worktreePath: string; branchName: string } | null> {
    if (task.worktree_path) return null;
    const shouldUseWorktree = task.use_worktree != null
      ? Boolean(task.use_worktree)
      : gitConfig.worktreesEnabled;
    if (!shouldUseWorktree) return null;
    if (!isGitRepo(this.projectPath)) return null;
    if (isInsideWorktree(this.projectPath)) return null;

    const defaultBaseBranch = gitConfig.defaultBaseBranch || 'main';
    const baseBranch = task.base_branch || defaultBaseBranch;
    return this.createWorktree(task.id, task.title, baseBranch, gitConfig.copyFiles, task.branch_name, { onProgress: options?.onProgress, signal: options?.signal, defaultBaseBranch });
  }

  /**
   * Create a worktree for a task. The worktree folder and branch are named
   * using a slug derived from the task title, with the taskId suffix to
   * guarantee uniqueness.
   *
   * Callers must wrap with `withLock()` to serialize concurrent operations
   * on the same project and prevent git lock contention.
   */
  async createWorktree(
    taskId: string,
    taskTitle: string,
    baseBranch: string = 'main',
    copyFiles: string[] = [],
    customBranchName?: string | null,
    options?: { onProgress?: (phase: string) => void; signal?: AbortSignal; defaultBaseBranch?: string },
  ): Promise<{ worktreePath: string; branchName: string }> {
    const shortId = taskId.slice(0, 8);
    const defaultBaseBranch = options?.defaultBaseBranch ?? 'main';
    let branchName: string;
    let folderName: string;

    // On Windows, dynamically compute slug length to stay under MAX_PATH (260).
    // On other platforms, use the static default (20 chars).
    const slugBudget = process.platform === 'win32'
      ? computeSlugBudget(this.projectPath)
      : 20;

    if (customBranchName) {
      branchName = customBranchName;
      // Slugify the custom name for the folder (replace / with -)
      const slugifiedCustom = slugify(customBranchName.replace(/\//g, '-'), slugBudget);
      folderName = `${slugifiedCustom || 'task'}-${shortId}`;
    } else {
      const slug = slugify(taskTitle, slugBudget) || 'task';
      folderName = `${slug}-${shortId}`;
      // Branch name may include a base-branch namespace prefix when branching
      // off a non-default base; folder name intentionally stays flat.
      branchName = computeAutoBranchName(baseBranch, defaultBaseBranch, slug, shortId);
    }

    const worktreePath = path.join(this.projectPath, '.kangentic', 'worktrees', folderName);

    // Ensure worktrees dir exists
    const worktreesDir = path.join(this.projectPath, '.kangentic', 'worktrees');
    try {
      fs.mkdirSync(worktreesDir, { recursive: true });
    } catch (err) {
      console.error(`[WORKTREE] Failed to create worktrees directory: ${worktreesDir}`, err);
      throw new Error(`Cannot create worktrees directory at ${worktreesDir}: ${(err as Error).message}`);
    }

    // Fetch the latest from origin so worktrees start from up-to-date code.
    // Uses throttle cache to skip redundant fetches within a 5-minute window.
    const startPoint = await fetchIfStale(this.git, this.projectPath, baseBranch);
    options?.onProgress?.('creating-worktree');
    options?.signal?.throwIfAborted();

    // Check if the branch already exists (stale branch from failed cleanup,
    // or pre-existing custom branch)
    let branchExists = false;
    try {
      await this.git.raw(['rev-parse', '--verify', branchName]);
      branchExists = true;
    } catch {
      // Branch does not exist -- will create it
    }
    options?.signal?.throwIfAborted();

    // Create worktree: attach to existing branch or create a new one.
    // Callers must wrap with withLock() to serialize concurrent operations.
    // Use full removeWorktree (git worktree remove --force + EPERM retries)
    // instead of a single rmSync. On Windows, file handles from a recently
    // killed PTY may still be held, and rmSync fails with EPERM.
    if (fs.existsSync(worktreePath)) {
      const removed = await this.removeWorktree(worktreePath);
      if (!removed) {
        throw new Error(`Cannot create worktree: stale directory at ${worktreePath} could not be removed. A process may still hold file handles. Close any terminals or editors using this path and retry.`);
      }
      options?.signal?.throwIfAborted();
    }
    // On Windows, enable long paths to prevent "Filename too long" errors
    // when the project contains deeply nested files (e.g. .NET migrations).
    // The -c flag is per-command and does not modify the project's git config.
    // This setting is Windows-only (uses \\?\ extended-length path prefix);
    // macOS/Linux have 1024-4096 byte PATH_MAX and are unaffected.
    const longPathsConfig = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
    if (branchExists) {
      await this.git.raw([...longPathsConfig, 'worktree', 'add', worktreePath, branchName]);
      console.log(`[WORKTREE] Created worktree (existing branch): ${branchName}`);
    } else {
      await this.git.raw([...longPathsConfig, 'worktree', 'add', '-b', branchName, worktreePath, startPoint]);
      console.log(`[WORKTREE] Created worktree (new branch): ${branchName} from ${startPoint}`);
    }

    // Post-creation configuration: these steps all write to the new
    // worktree's `.git/config` (base-branch key, Windows longpaths, and
    // sparse-checkout's `extensions.worktreeConfig`). They were previously
    // wrapped in Promise.all under the assumption they touched independent
    // parts of the .git state - but on Windows concurrent writes to the same
    // config file intermittently race on the lock ("could not lock config
    // file... File exists"), silently swallowing sparse-checkout init and
    // leaving `.claude/commands/` materialized. Serial execution costs a
    // handful of milliseconds and eliminates the race.
    const wtGit = simpleGit(worktreePath);

    // Store the base branch in git config so agents can read it via
    // `git config kangentic.baseBranch` without accessing files outside the worktree.
    try {
      await wtGit.raw(['config', 'kangentic.baseBranch', baseBranch]);
    } catch {
      // Non-fatal -- merge-back falls back to 'main'
    }

    // Persist long paths in the worktree's local config (Windows only).
    if (process.platform === 'win32') {
      try {
        await wtGit.raw(['config', 'core.longpaths', 'true']);
      } catch {
        // non-fatal
      }
    }

    // Exclude .claude/commands/ from worktree via sparse-checkout.
    // Commands walk up the directory tree from worktree CWD to the main repo's
    // .claude/commands/, so excluding them prevents duplicate discovery.
    // Requires git 2.25+; older versions skip gracefully.
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

    // Link node_modules from root so worktree agents can run typecheck/test
    // without a slow npm install. Non-fatal if it fails.
    await linkNodeModules(worktreePath, this.projectPath);

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
    options?: { baseBranch?: string | null; defaultBaseBranch?: string },
  ): Promise<string | null> {
    const slugBudget = process.platform === 'win32'
      ? computeSlugBudget(this.projectPath)
      : 20;
    const slug = slugify(newTitle, slugBudget) || 'task';
    const shortId = taskId.slice(0, 8);
    const baseBranch = options?.baseBranch ?? '';
    const defaultBaseBranch = options?.defaultBaseBranch ?? 'main';
    const newBranchName = computeAutoBranchName(baseBranch, defaultBaseBranch, slug, shortId);

    if (newBranchName === oldBranchName) return null; // slug didn't change

    try {
      await this.git.raw(['branch', '-m', oldBranchName, newBranchName]);
      return newBranchName;
    } catch (err) {
      console.error('[WORKTREE] Branch rename failed:', err);
      return null;
    }
  }

  async removeWorktree(worktreePath: string): Promise<boolean> {
    if (!fs.existsSync(worktreePath)) return true;

    // Remove node_modules junction BEFORE any recursive operation to prevent
    // git worktree remove (or the async rm below) from traversing the junction
    // and deleting the main repo's node_modules. Async so a real (non-junction)
    // node_modules with many files doesn't block the main-process event loop.
    await removeNodeModulesPath(path.join(worktreePath, 'node_modules'));

    try {
      await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
      return true;
    } catch (error) {
      console.log(`[WORKTREE] git worktree remove failed, falling back to manual removal: ${(error as Error).message}`);
    }

    // Async fs.promises.rm with built-in retry budget. `maxRetries` +
    // `retryDelay` handle Windows NTFS transient locks (EBUSY, ENOTEMPTY,
    // EPERM) on .git/objects/pack/* and child processes that haven't
    // released handles yet. On macOS/Linux the retries are effectively
    // no-ops since those errors are rare. Async variant yields to the
    // event loop between attempts so the main process stays responsive
    // during bulk operations. Total ceiling: 10 * 200ms = 2s per worktree.
    try {
      await fs.promises.rm(worktreePath, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
      await this.git.raw(['worktree', 'prune']);
      return true;
    } catch (error) {
      console.warn(`[WorktreeManager] Could not remove worktree after retries: ${worktreePath} (${(error as Error).message})`);
      // Best-effort prune so git's worktree metadata is consistent even when
      // the directory itself couldn't be removed.
      try { await this.git.raw(['worktree', 'prune']); } catch { /* best effort */ }
      return false;
    }
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

  /**
   * Checkout a branch in the main repo for non-worktree tasks.
   * Throws if the working tree is dirty or the branch doesn't exist.
   */
  async checkoutBranch(branchName: string): Promise<void> {
    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch === branchName) return;

    const status = await this.git.status();
    const trackedChanges = status.files.filter(
      file => file.index !== '?' && file.working_dir !== '?',
    );
    if (trackedChanges.length > 0) {
      throw new Error(
        `Cannot switch to branch '${branchName}': you have uncommitted changes. `
        + `Commit or stash your changes, or enable worktree mode for this task.`
      );
    }

    await this.git.checkout(branchName);
  }

  async pruneWorktrees(): Promise<void> {
    await this.git.raw(['worktree', 'prune']);
  }

  /**
   * Schedule a background prune for this project. Debounced per-project
   * (at most once per 10 minutes). Acquires the git lock to avoid
   * contention with concurrent worktree operations. Never throws.
   */
  static scheduleBackgroundPrune(projectPath: string): void {
    const key = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
    const lastPrune = backgroundPruneTimestamps.get(key);
    if (lastPrune && Date.now() - lastPrune < BACKGROUND_PRUNE_COOLDOWN_MS) return;
    backgroundPruneTimestamps.set(key, Date.now());

    WorktreeManager.withGitLock(projectPath, async () => {
      const git = simpleGit(projectPath);
      await git.raw(['worktree', 'prune']);
      console.log(`[WORKTREE] Background prune completed for ${projectPath}`);
    }).catch((error) => {
      console.warn(`[WORKTREE] Background prune failed (non-fatal): ${(error as Error).message}`);
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
