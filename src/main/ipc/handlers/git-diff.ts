import { ipcMain } from 'electron';
import simpleGit from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { DiffService } from '../../git/diff-service';
import { readWorktreeHead } from '../../git/worktree-head';
import { getBranchSummary } from '../../git/branch-summary';
import { getCommitGraph } from '../../git/commit-graph';
import { fetchAllRemotesIfStale } from '../../git/fetch-throttle';
import { countLocalOnlyCommits } from '../../git/local-only-commits';
import type { GitBranchSummaryInput, GitCommitGraphInput, GitDiffFilesInput, GitFileContentInput, GitPendingChangesInput, GitPendingChangesResult, PRState } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * Policy inputs that shape what the Done move would actually destroy. `autoCleanup`
 * decides whether the move force-deletes the branch (only then are only-local
 * commits at risk); `prNumber` / `prState` let the count detect a squash-merge.
 */
export interface ProbeOptions {
  autoCleanup?: boolean;
  prNumber?: number | null;
  prState?: PRState | null;
}

/**
 * Probe a worktree (or project) directory for work that the Done move would
 * destroy: uncommitted files (lost when the worktree is removed) and commits
 * that exist on no remote. Also reports the live HEAD branch so the dialog can
 * name the branch the work actually lives on rather than a stale stored slug.
 *
 * The commit count is gated on the repo having at least one remote: with no
 * remotes, `rev-list --not --remotes` matches nothing and would count the
 * entire history, scaring the user with a number that is not at-risk work.
 * When a remote exists we first refresh remote-tracking refs
 * (fetchAllRemotesIfStale) so the count reflects current remote state rather
 * than stale local refs, which previously made already-pushed commits look
 * local-only.
 *
 * The count reports only commits the move would actually destroy:
 * `countLocalOnlyCommits` excludes anything recoverable (pushed, merged by
 * content, or in a merged PR), and the result counts only when `autoCleanup`
 * will force-delete the branch - with the branch kept, even unmerged commits
 * survive on its ref and are not at risk.
 *
 * On any git failure it returns a safe default (`hasPendingChanges: true`) so
 * a corrupted or missing worktree still routes through the confirm dialog.
 */
export async function probePendingChanges(checkPath: string, opts?: ProbeOptions): Promise<GitPendingChangesResult> {
  // Default to true (conservative): a caller that omits it is treated as if the
  // branch will be deleted, so only-local commits are surfaced rather than hidden.
  const autoCleanup = opts?.autoCleanup ?? true;
  try {
    const git = simpleGit(checkPath);
    const status = await git.status();

    const uncommittedFileCount = status.files.length;
    const { branch: currentBranch } = await readWorktreeHead(checkPath);

    let unpushedCommitCount = 0;
    const remotes = await git.getRemotes();
    // The count matters only when the move force-deletes the branch (autoCleanup):
    // only then are only-local commits genuinely at risk. With the branch kept
    // they stay reachable on its ref and the worktree is recreatable, so the count
    // is 0 and the (potentially expensive: a remote fetch, git cherry, and a `gh`
    // PR lookup) work below is skipped entirely rather than computed and discarded.
    // The count is also gated on having a remote: with none, `rev-list --not
    // --remotes` matches nothing and would count all of history.
    if (remotes.length > 0 && autoCleanup) {
      // Refresh remote-tracking refs first: stale local refs make rev-list
      // report already-pushed commits as local-only. Never rejects; on failure
      // the count falls back to existing (possibly stale) refs, the pre-fix
      // behavior. Kept outside the inner try so a hypothetical throw lands in
      // the outer catch (safe default) rather than yielding a false 0 count.
      await fetchAllRemotesIfStale(checkPath);
      try {
        unpushedCommitCount = await countLocalOnlyCommits(checkPath, { prNumber: opts?.prNumber, prState: opts?.prState });
      } catch {
        // Detached HEAD or unborn branch - treat as 0.
      }
    }

    const hasPendingChanges = uncommittedFileCount > 0 || unpushedCommitCount > 0;
    return { hasPendingChanges, uncommittedFileCount, unpushedCommitCount, currentBranch };
  } catch {
    // If git fails (missing directory, corrupted repo, etc.), assume changes exist as safe default
    return { hasPendingChanges: true, uncommittedFileCount: 0, unpushedCommitCount: 0, currentBranch: null };
  }
}

export function registerGitDiffHandlers(context: IpcContext): void {
  // DiffWatcher lives on the context (not module-local) so project relocation
  // can release the worktree fs.watch handles inside a folder before moving it.
  const watcher = context.diffWatcher;

  // Cache DiffService instances per directory so the merge-base cache persists
  // across getDiffFiles and getFileContent calls, avoiding redundant git
  // merge-base subprocess spawns on every file click. These hold no file
  // handles (git is spawned per call), so stale post-relocation entries keyed
  // by the old path are harmless and left in place.
  const serviceCache = new Map<string, DiffService>();

  function getOrCreateService(gitDirectory: string): DiffService {
    const existing = serviceCache.get(gitDirectory);
    if (existing) return existing;
    const service = new DiffService(gitDirectory);
    serviceCache.set(gitDirectory, service);
    return service;
  }

  ipcMain.handle(IPC.GIT_DIFF_FILES, async (_, input: GitDiffFilesInput) => {
    const service = getOrCreateService(input.worktreePath ?? input.projectPath);
    return service.getDiffFiles(input);
  });

  ipcMain.handle(IPC.GIT_FILE_CONTENT, async (_, input: GitFileContentInput) => {
    const service = getOrCreateService(input.worktreePath ?? input.projectPath);
    return service.getFileContent(input);
  });

  ipcMain.on(IPC.GIT_DIFF_SUBSCRIBE, (_, worktreePath: string) => {
    watcher.subscribe(worktreePath, () => {
      if (!context.mainWindow.isDestroyed()) {
        context.mainWindow.webContents.send(IPC.GIT_DIFF_CHANGED);
      }
    });
  });

  ipcMain.handle(IPC.GIT_CHECK_PENDING_CHANGES, (_, input: GitPendingChangesInput): Promise<GitPendingChangesResult> => {
    return probePendingChanges(input.checkPath, {
      autoCleanup: input.autoCleanup,
      prNumber: input.prNumber,
      prState: input.prState,
    });
  });

  ipcMain.handle(IPC.GIT_BRANCH_SUMMARY, (_, input: GitBranchSummaryInput) => {
    return getBranchSummary(input);
  });

  ipcMain.handle(IPC.GIT_COMMIT_GRAPH, (_, input: GitCommitGraphInput) => {
    return getCommitGraph(input);
  });

  ipcMain.on(IPC.GIT_DIFF_UNSUBSCRIBE, (_, worktreePath: string) => {
    watcher.unsubscribe(worktreePath);
    serviceCache.delete(worktreePath);
  });
}
