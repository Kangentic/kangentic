/**
 * Per-task AbortController registry for in-flight moves (`handleTaskMove`).
 *
 * A newer move of the same task aborts the one in flight, so a task moved back
 * before its async spawn completes never ends up with an orphaned session. The
 * signal propagates through the move's async call chain; each helper throws
 * AbortError when cancelled, and cleanup is centralized in the move's catch.
 *
 * A move registers before its Phase 1 lock and releases in its `finally`, so an
 * entry here also says the move is still working on the task: across the
 * unlocked Phase 2 gap, too, where the task row already sits in its new column
 * with no session and no worktree yet. The startup pass reads that
 * (`isMoveInFlight`) and leaves the spawn to the move.
 *
 * Lives in its own dependency-light module, as `session-resume-controllers.ts`
 * does, so the startup pass can read it without pulling in the move handler's
 * import cone.
 *
 * Contract: abort BEFORE acquiring `withTaskLock(taskId)`, never inside it.
 */
const taskMoveControllers = new Map<string, AbortController>();

/** Cancel the task's in-flight move. Safe no-op when none is running. */
export function abortInFlightMove(taskId: string): void {
  taskMoveControllers.get(taskId)?.abort();
}

/** Register the controller of a move that is about to start. It replaces the previous one. */
export function registerMoveController(taskId: string, controller: AbortController): void {
  taskMoveControllers.set(taskId, controller);
}

/** Remove a controller when its move settles. Only its own entry, never a newer move's. */
export function releaseMoveController(taskId: string, controller: AbortController): void {
  if (taskMoveControllers.get(taskId) === controller) taskMoveControllers.delete(taskId);
}

/** True while a move of the task has not settled. */
export function isMoveInFlight(taskId: string): boolean {
  return taskMoveControllers.has(taskId);
}
