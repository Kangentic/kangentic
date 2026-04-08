import PQueue from 'p-queue';

/**
 * Per-task lifecycle lock. Serializes any async operation against per-task
 * mutable state - PTY sessions, `task.session_id`, worktrees, branch checkout,
 * agent spawn/resume/kill - so concurrent callers for the SAME task queue in
 * order instead of interleaving and corrupting state. Different tasks remain
 * fully parallel (per-task `PQueue`, not a global lock).
 *
 * Backed by `p-queue` with `concurrency: 1`, which gives strict FIFO
 * serialization equivalent to a mutex. Chosen over `async-mutex` and
 * hand-rolled alternatives because p-queue is actively maintained by Sindre
 * Sorhus (~20M weekly downloads, recent commits), and provides headroom for
 * future needs (priority, AbortSignal, queue introspection) without forcing
 * a library swap. Native JS / Node has no equivalent primitive in the main
 * process - `navigator.locks` is renderer-only.
 *
 * ## When to wrap a new IPC handler or helper with this
 *
 * If your code crosses an `await` boundary AND any of the following are true,
 * wrap the entire async region in `withTaskLock(taskId, async () => { ... })`:
 *
 * - Reads or writes `task.session_id`
 * - Calls `sessionManager.spawn` / `kill` / `suspend` / `removeByTaskId`
 * - Calls `ensureTaskWorktree`, `ensureTaskBranchCheckout`, or
 *   `cleanupTaskResources`
 * - Calls `spawnAgent` or `autoSpawnForTask`
 * - Mutates per-task DB rows (session records, transitions, attachments)
 *   and depends on the row state being consistent across the await
 *
 * Pure read-only handlers and synchronous-only paths do NOT need the lock.
 * Node is single-threaded; if you never `await`, you cannot race.
 *
 * ## The two rules
 *
 * 1. **Cancellation belongs OUTSIDE the lock.** If your operation has an
 *    `AbortController` (or any other in-flight cancellation mechanism), call
 *    `.abort()` on the existing controller BEFORE acquiring the lock. The
 *    in-flight holder must observe its abort and return so we can acquire.
 *    Aborting after the lock acquire deadlocks - we'd be waiting for a holder
 *    we just queued behind. See `SESSION_SUSPEND` in `handlers/sessions.ts`
 *    for the canonical pattern.
 *
 * 2. **No re-entry for the same task.** Code running inside a `withTaskLock`
 *    block must not call another `withTaskLock` for the same `taskId` (even
 *    transitively through helper functions). The queue is not reentrant and
 *    you will deadlock. In practice this means call `sessionManager.*`,
 *    repositories, and helpers DIRECTLY rather than via IPC handlers, since
 *    most IPC handlers are now wrapped.
 *
 * ## Example
 *
 * ```ts
 * // Pattern: cancellable lifecycle op
 * ipcMain.handle(IPC.SESSION_RESET, (_, taskId: string) => {
 *   sessionResumeControllers.get(taskId)?.abort();   // outside the lock
 *   return withTaskLock(taskId, async () => {        // inside the lock
 *     // ... mutate task / kill PTY / clear DB ...
 *   });
 * });
 * ```
 *
 * ## Implementation notes
 *
 * Map entries are removed once the queue drains (`size === 0 && pending === 0`)
 * so memory stays bounded by the number of currently-active task ops, not the
 * lifetime task count. The cleanup chain attaches its own `.catch(() => {})`
 * to swallow rejections of the derived promise - without this, a rejecting
 * `fn` would produce an `unhandledRejection` on the cleanup branch even
 * though the original rejection is correctly delivered to the caller via the
 * returned promise.
 */
const taskLifecycleQueues = new Map<string, PQueue>();

export function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  let queue = taskLifecycleQueues.get(taskId);
  if (!queue) {
    queue = new PQueue({ concurrency: 1 });
    taskLifecycleQueues.set(taskId, queue);
  }
  const heldQueue = queue;
  // PQueue.add() can theoretically return T | void if the task is cancelled
  // before running. We do not pass a signal so cancellation is not possible
  // here, and the assertion is sound for our usage.
  const result = heldQueue.add(fn) as Promise<T>;
  result
    .catch(() => {})
    .finally(() => {
      if (heldQueue.size === 0 && heldQueue.pending === 0) {
        taskLifecycleQueues.delete(taskId);
      }
    });
  return result;
}

/**
 * Test-only: number of currently-tracked task locks. Used by unit tests to
 * verify the Map drains correctly after operations complete.
 * @internal
 */
export function _taskLockCountForTesting(): number {
  return taskLifecycleQueues.size;
}
