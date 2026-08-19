import simpleGit, { SimpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs';
import { slugify, computeAutoBranchName } from '../../shared/slugify';
import { worktreeFolderFromPath } from '../../shared/worktree-folder';
import { describeWorktreePathLengthCause } from '../../shared/windows-path-budget';
import { worktreesRootFor } from './task-worktree-folder';
import { isGitRepo, isInsideWorktree } from './git-checks';
import { resolveWorktreeBase, describeUnresolvableBase, refResolvesLocally } from './base-branch';
import { linkNodeModules, removeNodeModulesPath } from './node-modules-link';
import { fetchIfStale } from './fetch-throttle';
import { removeWithRetry, type RemoveWithRetryOptions } from './rm-with-retry';
import { runGitWithTimeout as runGitWithTimeoutShared } from './git-spawn';
import { runInitScript, INIT_SCRIPT_TIMEOUT_MS } from './run-init-script';
import { reapProcessesForWorktree } from './zombie-reaper';

/**
 * Re-emit the `init-script` progress label this often while the init script
 * runs. spawn-progress's SPAWN_PROGRESS_TTL_MS is 120s, so a multi-minute
 * install would otherwise be TTL-pruned from the queryable map on the next
 * syncSessions/HMR reconcile; the heartbeat keeps the card label alive.
 */
const INIT_SCRIPT_PROGRESS_HEARTBEAT_MS = 30_000;

/**
 * Wall-clock ceiling for git ops in the worktree-removal path. Small repos
 * complete in <500ms, but `git worktree remove --force` on heavy node_modules
 * (observed 5-12s on real TroyWeb repos during batch retry-cleanup) needs
 * headroom. On timeout we abort the child so the per-project git queue keeps
 * moving instead of cascading.
 */
const GIT_REMOVAL_TIMEOUT_MS = 15_000;

/**
 * How hard to try when removing a worktree's files. The same enum tunes both
 * the node_modules step and the manual-removal fallback.
 *
 *   thorough - full backoff (the historical default). Used where a failure
 *              surfaces an error to the user (worktree CREATE, project delete),
 *              so it is worth grinding through transient Windows locks.
 *   moderate - a pinned path fails in a few seconds, but bulk deletion of an
 *              unpinned tree is unaffected. Used on the user-facing Done-move
 *              and cleanup paths so a held handle can never hold the git queue
 *              for minutes; the partial-delete -> husk-reuse -> startup-retry
 *              net (see removeWorktree) finishes the job eventually.
 *   fast     - a single attempt, no backoff. Used by the background startup
 *              retry pass, which is already deferred to the next open.
 */
export type WorktreeRemovalProfile = 'thorough' | 'moderate' | 'fast';

/**
 * The outcome of creating (or reusing) a task's worktree. `worktreeFolder` is
 * the directory name the caller must persist via
 * `TaskRepository.setWorktreeFolder`, so the same task lands on the same path
 * forever - including across a Done round-trip, which nulls `worktree_path` and
 * therefore makes the move back out a fresh creation.
 */
export interface WorktreeCreateResult {
  worktreePath: string;
  branchName: string;
  worktreeFolder: string;
}

const REMOVAL_PROFILE_OPTIONS: Record<WorktreeRemovalProfile, RemoveWithRetryOptions | undefined> = {
  thorough: undefined,
  moderate: { delays: [0, 500], innerMaxRetries: 2 },
  fast: { delays: [0], innerMaxRetries: 0 },
};

/**
 * Scan timeout for the pre-removal orphan reap, per profile. `fast` (background
 * retry) uses the tighter boot-sweep cap; the user-facing profiles give a cold
 * PowerShell `Get-CimInstance` room to start.
 */
const REAP_SCAN_TIMEOUT_MS: Record<WorktreeRemovalProfile, number> = {
  thorough: 5000,
  moderate: 5000,
  fast: 1500,
};

/**
 * Wrapper that pins the (cwd, args, timeoutMs) call shape used by the
 * worktree-removal path. The shared helper accepts an optional external
 * AbortSignal that this path doesn't currently use.
 */
function runGitWithTimeout(
  projectPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return runGitWithTimeoutShared(projectPath, args, { timeoutMs });
}

/** Background prune debounce per project. */
const backgroundPruneTimestamps = new Map<string, number>();
const BACKGROUND_PRUNE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Actionable message for a stale worktree directory that could not be removed
 * and is not a reusable empty husk. `reason` distinguishes a directory that
 * still holds files (`not-empty`) from one that could not even be listed
 * (`unreadable`); both mean a process is holding it, but the unreadable case
 * must not falsely claim the directory is non-empty. Names the likely blockers
 * so the toast that surfaces this (via TASK_MOVE -> renderer) tells the user
 * what to close.
 */
/**
 * Append the path-length explanation to a worktree failure when length is a
 * plausible cause, leaving the error untouched otherwise.
 *
 * This is the only place path length is surfaced to the user, and it fires only
 * on an error they are already seeing, so it cannot false-positive on a project
 * that has no native toolchain. Predicting the failure instead would warn most
 * users about something that will never happen to them.
 */
function withPathLengthCause(error: unknown, worktreePath: string): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  const cause = describeWorktreePathLengthCause(worktreePath, wrapped);
  if (!cause) return wrapped;
  return new Error(`${wrapped.message} ${cause}`, { cause: wrapped });
}

/**
 * Refuse to recursively delete anything that is not a worktree directory of this
 * project.
 *
 * `removeWorktree` runs a retried recursive removal that is deliberately
 * aggressive about Windows file locks, on a path that is COMPUTED (from a stored
 * column, a display_id, or a legacy slug). A bug anywhere in that derivation - a
 * null folder name, a failed `path.join`, a `..` inside a task title - would
 * point that machinery at a directory nobody meant to delete. The cost of this
 * check is one string comparison; the cost of not having it is unbounded.
 */
export function assertRemovableWorktreePath(projectPath: string, worktreePath: string): void {
  const resolved = path.resolve(worktreePath);
  if (path.parse(resolved).root === resolved) {
    throw new Error(`Refusing to remove a filesystem root as a worktree: ${resolved}`);
  }
  const worktreesRoot = path.resolve(worktreesRootFor(projectPath));
  const relative = path.relative(worktreesRoot, resolved);
  // Exactly one segment below the worktrees root: not the root itself, not an
  // ancestor (`..`), not a grandchild, and not on another drive (`path.relative`
  // returns an absolute path when there is no relative route).
  const isDirectChild = relative !== ''
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && !relative.includes(path.sep)
    && !relative.includes('/');
  if (!isDirectChild) {
    throw new Error(
      `Refusing to remove ${resolved}: it is not a direct child of ${worktreesRoot}.`,
    );
  }
}

function staleWorktreeError(worktreePath: string, reason: 'not-empty' | 'unreadable'): string {
  const detail = reason === 'not-empty'
    ? 'could not be removed and is not empty'
    : 'could not be removed and could not be inspected';
  return `Cannot create worktree: a stale directory at ${worktreePath} ${detail}. `
    + `A process is likely holding files in it. Close anything using this `
    + `path (an open agent terminal or editor, the Kangentic /preview dev server, or `
    + `antivirus/search indexing) and retry.`;
}

// ---------------------------------------------------------------------------
// Per-project priority queue for git-mutating operations
// ---------------------------------------------------------------------------

/**
 * Priority for a queued git operation. LOWER number runs sooner, so the
 * default (USER) wins over background maintenance. A user-initiated spawn
 * enqueued behind a slow/failing background cleanup jumps ahead of every
 * other *waiting* background job - it still has to let the one currently
 * running op finish (so the `.git` lock is never contended), but it no longer
 * sits behind a pile of doomed cleanup removals.
 */
export enum GitQueuePriority {
  USER = 0,
  BACKGROUND = 10,
}

/** A single git-mutating operation waiting on (or running in) a project queue. */
interface GitJob {
  priority: number;
  /** Monotonic enqueue counter; FIFO tiebreak within equal priority. */
  seq: number;
  /** Short identifier for logs and the waiting-card label (e.g. `remove-worktree:1a2b3c4d`). */
  label: string;
  /** Wall-clock at enqueue, for "waited Nms" logging. */
  enqueuedAt: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** Re-emit progress while parked; cleared when the job dequeues or settles. */
  waitTimer: ReturnType<typeof setInterval> | null;
  /** Latest wait callback, invoked at enqueue and on each waitTimer tick. */
  onWaitProgress?: (info: GitWaitProgress) => void;
}

/**
 * Per-project scheduler state. `running` is true while exactly one job's
 * `run()` is in flight (this is what preserves the one-op-at-a-time guarantee
 * that prevents `.git` lock contention). `waiting` is kept sorted by
 * (priority asc, seq asc) so `shift()` always yields the next job to run.
 * `runningJob` describes that in-flight op so parked jobs can report what they
 * are waiting behind.
 */
interface ProjectQueue {
  running: boolean;
  runningJob: { label: string; startedAt: number } | null;
  waiting: GitJob[];
}

const projectQueues = new Map<string, ProjectQueue>();

/** Monotonic counter for FIFO ordering within a priority band. */
let gitJobSeq = 0;

/** How often a long-running queue holder logs a heartbeat. */
const GIT_QUEUE_HEARTBEAT_MS = 15_000;
/** How often a parked job re-emits its wait progress to the renderer. */
const GIT_WAIT_PROGRESS_INTERVAL_MS = 5_000;

/** Normalize project path for use as a queue key (Windows is case-insensitive). */
function queueKey(projectPath: string): string {
  return process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
}

/** Progress reported to a parked job while it waits for the queue. */
export interface GitWaitProgress {
  /**
   * Number of jobs that will run before this one (snapshot at enqueue; only
   * ever an upper bound as the queue drains).
   */
  jobsAhead: number;
  /** Internal label of the op currently holding the queue, or null if none. */
  runningLabel: string | null;
  /** Milliseconds the running op has held the queue, or 0 if none. */
  runningElapsedMs: number;
}

/** Options accepted by withGitLock / withLock. */
interface GitLockOptions {
  /** Lower = runs sooner. Defaults to GitQueuePriority.USER. The enum type
   *  keeps `GitReadPriority` values (the read queue's OPPOSITE-direction
   *  constants) from type-checking here. */
  priority?: GitQueuePriority;
  /**
   * Short identifier for logs and the waiting-card label (e.g.
   * `remove-worktree:1a2b3c4d`). Defaults to `git-op`.
   */
  label?: string;
  /**
   * Called when the job cannot start immediately (something is running or
   * already queued): once synchronously at enqueue, then every ~5s while it
   * stays parked. The timer is cleared the instant the job dequeues to run, so
   * the job's own progress labels take over from there. Lets the renderer show
   * what a waiting task is blocked behind and for how long.
   */
  onWaitProgress?: (info: GitWaitProgress) => void;
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
   * Only one op per project runs at a time; when the runner frees, the
   * highest-priority waiting job runs next (FIFO within equal priority).
   */
  withLock<T>(operation: () => Promise<T>, options?: GitLockOptions): Promise<T> {
    return WorktreeManager.withGitLock(this.projectPath, operation, options);
  }

  /**
   * Serialize a git-mutating operation on the given project's queue. Exactly
   * one operation runs at a time per project (no `.git` lock contention), but
   * waiting operations are ordered by priority so a user-initiated spawn does
   * not sit behind a slow/failing background cleanup. A failed operation does
   * not block subsequent ones (the runner always advances).
   */
  static withGitLock<T>(
    projectPath: string,
    operation: () => Promise<T>,
    options?: GitLockOptions,
  ): Promise<T> {
    const key = queueKey(projectPath);
    let queue = projectQueues.get(key);
    if (!queue) {
      queue = { running: false, runningJob: null, waiting: [] };
      projectQueues.set(key, queue);
    }

    return new Promise<T>((resolve, reject) => {
      const job: GitJob = {
        priority: options?.priority ?? GitQueuePriority.USER,
        seq: gitJobSeq++,
        label: options?.label ?? 'git-op',
        enqueuedAt: Date.now(),
        run: operation as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        waitTimer: null,
        onWaitProgress: options?.onWaitProgress,
      };

      if (!queue!.running && queue!.waiting.length === 0) {
        // Runner free and nothing queued: start immediately, no wait signal.
        WorktreeManager.runJob(key, queue!, job);
        return;
      }

      // Parked behind the running op and/or other waiters. Insert first so the
      // progress snapshot reflects the job's real position, then emit once and
      // re-emit on a timer so the waiting card shows what it is blocked behind
      // and for how long. The timer is cleared in runJob (dequeue) and
      // clearQueue (project close).
      WorktreeManager.insertSorted(queue!.waiting, job);
      if (job.onWaitProgress) {
        job.onWaitProgress(WorktreeManager.waitProgressFor(queue!, job));
        job.waitTimer = setInterval(() => {
          job.onWaitProgress?.(WorktreeManager.waitProgressFor(queue!, job));
        }, GIT_WAIT_PROGRESS_INTERVAL_MS);
        job.waitTimer.unref?.();
      }
    });
  }

  /**
   * Snapshot a parked job's wait state. `jobsAhead` counts the running op plus
   * every equal-or-higher-priority waiter ahead of `job` (only ever an upper
   * bound as the queue drains). The running op's label and elapsed let the
   * renderer name the blocker.
   */
  private static waitProgressFor(queue: ProjectQueue, job: GitJob): GitWaitProgress {
    const aheadInWaiting = queue.waiting.filter(
      (other) => other !== job && other.priority <= job.priority,
    ).length;
    return {
      jobsAhead: (queue.running ? 1 : 0) + aheadInWaiting,
      runningLabel: queue.runningJob?.label ?? null,
      runningElapsedMs: queue.runningJob ? Date.now() - queue.runningJob.startedAt : 0,
    };
  }

  /** Insert a job into `waiting`, keeping it sorted by (priority asc, seq asc). */
  private static insertSorted(waiting: GitJob[], job: GitJob): void {
    let insertionIndex = waiting.length;
    for (let candidateIndex = 0; candidateIndex < waiting.length; candidateIndex++) {
      if (job.priority < waiting[candidateIndex].priority
        || (job.priority === waiting[candidateIndex].priority && job.seq < waiting[candidateIndex].seq)) {
        insertionIndex = candidateIndex;
        break;
      }
    }
    waiting.splice(insertionIndex, 0, job);
  }

  /** Run a job, then drain the next waiter regardless of how this one settled. */
  private static runJob(key: string, queue: ProjectQueue, job: GitJob): void {
    queue.running = true;
    const startedAt = Date.now();
    queue.runningJob = { label: job.label, startedAt };

    // The job is no longer parked: stop re-emitting its wait progress.
    if (job.waitTimer) {
      clearInterval(job.waitTimer);
      job.waitTimer = null;
    }

    console.log(`[GIT_QUEUE] start ${job.label} (waited ${startedAt - job.enqueuedAt}ms, ${queue.waiting.length} waiting)`);

    // Heartbeat so a multi-minute holder is visible in logs (stuck vs slow).
    // `.unref()` so it never keeps the process alive on its own.
    const heartbeat = setInterval(() => {
      console.log(`[GIT_QUEUE] ${job.label} still running (${Math.round((Date.now() - startedAt) / 1000)}s, ${queue.waiting.length} waiting)`);
    }, GIT_QUEUE_HEARTBEAT_MS);
    heartbeat.unref?.();

    const settle = () => {
      clearInterval(heartbeat);
      console.log(`[GIT_QUEUE] done ${job.label} in ${Date.now() - startedAt}ms`);
      queue.runningJob = null;
      WorktreeManager.runNext(key);
    };

    // Both arms advance the runner, so a thrown/rejected op never wedges the
    // queue (this preserves the old `previous.then(op, () => op())` behavior).
    Promise.resolve()
      .then(job.run)
      .then(
        (value) => { job.resolve(value); settle(); },
        (error) => { job.reject(error); settle(); },
      );
  }

  /** Mark the runner free and start the next-highest-priority waiting job. */
  private static runNext(key: string): void {
    const queue = projectQueues.get(key);
    // The queue may have been cleared (project closed) while a job ran; the
    // finished job simply stops and does not recreate the queue.
    if (!queue) return;
    queue.running = false;
    const next = queue.waiting.shift();
    if (next) WorktreeManager.runJob(key, queue, next);
  }

  /**
   * Remove the queue entry for a project (e.g. on project close/delete).
   * Any still-waiting jobs are rejected so their callers don't hang forever.
   * A job that is currently running is left to settle; `runNext` then finds
   * no queue entry and stops cleanly.
   */
  static clearQueue(projectPath: string): void {
    const key = queueKey(projectPath);
    const queue = projectQueues.get(key);
    if (queue) {
      for (const job of queue.waiting) {
        if (job.waitTimer) {
          clearInterval(job.waitTimer);
          job.waitTimer = null;
        }
        job.reject(new Error('Git queue cleared (project closed)'));
      }
      queue.waiting.length = 0;
    }
    projectQueues.delete(key);
  }

  /**
   * Guard + create worktree in one call. Returns null if any guard fails
   * (already has a live worktree on disk, worktrees disabled, not a git repo,
   * is a worktree).
   */
  async ensureWorktree(
    task: { id: string; title: string; display_id: number; worktree_path: string | null; worktree_folder?: string | null; branch_name?: string | null; base_branch?: string | null; use_worktree?: number | null },
    gitConfig: { worktreesEnabled: boolean; defaultBaseBranch: string; copyFiles: string[]; initScript?: string | null; linkNodeModules?: boolean },
    options?: { onProgress?: (phase: string) => void; signal?: AbortSignal },
  ): Promise<WorktreeCreateResult | null> {
    // Trust worktree_path only if the worktree still genuinely exists on disk.
    // A Done cleanup that could not delete the directory (Windows pinned-CWD)
    // leaves worktree_path set pointing at an emptied husk with no `.git` file;
    // trusting it blindly would silently no-op the move-back and resume nothing.
    // A missing or husk directory falls through to createWorktree, which
    // recomputes the identical (deterministic) path and recreates the worktree.
    if (task.worktree_path && fs.existsSync(task.worktree_path) && isInsideWorktree(task.worktree_path)) {
      return null;
    }
    const shouldUseWorktree = task.use_worktree != null
      ? Boolean(task.use_worktree)
      : gitConfig.worktreesEnabled;
    if (!shouldUseWorktree) return null;
    if (!isGitRepo(this.projectPath)) return null;
    if (isInsideWorktree(this.projectPath)) return null;

    // Resolve the base branch against the repo's ACTUAL refs before ever calling
    // `git worktree add`, instead of handing it a name that may not exist. A `master`-only
    // repo falls back past the hardcoded 'main' default and works; a genuinely broken base
    // fails loudly with a written reason.
    //
    // Also covers the no-commits case (a freshly `git init`-ed repo has an unborn HEAD, so
    // `git worktree add` fails on ANY ref): Kangentic itself produces that state when it
    // initialises a repo for a folder that had none (see `ensureGitRepo`), and the user's very
    // next action is usually a task move. Running in the project directory is the honest answer;
    // worktrees start working on their own once there is a first commit. Living here (rather than
    // at each `ensureWorktree` caller) means the `create_worktree` transition action gets the
    // same guard as the normal task-move path.
    const resolution = await resolveWorktreeBase(
      this.projectPath,
      task.base_branch ?? null,
      gitConfig.defaultBaseBranch || 'main',
      { signal: options?.signal },
    );
    if (resolution.kind === 'no-commits') return null;
    if (resolution.kind === 'unresolvable') {
      throw new Error(describeUnresolvableBase(resolution));
    }

    // A substituted fallback (e.g. 'master' for an unconfigured 'main' default) becomes the
    // new default too, so computeAutoBranchName sees base === default and keeps the branch
    // name unprefixed instead of namespacing every branch under the substitute
    // (e.g. `master/fix-thing-ab12cd34`). An unsubstituted resolution (including every
    // explicit per-task base) keeps the originally configured default.
    const defaultBaseBranch = resolution.substitutedFor
      ? resolution.baseBranch
      : (gitConfig.defaultBaseBranch || 'main');

    return this.createWorktree(task, resolution.baseBranch, gitConfig.copyFiles, task.branch_name, {
      onProgress: options?.onProgress,
      signal: options?.signal,
      defaultBaseBranch,
      initScript: gitConfig.initScript,
      linkNodeModules: gitConfig.linkNodeModules,
      verifiedStartPoint: resolution.startPoint,
    });
  }

  /**
   * Create a worktree for a task.
   *
   * The BRANCH is named from a slug of the task title (it shows up in PRs and
   * `git branch`, so it stays readable). The DIRECTORY is named from the task's
   * `display_id`, which keeps the path short - Kangentic's own scheme used to
   * spend 49 characters of Windows' 260-character MAX_PATH before any toolchain
   * added anything, and the title-derived slug was the larger, unbounded half.
   *
   * A task's worktree folder is chosen exactly once and never changes:
   *   - `worktree_folder` non-null: use it verbatim. This covers every worktree
   *     created before the numeric scheme (backfilled by migration, or recovered
   *     from the task's session history by `recoverLegacyWorktreeFolder`) and
   *     every one created after it.
   *   - `worktree_folder` null: the folder is `String(display_id)`, and the
   *     caller persists it via `TaskRepository.setWorktreeFolder`.
   *   - Invariant: whenever `worktree_path` is non-null,
   *     `path.basename(worktree_path) === worktree_folder`.
   *   - Parsers accept both the legacy `<slug>-<8hex>` form and the numeric
   *     form. Nothing on disk is ever renamed or relocated.
   *
   * That stability is load-bearing, not cosmetic. A Done move nulls
   * `worktree_path`, so moving back out is a FRESH creation; if it landed at a
   * different path, the agent's transcript would be orphaned (Claude keys it by
   * a slug of the cwd, `~/.claude/projects/<slug-of-cwd>/<id>.jsonl`, so
   * `--resume` reports "No conversation found") and the worktree's browser
   * cookie jar would be dropped (`browserPartitionForWorktree` hashes the path).
   *
   * Callers must wrap with `withLock()` to serialize concurrent operations
   * on the same project and prevent git lock contention.
   */
  async createWorktree(
    task: { id: string; title: string; display_id: number; worktree_path?: string | null; worktree_folder?: string | null },
    baseBranch: string = 'main',
    copyFiles: string[] = [],
    customBranchName?: string | null,
    options?: {
      onProgress?: (phase: string) => void;
      signal?: AbortSignal;
      defaultBaseBranch?: string;
      initScript?: string | null;
      linkNodeModules?: boolean;
      /**
       * A ref already observed to resolve (supplied by `ensureWorktree` from its
       * `resolveWorktreeBase` call), used as the start point whenever the fetch below does
       * not demonstrably land `origin/<branch>`. Without it, a fetch failure falls back to the
       * bare branch name, which does not resolve for a base that exists only as
       * `origin/<branch>` and was never checked out locally. Optional; omitting it keeps the
       * plain fetch-or-bare-name behavior.
       */
      verifiedStartPoint?: string;
    },
  ): Promise<WorktreeCreateResult> {
    const shortId = task.id.slice(0, 8);
    const defaultBaseBranch = options?.defaultBaseBranch ?? 'main';

    // `display_id` is `INTEGER DEFAULT NULL` in SQL but `number` in TypeScript,
    // and rowToTask spreads the raw row. Fail loudly rather than materializing a
    // directory literally named "null".
    if (!Number.isInteger(task.display_id) || task.display_id <= 0) {
      throw new Error(
        `Cannot create worktree for task ${task.id}: display_id is ${String(task.display_id)}, `
        + 'which is not a positive integer.',
      );
    }

    // Reuse the folder this task has always used, falling back to its stored
    // path (belt and braces for a row the migration somehow missed) before
    // choosing the numeric name for the first time. See the JSDoc above for why
    // this must never change once chosen.
    const existingFolder = task.worktree_folder
      ?? worktreeFolderFromPath(task.worktree_path);
    const folderName = existingFolder ?? String(task.display_id);

    // The branch stays title-derived and readable, independent of the folder. A
    // caller-supplied custom name always wins verbatim.
    const branchName = customBranchName
      ?? computeAutoBranchName(
        baseBranch,
        defaultBaseBranch,
        slugify(task.title) || 'task',
        shortId,
      );

    const worktreesDir = worktreesRootFor(this.projectPath);
    const worktreePath = path.join(worktreesDir, folderName);

    // Ensure worktrees dir exists
    try {
      await fs.promises.mkdir(worktreesDir, { recursive: true });
    } catch (err) {
      console.error(`[WORKTREE] Failed to create worktrees directory: ${worktreesDir}`, err);
      throw new Error(`Cannot create worktrees directory at ${worktreesDir}: ${(err as Error).message}`);
    }

    // Fetch the latest from origin so worktrees start from up-to-date code.
    // Uses throttle cache to skip redundant fetches within FETCH_THROTTLE_MS.
    // Emit 'fetching' here (not eagerly before the lock) so a job that parked
    // in the queue flips from the "Waiting..." label to "Fetching latest..."
    // the instant it actually starts the fetch.
    options?.onProgress?.('fetching');
    const fetched = await fetchIfStale(this.git, this.projectPath, baseBranch, { signal: options?.signal });
    // A fetch that actually landed `origin/<branch>` wins (freshest code). Otherwise fall back
    // to a ref already OBSERVED to resolve, because both of fetchIfStale's other outcomes give
    // a start point that can fail `git worktree add`: on failure it returns the bare branch
    // name, which does not resolve for a base that exists only as `origin/<branch>`; and on
    // success it reports the fetch PROCESS exit code, which is not the same as the ref landing
    // in refs/remotes/origin/ (a narrowed remote.origin.fetch refspec, or a fetch that only
    // populated FETCH_HEAD, both exit 0). resolveWorktreeBase re-verifies for the same reason.
    const startPoint = fetched === `origin/${baseBranch}` && await refResolvesLocally(this.projectPath, fetched)
      ? fetched
      : (options?.verifiedStartPoint ?? fetched);
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
    let reuseEmptyHusk = false;
    if (fs.existsSync(worktreePath)) {
      // Internal, deliberately: this clears a stale husk so a fresh worktree
      // can be created at the SAME path. The worktree-removed listener means
      // "this path no longer holds a worktree", which is not true a moment
      // later here, so it must not fire (Codex would drop the directory's
      // trust table immediately before the new worktree starts using it).
      const removed = await this.removeWorktreeInternal(worktreePath);
      if (!removed) {
        // The directory could not be deleted. On Windows a process holding it
        // as its current directory (an agent terminal, an open editor, the
        // Kangentic /preview dev server, or antivirus) blocks the final rmdir
        // even though removeWorktree already cleared the contents. A pinned-CWD
        // directory can still be populated by another process, and `git worktree
        // add` accepts an existing EMPTY directory, so reuse the husk in place
        // rather than failing the move-back. Only the genuinely-stuck case
        // (real files still held) is fatal.
        let leftover: string[];
        try {
          leftover = fs.readdirSync(worktreePath);
        } catch (error) {
          const errnoError = error as NodeJS.ErrnoException;
          console.warn(
            `[WorktreeManager] Could not inspect stale worktree dir: ${worktreePath} `
            + `(code=${errnoError.code ?? 'unknown'} errno=${errnoError.errno ?? '?'} syscall=${errnoError.syscall ?? '?'}): ${errnoError.message}`
          );
          throw new Error(staleWorktreeError(worktreePath, 'unreadable'));
        }
        if (leftover.length > 0) {
          throw new Error(staleWorktreeError(worktreePath, 'not-empty'));
        }
        reuseEmptyHusk = true;
      }
      options?.signal?.throwIfAborted();
    }
    // On Windows, enable long paths to prevent "Filename too long" errors
    // when the project contains deeply nested files (e.g. .NET migrations).
    // The -c flag is per-command and does not modify the project's git config.
    // This setting is Windows-only (uses \\?\ extended-length path prefix);
    // macOS/Linux have 1024-4096 byte PATH_MAX and are unaffected.
    const longPathsConfig = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
    // Reusing an empty husk needs --force so git clears any stale
    // `.git/worktrees/<id>` registration whose directory still exists (plain
    // prune only removes registrations for missing dirs). --force is gated on
    // the husk path so the normal create still surfaces a genuine "branch
    // already checked out in another worktree" error.
    const forceFlag = reuseEmptyHusk ? ['--force'] : [];
    try {
      if (branchExists) {
        await this.git.raw([...longPathsConfig, 'worktree', 'add', ...forceFlag, worktreePath, branchName]);
        console.log(`[WORKTREE] Created worktree (existing branch): ${branchName}`);
      } else {
        await this.git.raw([...longPathsConfig, 'worktree', 'add', ...forceFlag, '-b', branchName, worktreePath, startPoint]);
        console.log(`[WORKTREE] Created worktree (new branch): ${branchName} from ${startPoint}`);
      }
    } catch (error) {
      throw withPathLengthCause(error, worktreePath);
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
    // and hooks are delivered via --settings flag pointing to session directory).
    // Async fs so the per-file copy loop yields the event loop between files
    // instead of blocking it: a busy main process otherwise bunches the spawn
    // progress IPC pushes, which then land as one burst on the renderer.
    for (const file of copyFiles) {
      if (file.startsWith('.claude/') || file.startsWith('.claude\\')) continue;
      const src = path.join(this.projectPath, file);
      const dest = path.join(worktreePath, file);
      try {
        await fs.promises.access(src);
      } catch {
        continue; // Source does not exist -- nothing to copy.
      }
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest);
    }

    // Link node_modules from root so worktree agents can run typecheck/test
    // without a slow npm install. Non-fatal if it fails. Linking is the default
    // (undefined/true link); only an explicit `false` skips it, e.g. so an
    // initScript install can own the worktree's deps instead of sharing root's.
    const shouldLinkNodeModules = options?.linkNodeModules ?? true;
    if (shouldLinkNodeModules) {
      await linkNodeModules(worktreePath, this.projectPath);
    }

    // Run the user's Post-Worktree Script (git.initScript) last, so it sees the
    // copied files and the linked (or deliberately absent) node_modules. A
    // non-zero exit, timeout, or abort is FATAL: it rejects createWorktree,
    // failing the task move / agent spawn, exactly like a failed copyFile above.
    const initScript = options?.initScript?.trim();
    if (initScript) {
      options?.onProgress?.('init-script');
      // npm install can take minutes; re-emit the phase so the card label
      // survives the 120s spawn-progress TTL during a long run.
      const heartbeat = setInterval(() => options?.onProgress?.('init-script'), INIT_SCRIPT_PROGRESS_HEARTBEAT_MS);
      try {
        console.log(`[INIT-SCRIPT] Running post-worktree script in ${worktreePath}: ${initScript}`);
        const { stdout, stderr } = await runInitScript(initScript, worktreePath, {
          timeoutMs: INIT_SCRIPT_TIMEOUT_MS,
          signal: options?.signal,
        });
        if (stdout.trim()) console.log(`[INIT-SCRIPT] stdout:\n${stdout.trim()}`);
        if (stderr.trim()) console.log(`[INIT-SCRIPT] stderr:\n${stderr.trim()}`);
        console.log('[INIT-SCRIPT] Post-worktree script completed');
      } catch (error) {
        console.error(`[INIT-SCRIPT] Post-worktree script failed in ${worktreePath}:`, error);
        throw withPathLengthCause(error, worktreePath);
      } finally {
        clearInterval(heartbeat);
      }
    }

    return { worktreePath, branchName, worktreeFolder: folderName };
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
    const slug = slugify(newTitle) || 'task';
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

  /**
   * Remove a worktree directory. Returns false when the directory could not be
   * removed (file handles still held) so the caller leaves `worktree_path` set
   * for the next project-open retry pass.
   *
   * Steps, in order:
   *   1. Clear the worktree's node_modules (junction-safe; never traverses into
   *      a junction's target, so the main repo's node_modules is protected) and
   *      run `git worktree remove --force`, falling back to manual recursive rm.
   *   2. ONLY IF step 1 failed: reap orphaned processes pinning this worktree
   *      (zombie Electron/node left by E2E `_electron.launch()` or `/preview`)
   *      and retry step 1 once.
   *
   * The process reap is LAZY by design: a clean Done-move (no pinning orphan,
   * the overwhelming common case) never runs the OS process scan, so dragging a
   * task to Done pays zero added cost. The scan only fires on the rare delete
   * that a held handle actually blocks, where it is the cheapest way to unstick
   * the directory instead of leaving a husk. It is skipped entirely under
   * `NODE_ENV=test`: E2E owns its own leaked-process sweep (the janitor), and a
   * test's apps are parented by the Playwright worker anyway.
   *
   * `options.timeoutMs` caps each git call. `options.removalProfile` (default
   * `thorough`) tunes the retry budget; `moderate` makes a still-pinned path
   * fail in seconds instead of grinding for minutes while it holds the queue. A
   * false return is not a dead end: the caller logs a partial-delete warning and
   * leaves `worktree_path` set, so the directory is reused as an empty husk on
   * the next `createWorktree` (see `ensureWorktree`) and/or removed by the
   * startup retry pass (`retryFailedDoneCleanups`).
   */
  async removeWorktree(
    worktreePath: string,
    options?: { timeoutMs?: number; removalProfile?: WorktreeRemovalProfile },
  ): Promise<boolean> {
    const removed = await this.removeWorktreeInternal(worktreePath, options);
    // Single notification point for the whole app. There are seven call sites
    // for worktree removal (Done move, task delete, archive, MCP delete,
    // project close, startup retry, branch-switch cleanup), and they are
    // hand-copied rather than routed through one helper - notifying at each
    // one is how a leak gets shipped, which is exactly what happened to the
    // MCP delete path. Notifying HERE is unmissable by construction.
    if (removed) await notifyWorktreeRemoved(worktreePath);
    return removed;
  }

  private async removeWorktreeInternal(
    worktreePath: string,
    options?: { timeoutMs?: number; removalProfile?: WorktreeRemovalProfile },
  ): Promise<boolean> {
    assertRemovableWorktreePath(this.projectPath, worktreePath);
    if (!fs.existsSync(worktreePath)) return true;

    const timeoutMs = options?.timeoutMs ?? GIT_REMOVAL_TIMEOUT_MS;
    const profile = options?.removalProfile ?? 'thorough';
    const removeStartedAt = Date.now();
    console.log(`[WORKTREE] remove start: ${worktreePath} (profile=${profile})`);

    // Happy path: clear node_modules + git remove (manual-rm fallback). No
    // process scan, so a clean Done-move pays nothing for the reap machinery.
    if (await this.tryGitRemoval(worktreePath, profile, timeoutMs)) {
      console.log(`[WORKTREE] remove finished: ${worktreePath} removed=true total=${Date.now() - removeStartedAt}ms`);
      return true;
    }

    // Removal failed: a process is holding the directory. The usual culprit is
    // an orphaned app-under-test (zombie Electron/node from E2E or /preview)
    // pinning node_modules. Reap any such process SCOPED TO THIS WORKTREE, then
    // retry once. This is the ONLY place the scan runs, so it never taxes a
    // clean move. Skipped in tests (the E2E janitor owns leaked-process sweeps).
    if (process.env.NODE_ENV !== 'test') {
      const reapStartedAt = Date.now();
      const reaped = await reapProcessesForWorktree({
        worktreePath,
        scanTimeoutMs: REAP_SCAN_TIMEOUT_MS[profile],
      });
      console.log(`[WORKTREE] remove step=reap done in ${Date.now() - reapStartedAt}ms (killed=${reaped.length})`);
      if (reaped.length > 0 && await this.tryGitRemoval(worktreePath, profile, timeoutMs)) {
        console.log(`[WORKTREE] remove finished: ${worktreePath} removed=true total=${Date.now() - removeStartedAt}ms`);
        return true;
      }
    }

    // Still pinned (nothing to reap, or the pin is AV / an editor / something we
    // do not own). Best-effort prune so git's metadata is consistent; leave the
    // husk for the husk-reuse + startup-retry net.
    try {
      await runGitWithTimeout(this.projectPath, ['worktree', 'prune'], timeoutMs);
    } catch { /* best effort */ }
    console.log(`[WORKTREE] remove finished: ${worktreePath} removed=false total=${Date.now() - removeStartedAt}ms`);
    return false;
  }

  /**
   * One removal attempt: clear node_modules (junction-safe, bounded by profile),
   * `git worktree remove --force`, then a manual recursive rm + prune fallback.
   * Returns true on success, false if the directory could not be removed. Touches
   * NO process scanning, so it is safe to call on the happy path and to retry.
   */
  private async tryGitRemoval(
    worktreePath: string,
    profile: WorktreeRemovalProfile,
    timeoutMs: number,
  ): Promise<boolean> {
    await prepareWorktreeForRemoval(worktreePath, profile);

    const gitStartedAt = Date.now();
    try {
      await runGitWithTimeout(
        this.projectPath,
        ['worktree', 'remove', worktreePath, '--force'],
        timeoutMs,
      );
      return true;
    } catch (error) {
      console.log(`[WORKTREE] remove step=git-remove failed in ${Date.now() - gitStartedAt}ms, falling back to manual removal: ${(error as Error).message}`);
    }

    // Stat-first recursive removal with exponential backoff (per profile).
    // Windows NTFS transient locks (EBUSY, ENOTEMPTY, EPERM) on .git/objects/pack/*
    // and lingering child-process handles need longer than the old 2s window.
    // Also handles EISDIR explicitly (dirent race where a child flips from
    // file to directory mid-walk), which Node's recursive rm can surface on
    // nested node_modules left by sub-package npm installs.
    const manualStartedAt = Date.now();
    try {
      await removeWithRetry(worktreePath, REMOVAL_PROFILE_OPTIONS[profile]);
      await runGitWithTimeout(this.projectPath, ['worktree', 'prune'], timeoutMs);
      console.log(`[WORKTREE] remove step=manual-rm done in ${Date.now() - manualStartedAt}ms`);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      console.warn(
        `[WorktreeManager] Could not remove worktree after retries: ${worktreePath} `
        + `(code=${err.code ?? 'unknown'} errno=${err.errno ?? '?'} syscall=${err.syscall ?? '?'} path=${err.path ?? '?'}): ${err.message}`
      );
      return false;
    }
  }

  async removeBranch(branchName: string): Promise<void> {
    try {
      await runGitWithTimeout(this.projectPath, ['branch', '-D', branchName], GIT_REMOVAL_TIMEOUT_MS);
    } catch { /* branch may not exist, or git hung and was killed */ }
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
   *
   * The dirty check runs even when the branch is ALREADY current, so the
   * postcondition is uniform: every successful return means "on this branch,
   * with no uncommitted tracked changes". It previously returned early on a
   * same-branch call, which is the common case (a repeat move of a task already
   * on its branch), so callers were reading a guarantee the function had not
   * established.
   *
   * Untracked and ignored files are deliberately not counted. `git checkout`
   * preserves them, so rejecting them would block every project with a
   * `node_modules` or a `build/` directory.
   */
  async checkoutBranch(branchName: string): Promise<void> {
    // HEAD is read before the dirty check only so the message can tell the truth.
    // The check itself still runs in both cases, which is the uniform
    // postcondition described above.
    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const status = await this.git.status();
    const trackedChanges = status.files.filter(
      file => file.index !== '?' && file.working_dir !== '?',
    );
    if (trackedChanges.length > 0) {
      throw new Error(
        currentBranch === branchName
          ? `Cannot start work on '${branchName}': the main repo has uncommitted changes. `
            + 'Commit or stash them, or enable worktree mode for this task.'
          : `Cannot switch to branch '${branchName}': you have uncommitted changes. `
            + 'Commit or stash your changes, or enable worktree mode for this task.',
      );
    }

    if (currentBranch === branchName) return;

    await this.git.checkout(branchName);
  }

  async pruneWorktrees(): Promise<void> {
    await runGitWithTimeout(this.projectPath, ['worktree', 'prune'], GIT_REMOVAL_TIMEOUT_MS);
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
      // Bounded git call (matches pruneWorktrees): an unbounded simple-git
      // prune that hangs on a held .git lock would set queue.running and never
      // release, wedging every later op (incl. user spawns) on this project.
      await runGitWithTimeout(projectPath, ['worktree', 'prune'], GIT_REMOVAL_TIMEOUT_MS);
      console.log(`[WORKTREE] Background prune completed for ${projectPath}`);
    }, { priority: GitQueuePriority.BACKGROUND, label: 'background-prune' }).catch((error) => {
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

  /**
   * The worktree path holding `branchName`, or null when no worktree has it
   * checked out.
   *
   * Git allows a branch in only ONE working tree at a time, so this answers
   * "will `git worktree add` refuse this branch?" BEFORE anything is created.
   * The main checkout is always the first record `git worktree list` prints, so
   * a branch the user simply has checked out counts as held.
   *
   * Deliberately does NOT prune first. A stale registration makes `git worktree
   * add` fail with the same "already used by worktree" error until it is
   * pruned, so reporting it matches git's real behaviour - and naming the path
   * is what tells the caller which stale entry to clear.
   */
  async findWorktreeHoldingBranch(branchName: string): Promise<string | null> {
    const porcelain = await this.git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreeBranches(porcelain).get(branchName) ?? null;
  }
}

/**
 * Map each branch checked out in one of this repository's worktrees to the path
 * holding it, from `git worktree list --porcelain` output.
 *
 * Parsed as RECORDS, not lines, because three things bite a line-wise parse:
 *
 * 1. A record is `worktree <path>`, then optionally `HEAD <sha>`, then exactly
 *    ONE of `branch refs/heads/<name>` / `detached` / `bare`. Not every record
 *    names a branch, so a branch line must be paired with the path from its own
 *    record (records are separated by a blank line).
 * 2. The ref is stripped by PREFIX. Splitting on '/' would mangle a branch name
 *    that legitimately contains slashes, e.g. `feature/login`.
 * 3. `listWorktrees` above cannot be reused: it keeps only the `worktree` paths
 *    and drops the `branch` lines, which are exactly what this needs.
 *
 * The trailing-`\r` strip below is defensive only. git writes porcelain output
 * LF-terminated on every platform, Windows included, so it is belt-and-braces
 * against a future caller piping this through something that does not - the
 * same reason every other git-output parser in this file calls `.trim()`.
 *
 * Exported for direct unit testing; the three cases above are silent when wrong.
 */
export function parseWorktreeBranches(porcelain: string): Map<string, string> {
  const REF_PREFIX = 'refs/heads/';
  const branchToWorktreePath = new Map<string, string>();
  let currentWorktreePath: string | null = null;

  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      currentWorktreePath = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      currentWorktreePath = line.slice('worktree '.length);
      continue;
    }
    if (line.startsWith('branch ') && currentWorktreePath) {
      const ref = line.slice('branch '.length);
      const branchName = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
      if (branchName) branchToWorktreePath.set(branchName, currentWorktreePath);
    }
  }

  return branchToWorktreePath;
}

/**
 * Clear a worktree's node_modules ahead of removal (junction-safe). Pure
 * filesystem work - it touches NO `.git` state, so a caller may run it OUTSIDE
 * `WorktreeManager.withLock` to keep the slow node_modules removal (irreducibly
 * multi-second under antivirus on a real install) off the per-project git queue.
 * Same-path races are excluded by the per-task `withTaskLock` the removal callers
 * (`deleteTaskWorktree`, `cleanupTaskResources`) already hold.
 *
 * Does NOT scan or kill processes: the orphaned-pinner reap is deferred to
 * `removeWorktree`'s failure path so a clean Done-move (the common case) pays no
 * process-scan cost. Idempotent (node_modules removal no-ops on ENOENT), so it
 * is correct to call this before the lock AND have `removeWorktree` call it again
 * inside each removal attempt. Never throws (removeNodeModulesPath swallows its
 * own errors). The junction guard in `removeNodeModulesPath` is load-bearing.
 */
export async function prepareWorktreeForRemoval(
  worktreePath: string,
  profile: WorktreeRemovalProfile,
): Promise<void> {
  if (!fs.existsSync(worktreePath)) return;

  const nodeModulesStartedAt = Date.now();
  await removeNodeModulesPath(path.join(worktreePath, 'node_modules'), {
    removeOptions: REMOVAL_PROFILE_OPTIONS[profile],
  });
  console.log(`[WORKTREE] remove step=node-modules done in ${Date.now() - nodeModulesStartedAt}ms`);
}

// ---------------------------------------------------------------------------
// Worktree-removed listener
// ---------------------------------------------------------------------------

/**
 * Notified once per successful worktree removal, from the single chokepoint in
 * `WorktreeManager.removeWorktree`.
 *
 * The contract is "this path no longer holds a worktree", NOT "a live worktree
 * was just deleted": removal succeeds trivially for a path that was already
 * gone, and the startup retry pass fires it for exactly that case. A listener
 * must therefore be idempotent and safe on an absent directory. It is also not
 * called for the husk clear inside `createWorktree`, where the path is about to
 * be reused.
 *
 * Registered by the main process at startup rather than imported here, so this
 * low-level git module keeps its dependency direction: it must not reach into
 * the agent registry (and the resulting import cycle) just to announce that a
 * directory is gone.
 *
 * The consumer is per-directory state an agent CLI keeps in a GLOBAL config
 * file, which nothing else would ever clean up. Codex is the motivating case:
 * its directory trust lives in `~/.codex/config.toml` keyed by path and is not
 * inherited by subdirectories, so Kangentic writes one entry per task worktree
 * and would otherwise leave one dead entry behind per task, forever.
 */
type WorktreeRemovedListener = (worktreePath: string) => Promise<void>;

let worktreeRemovedListener: WorktreeRemovedListener | null = null;

export function setWorktreeRemovedListener(listener: WorktreeRemovedListener | null): void {
  worktreeRemovedListener = listener;
}

async function notifyWorktreeRemoved(worktreePath: string): Promise<void> {
  if (!worktreeRemovedListener) return;
  try {
    await worktreeRemovedListener(worktreePath);
  } catch (error) {
    // Best-effort: the worktree is already gone, and a failure here only
    // leaves a stale entry behind. It must never fail the removal.
    console.warn('[WORKTREE] worktree-removed listener failed (non-fatal):', error);
  }
}
