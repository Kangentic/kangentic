import { ipcMain } from 'electron';
import simpleGit from 'simple-git';
import { IPC } from '../../../shared/ipc-channels';
import { DiffService } from '../../git/diff-service';
import { DiffSubscriptionRegistry } from '../../git/diff-subscription-registry';
import { readWorktreeHead, readWorktreeHeadUnqueued } from '../../git/worktree-head';
import { getBranchSummary } from '../../git/branch-summary';
import { getCommitGraph } from '../../git/commit-graph';
import { getFileHistory } from '../../git/file-history';
import { getBlame } from '../../git/blame';
import { fetchAllRemotesIfStale } from '../../git/fetch-throttle';
import { countLocalOnlyCommits } from '../../git/local-only-commits';
import type { GitBlameInput, GitBranchSummaryInput, GitCommitGraphInput, GitDiffFilesInput, GitFileContentInput, GitFileHistoryInput, GitPendingChangesInput, GitPendingChangesResult, GitWorktreeHeadInput, GitWorktreeHeadResult, PRState } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import { broadcast } from '../../pop-out/window-broadcast';

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
  // Dev-only step timing. The probe gates a Done drop's completion (the card has
  // landed, the archive waits on this), and it measured 640 to 1150ms on the
  // dogfooding instance in the 2026-09-16 drag audit; this line says which step.
  const stepStartedAt = __KANGENTIC_DEV__ ? performance.now() : 0;
  const stepTimings: string[] = [];
  const noteStep = (label: string): void => {
    if (!__KANGENTIC_DEV__) return;
    stepTimings.push(`${label} ${Math.round(performance.now() - stepStartedAt)}ms`);
  };
  try {
    const git = simpleGit(checkPath);
    const status = await git.status();
    noteStep('status');

    const uncommittedFileCount = status.files.length;
    const { branch: currentBranch } = await readWorktreeHead(checkPath);
    noteStep('head');

    let unpushedCommitCount = 0;
    const remotes = await git.getRemotes();
    noteStep('remotes');
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
      noteStep('fetch');
      try {
        unpushedCommitCount = await countLocalOnlyCommits(checkPath, { prNumber: opts?.prNumber, prState: opts?.prState });
      } catch {
        // Detached HEAD or unborn branch - treat as 0.
      }
      noteStep('local-only');
    }

    const hasPendingChanges = uncommittedFileCount > 0 || unpushedCommitCount > 0;
    if (__KANGENTIC_DEV__) {
      console.debug(`[probe] checkPendingChanges cumulative: ${stepTimings.join(', ')}`);
    }
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

  // Per-sender refcounting so N windows watching one path (the in-app Changes
  // panel, the detached Changes window, per-file diff windows) each hold their
  // own subscription: one window unsubscribing (or being destroyed) never tears
  // down the others' live updates, and only the path's LAST subscriber leaving
  // closes the fs.watch handles and drops the merge-base cache.
  const subscriptionRegistry = new DiffSubscriptionRegistry(
    (worktreePath) =>
      watcher.subscribe(worktreePath, () => {
        // broadcast() already guards a destroyed main window internally, matching the
        // CONFIG_SET site's guard-free call.
        broadcast(context.mainWindow, IPC.GIT_DIFF_CHANGED);
      }),
    (worktreePath) => serviceCache.delete(worktreePath),
  );
  const trackedSenderIds = new Set<number>();

  ipcMain.on(IPC.GIT_DIFF_SUBSCRIBE, (event, worktreePath: string) => {
    const senderId = event.sender.id;
    if (!trackedSenderIds.has(senderId)) {
      trackedSenderIds.add(senderId);
      // A destroyed renderer (closed pop-out window, crash) never sends its
      // unsubscribes; release everything it still holds.
      event.sender.once('destroyed', () => {
        trackedSenderIds.delete(senderId);
        subscriptionRegistry.releaseSender(senderId);
      });
      // A reload / navigation also never sends unsubscribes (the page is torn
      // down without React cleanup) while the webContents - and its sender id -
      // survive, so the old page's refs would stack forever and keep the
      // fs.watch armed. Release them when the next main-frame navigation
      // commits; the new page's own subscribes only arrive after the commit,
      // so they are never swept.
      event.sender.on('did-navigate', () => {
        subscriptionRegistry.releaseSender(senderId);
      });
    }
    subscriptionRegistry.subscribe(senderId, worktreePath);
  });

  ipcMain.handle(IPC.GIT_CHECK_PENDING_CHANGES, (_, input: GitPendingChangesInput): Promise<GitPendingChangesResult> => {
    return probePendingChanges(input.checkPath, {
      autoCleanup: input.autoCleanup,
      prNumber: input.prNumber,
      prState: input.prState,
    });
  });

  // Warms the same throttle cache the probe above reads, so a probe that follows
  // within the 30s window either skips the fetch outright or joins the one already
  // in flight and pays only its remainder. Non-interactive because a drag is not a
  // moment for a credential prompt; a failure leaves the cache unset and the probe
  // fetches for itself as before. Measured in the 2026-09-16 drag audit: the probe
  // ran 640 to 1150ms on the dogfooding instance and the fetch was its dominant
  // step, while the FlyingCard flight it gates is 500ms.
  //
  // Gated on the SAME per-project setting the background scheduler reads
  // (`git.autoFetchIntervalMinutes`, null or <= 0 meaning off). A drag is a user
  // gesture, but it is not a request to reach the network, and a card dragged
  // between two working columns never goes near the Done probe at all. A user who
  // turned background fetching off therefore sees no new fetches; their Done drop
  // still fetches inside the probe exactly as it does today, so the setting costs
  // them the speed-up and nothing else.
  ipcMain.handle(IPC.GIT_PREFETCH_REMOTES, async (_, checkPath: unknown): Promise<void> => {
    if (typeof checkPath !== 'string' || checkPath.length === 0) return;
    const intervalMinutes = context.configManager
      .getEffectiveConfig(context.currentProjectPath ?? undefined)
      .git.autoFetchIntervalMinutes;
    if (intervalMinutes === null || intervalMinutes <= 0) return;
    await fetchAllRemotesIfStale(checkPath, { nonInteractive: true });
  });

  ipcMain.handle(IPC.GIT_BRANCH_SUMMARY, async (_, input: GitBranchSummaryInput) => {
    // The fetch lives HERE, not in getBranchSummary, so that function keeps
    // its local-and-cheap contract for the fs.watch-driven refires.
    if (input.refreshRemote) {
      await fetchAllRemotesIfStale(input.worktreePath ?? input.projectPath);
    }
    return getBranchSummary(input);
  });

  // The Command Terminal's branch pill re-derives from this on reattach and on
  // every watcher fire. Unqueued for the same reason as the branch summary: an
  // interactive refresh must not wait behind the global read cap. Never fetches.
  ipcMain.handle(IPC.GIT_WORKTREE_HEAD, (_, input: GitWorktreeHeadInput): Promise<GitWorktreeHeadResult> => {
    return readWorktreeHeadUnqueued(input.path);
  });

  ipcMain.handle(IPC.GIT_COMMIT_GRAPH, (_, input: GitCommitGraphInput) => {
    return getCommitGraph(input);
  });

  ipcMain.handle(IPC.GIT_FILE_HISTORY, (_, input: GitFileHistoryInput) => {
    return getFileHistory(input);
  });

  ipcMain.handle(IPC.GIT_BLAME, (_, input: GitBlameInput) => {
    return getBlame(input);
  });

  ipcMain.on(IPC.GIT_DIFF_UNSUBSCRIBE, (event, worktreePath: string) => {
    subscriptionRegistry.unsubscribe(event.sender.id, worktreePath);
  });
}
