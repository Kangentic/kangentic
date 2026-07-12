import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { replacePathPrefix } from '../../shared/paths';

const DEBOUNCE_MS = 500;
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

    const entry: WatcherEntry = { watchers: [], debounceTimer: null, callbacks: new Set([callback]) };
    this.watchers.set(worktreePath, entry);

    // Debounce: reset the shared timer on each change from any watcher, then
    // fan the single fire out to every registered callback.
    const fire = () => {
      const current = this.watchers.get(worktreePath);
      if (current !== entry) return; // unsubscribed/replaced while debouncing
      if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        for (const registeredCallback of entry.callbacks) registeredCallback();
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
   * force-closes every callback for a path (used by the renderer's single
   * subscriber and by relocation's `releaseUnder`/`closeAll`).
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
    simpleGit(worktreePath)
      .raw(['rev-parse', '--absolute-git-dir'])
      .then((output) => {
        const gitDir = output.trim();
        // The subscription may have been torn down while git resolved.
        if (!gitDir || this.watchers.get(worktreePath) !== entry) return;

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
      })
      .catch(() => {
        // Not a git repo, or git unavailable: the working-tree watch still applies.
      });
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
  }

  /** Clean up all watchers (e.g., on app shutdown). */
  closeAll(): void {
    for (const [worktreePath] of this.watchers) {
      this.unsubscribe(worktreePath);
    }
  }
}
