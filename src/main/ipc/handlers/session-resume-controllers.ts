/**
 * Per-task AbortController registry for in-flight session resumes and the
 * resume-class spawns that share their cancellation (`autoSpawnForTask`).
 *
 * Lives in its own dependency-light module (no electron, no PTY imports) so
 * that handlers outside sessions.ts (e.g. project relocation) can cancel an
 * in-flight resume without pulling in the full session-handler import cone.
 *
 * Contract: abort BEFORE acquiring `withTaskLock(taskId)`, never inside it.
 * An in-flight resume may hold the lock while stuck in unlocked git I/O;
 * aborting from inside the lock would deadlock waiting for that holder.
 *
 * A task can have MORE than one controller registered at once: a phone Start
 * (`autoSpawnForTask`) registers without aborting an in-flight desktop
 * resume, by design. The registry therefore holds every in-flight controller
 * per task rather than one slot, so `abortInFlightResume` reaches all of
 * them and a registration never displaces another caller's controller, which
 * would have left that caller uncancellable by the next suspend or reset.
 */
const sessionResumeControllers = new Map<string, Set<AbortController>>();

/** Cancel every in-flight resume for a task. Safe no-op when none is running. */
export function abortInFlightResume(taskId: string): void {
  const controllers = sessionResumeControllers.get(taskId);
  if (!controllers) return;
  for (const controller of controllers) controller.abort();
}

/** Register a fresh controller for a resume that is about to start. */
export function registerResumeController(taskId: string, controller: AbortController): void {
  let controllers = sessionResumeControllers.get(taskId);
  if (!controllers) {
    controllers = new Set();
    sessionResumeControllers.set(taskId, controllers);
  }
  controllers.add(controller);
}

/** Remove a controller when its resume settles. Only its own entry, never another caller's. */
export function releaseResumeController(taskId: string, controller: AbortController): void {
  const controllers = sessionResumeControllers.get(taskId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) sessionResumeControllers.delete(taskId);
}
