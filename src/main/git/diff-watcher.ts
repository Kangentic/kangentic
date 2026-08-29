import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { replacePathPrefix } from '../../shared/paths';

const DEBOUNCE_MS = 500;

/**
 * Longest a pending run may be held before the callbacks fire regardless.
 *
 * The debounce below is trailing with no natural ceiling: every event clears
 * and re-arms it, so a stream arriving faster than DEBOUNCE_MS never lets it
 * expire and the subscribers hear NOTHING for as long as the stream lasts.
 * More than two file events per second clears that bar, which a running dev
 * server, a test run, or an install inside the worktree does easily - so the
 * Changes panel would sit frozen for the whole build and read as broken.
 *
 * Capping the run keeps the coalescing (the point of the debounce) while
 * guaranteeing forward progress.
 */
const MAX_DEBOUNCE_WAIT_MS = 2000;

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.kangentic']);

/**
 * Git-directory files whose change means the diff or branch summary may have
 * moved without touching a working-tree file: a commit / checkout / reset (HEAD,
 * ORIG_HEAD, logs/HEAD), staging (index), a merge in progress (MERGE_HEAD), or a
 * packed-ref update. Watched so the panel auto-updates without a manual refresh.
 */
const GIT_META_FILES = new Set(['index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'packed-refs']);

interface WatcherEntry {
  watchers: fs.FSWatcher[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** When the current pending run started, for the MAX_DEBOUNCE_WAIT_MS cap.
   *  Only meaningful while `debounceTimer` is non-null. */
  pendingSince: number;
  /**
   * Every subscriber's callback for this path. The renderer's git-diff panel
   * is single-subscriber-per-path, but the mobile bridge fans out one live
   * `read-diff` subscription per paired device/task onto the SAME path (two
   * worktree-less tasks in one repo, or two phones on one task, both resolve
   * to the same git directory), so a path must multiplex - one debounced
   * `fs.watch` set feeding every registered callback, torn down only when the
   * last subscriber leaves.
   */
  callbacks: Set<() => void>;
}

/**
 * Manages file system watchers for worktree directories.
 * Emits debounced change notifications when files are modified.
 *
 * Two kinds of watch per subscription, both feeding the same debounced callback:
 *  1. the working tree (recursive), ignoring .git/node_modules/.kangentic, and
 *  2. the git directory's metadata (index + logs/HEAD), watched NON-recursively
 *     so we never descend into the huge, churning objects/ store (which would
 *     also exhaust inotify watches on Linux). This makes commits, staging, and
 *     checkouts refresh the panel automatically, replacing the manual button.
 */
export class DiffWatcher {
  private readonly watchers = new Map<string, WatcherEntry>();
  /** worktree path -> resolved absolute git dir. Survives subscribe/unsubscribe
   *  cycles; invalidated only by `releaseUnder`, which means the path is going
   *  away for real. */
  private readonly gitDirCache = new Map<string, string>();

  /**
   * Register a change callback for a path, returning a teardown that removes
   * ONLY this callback (closing the underlying `fs.watch` handles when it was
   * the last one). A repeat subscribe for an already-watched path attaches to
   * the existing watch instead of no-oping, so every subscriber is wired.
   */
  subscribe(worktreePath: string, callback: () => void): () => void {
    const existing = this.watchers.get(worktreePath);
    if (existing) {
      existing.callbacks.add(callback);
      return () => this.removeCallback(worktreePath, callback);
    }

    const entry: WatcherEntry = {
      watchers: [],
      debounceTimer: null,
      pendingSince: 0,
      callbacks: new Set([callback]),
    };
    this.watchers.set(worktreePath, entry);

    const dispatch = () => {
      for (const registeredCallback of entry.callbacks) registeredCallback();
    };

    // Debounce: reset the shared timer on each change from any watcher, then
    // fan the single fire out to every registered callback. Capped at
    // MAX_DEBOUNCE_WAIT_MS so a continuous event stream cannot starve it.
    const fire = () => {
      const current = this.watchers.get(worktreePath);
      if (current !== entry) return; // unsubscribed/replaced while debouncing

      const now = Date.now();
      if (entry.debounceTimer === null) {
        entry.pendingSince = now;
      } else {
        clearTimeout(entry.debounceTimer);
        if (now - entry.pendingSince >= MAX_DEBOUNCE_WAIT_MS) {
          // Held long enough. Fire now and let the next event open a new run.
          entry.debounceTimer = null;
          dispatch();
          return;
        }
      }

      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        dispatch();
      }, DEBOUNCE_MS);
    };

    // 1. Working tree (recursive), ignoring .git/, node_modules/, .kangentic/.
    try {
      const treeWatcher = fs.watch(worktreePath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const segments = filename.toString().split(path.sep);
        if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return;
        fire();
      });
      entry.watchers.push(treeWatcher);
    } catch {
      // fs.watch may fail on some platforms or if path doesn't exist
    }

    // 2. Git metadata (index, HEAD, logs/HEAD, ...). Resolved async because it
    //    needs the absolute git dir (a worktree's lives under the main repo's
    //    .git/worktrees/<name>, not <worktree>/.git).
    this.watchGitMetadata(worktreePath, entry, fire);

    return () => this.removeCallback(worktreePath, callback);
  }

  /**
   * Remove one subscriber's callback from a path, closing the underlying
   * watchers only when it was the last subscriber. `unsubscribe()` still
   * force-closes every callback for a path (used by relocation's
   * `releaseUnder` and shutdown's `closeAll`; the renderer IPC path refcounts
   * per sender in DiffSubscriptionRegistry and tears down via this method).
   */
  private removeCallback(worktreePath: string, callback: () => void): void {
    const entry = this.watchers.get(worktreePath);
    if (!entry) return;
    entry.callbacks.delete(callback);
    if (entry.callbacks.size === 0) this.unsubscribe(worktreePath);
  }

  /**
   * Watch the git directory's metadata files non-recursively so commits,
   * staging, and checkouts refresh the panel. Best-effort: a failure to resolve
   * or watch the git dir leaves the working-tree watch (1) fully functional.
   */
  private watchGitMetadata(worktreePath: string, entry: WatcherEntry, fire: () => void): void {
    // Resolving the git dir costs a git subprocess (~50-100ms on Windows), and
    // it is paid again every time the last subscriber for a path leaves and a
    // new one arrives - which is exactly what clicking between tasks does. The
    // answer is stable for the life of a worktree, so cache it and let the
    // removing-listener drop it when the worktree is actually deleted.
    const cachedGitDir = this.gitDirCache.get(worktreePath);
    if (cachedGitDir !== undefined) {
      this.armGitMetadataWatches(worktreePath, cachedGitDir, entry, fire);
      return;
    }

    simpleGit(worktreePath)
      .raw(['rev-parse', '--absolute-git-dir'])
      .then((output) => {
        const gitDir = output.trim();
        if (!gitDir) return;
        // Liveness gates the CACHE WRITE, not just the arming below. A
        // `releaseUnder` that lands while this subprocess is still in flight
        // has already dropped the entry AND the cache; re-populating it here
        // would silently undo that invalidation, and every later subscribe for
        // this path would take the cache-hit branch against a git dir that
        // `git worktree remove` has since deleted.
        if (this.watchers.get(worktreePath) !== entry) return;
        this.gitDirCache.set(worktreePath, gitDir);
        this.armGitMetadataWatches(worktreePath, gitDir, entry, fire);
      })
      .catch(() => {
        // Not a git repo, or git unavailable: the working-tree watch still applies.
      });
  }

  /**
   * Arm the two git-metadata watches. Split out of `watchGitMetadata` so the
   * cache hit can take the same path synchronously.
   */
  private armGitMetadataWatches(
    worktreePath: string,
    gitDir: string,
    entry: WatcherEntry,
    fire: () => void,
  ): void {
    // The subscription may have been torn down while git resolved.
    if (this.watchers.get(worktreePath) !== entry) return;

    // Top-level git dir: index (staging), HEAD, ORIG_HEAD, MERGE_HEAD,
    // packed-refs. Non-recursive, so objects/ is never descended.
    try {
      const metaWatcher = fs.watch(gitDir, { recursive: false }, (_eventType, filename) => {
        if (filename && GIT_META_FILES.has(path.basename(filename.toString()))) fire();
      });
      entry.watchers.push(metaWatcher);
    } catch {
      // ignore: a single missing watch must not break the rest
    }

    // logs/HEAD moves on every commit / checkout / reset. It lives one level
    // down, so watch the logs/ directory itself (non-recursive).
    const logsDir = path.join(gitDir, 'logs');
    if (fs.existsSync(logsDir)) {
      try {
        const logsWatcher = fs.watch(logsDir, { recursive: false }, (_eventType, filename) => {
          if (filename && path.basename(filename.toString()) === 'HEAD') fire();
        });
        entry.watchers.push(logsWatcher);
      } catch {
        // ignore
      }
    }
  }

  unsubscribe(worktreePath: string): void {
    const entry = this.watchers.get(worktreePath);
    if (!entry) return;

    if (entry.debounceTimer !== null) {
      clearTimeout(entry.debounceTimer);
    }
    for (const watcher of entry.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore: closing an already-dead watcher is harmless
      }
    }
    this.watchers.delete(worktreePath);
  }

  /**
   * Close every watcher whose path is `pathPrefix` itself or nested under it.
   * Used by project relocation to release the recursive `fs.watch` handles
   * inside a project folder before the folder is moved on disk (Windows cannot
   * rename a directory while any process holds a handle inside it). Uses
   * `replacePathPrefix` so the match is `path.relative`-based and therefore
   * correct across Windows drive-letter case and separator differences.
   */
  releaseUnder(pathPrefix: string): void {
    for (const worktreePath of [...this.watchers.keys()]) {
      if (replacePathPrefix(worktreePath, pathPrefix, pathPrefix) !== null) {
        this.unsubscribe(worktreePath);
      }
    }
    // The path is being moved or deleted, so any resolved git dir under it is
    // now stale. Keyed separately from `watchers` because the cache outlives a
    // subscription; unsubscribe alone must NOT drop it, or the cache would
    // never survive the subscribe/unsubscribe cycle it exists to skip.
    for (const worktreePath of [...this.gitDirCache.keys()]) {
      if (replacePathPrefix(worktreePath, pathPrefix, pathPrefix) !== null) {
        this.gitDirCache.delete(worktreePath);
      }
    }
  }

  /** Clean up all watchers (e.g., on app shutdown). */
  closeAll(): void {
    for (const [worktreePath] of this.watchers) {
      this.unsubscribe(worktreePath);
    }
  }
}
