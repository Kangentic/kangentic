import PQueue from 'p-queue';

/**
 * Per-task lifecycle lock. Serializes any async operation against per-task
 * mutable state - PTY sessions, `task.session_id`, DB row transitions,
 * agent spawn dispatch - so concurrent callers for the SAME task queue in
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
 * ## Scope: what belongs inside the lock
 *
 * Keep the lock as narrow as possible. Wrap only:
 *
 * - Reads or writes `task.session_id` / `task.swimlane_id` and companion
 *   per-task DB rows (session records, transitions, attachments)
 * - `sessionManager.spawn` / `kill` / `suspend` / `removeByTaskId` dispatch
 *   (these are fast - they do not await CLI boot or graceful exit)
 * - `spawnAgent` / `engine.resumeSuspendedSession` / `autoSpawnForTask` -
 *   which write `session_id` via `taskRepo.update` after a fast
 *   `sessionManager.spawn` dispatch
 *
 * Do NOT wrap long-running I/O that is already serialized elsewhere:
 *
 * - `ensureTaskWorktree` / `ensureTaskBranchCheckout` / `deleteTaskWorktree` /
 *   `cleanupTaskResources` are already serialized per project by
 *   `WorktreeManager.projectQueues` (a p-queue keyed on project path,
 *   concurrency=1). Holding `withTaskLock` across these adds only extra
 *   wall-clock to concurrent same-task operations without adding safety.
 *
 * Pure read-only handlers and synchronous-only paths do NOT need the lock.
 * Node is single-threaded; if you never `await`, you cannot race.
 *
 * ## The three rules
 *
 * 1. **Cancellation belongs OUTSIDE the lock.** If your operation has an
 *    `AbortController` (or any other in-flight cancellation mechanism), call
 *    `.abort()` on the existing controller BEFORE acquiring the lock. The
 *    in-flight holder must observe its abort and return so we can acquire.
 *    Aborting after the lock acquire deadlocks - we'd be waiting for a holder
 *    we just queued behind. See `SESSION_SUSPEND` / `SESSION_RESUME` in
 *    `handlers/sessions.ts` for the canonical pattern.
 *
 * 2. **No re-entry for the same task.** Code running inside a `withTaskLock`
 *    block must not call another `withTaskLock` for the same `taskId` (even
 *    transitively through helper functions). The queue is not reentrant and
 *    you will deadlock. In practice this means call `sessionManager.*`,
 *    repositories, and helpers DIRECTLY rather than via IPC handlers, since
 *    most IPC handlers are now wrapped. The one exception: a handler may
 *    call `withTaskLock` multiple times sequentially (not nested) - Phase 1
 *    / Phase 3 in the split-lock pattern below.
 *
 * 3. **Re-check invariants after an unlocked gap.** If your handler releases
 *    the lock to run slow I/O (git, network) and then re-acquires to finish,
 *    re-read the task row at the top of the second locked block and bail
 *    if state you depended on has changed (different swimlane, non-null
 *    `session_id`, task deleted). A newer handler may have run during the
 *    gap.
 *
 * ## Split-lock pattern for handlers that do slow git I/O
 *
 * For handlers that need both DB mutations AND slow git work (worktree
 * creation, branch checkout), split the body into three phases so concurrent
 * same-task ops do not queue behind the git I/O:
 *
 * ```ts
 * ipcMain.handle(IPC.SESSION_RESUME, (_, taskId: string) => {
 *   // Preamble (outside lock): cancel predecessor, install fresh controller.
 *   resumeControllers.get(taskId)?.abort();
 *   const controller = new AbortController();
 *   resumeControllers.set(taskId, controller);
 *   const { signal } = controller;
 *
 *   return (async () => {
 *     // Phase 1 (locked, short): read + validate + build plan.
 *     const plan = await withTaskLock(taskId, async () => {
 *       const task = tasks.getById(taskId);
 *       if (!task || task.session_id) return null;
 *       return { task, projectPath, lane };
 *     });
 *     if (!plan) return null;
 *
 *     // Phase 2 (unlocked, slow): git I/O. Serialized per-project by
 *     // WorktreeManager.projectQueues. A newer handler's .abort() propagates
 *     // via `signal` and throws AbortError here.
 *     await ensureTaskWorktree(context, plan.task, tasks, plan.projectPath, { signal });
 *
 *     // Phase 3 (locked, short): CAS-check invariants, then do the PTY
 *     // state transition + DB write.
 *     return withTaskLock(taskId, async () => {
 *       signal.throwIfAborted();
 *       const current = tasks.getById(taskId);
 *       if (!current || current.session_id) return null; // superseded
 *       await engine.resumeSuspendedSession(current, ..., signal);
 *       return context.sessionManager.getSession(tasks.getById(taskId)!.session_id!);
 *     });
 *   })();
 * });
 * ```
 *
 * ## Example - simple (no git I/O)
 *
 * ```ts
 * // Pattern: cancellable lifecycle op with no slow I/O
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
