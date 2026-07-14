import PQueue from 'p-queue';

/**
 * Global cap on concurrent read-only git fan-outs (churn capture, HEAD
 * probes). These operations spawn raw git subprocesses outside the
 * per-project write queue (`WorktreeManager.withGitLock`); before this cap,
 * six simultaneous task finalizations fanned out into ~36 concurrent git
 * children and serialized the main-process event loop.
 *
 * The cap is per OUTER operation, not per spawn: one churn job runs up to 3
 * concurrent git children internally (DiffService.getDiffFiles Promise.all),
 * so the true spawn ceiling is ~3x this number.
 *
 * Interactive single-flight paths deliberately stay OFF this queue: the
 * DiffService reads (the Changes panel, the mobile bridge diff read) and the
 * panel-refresh HEAD reads (`readWorktreeHeadUnqueued` in branch-summary.ts /
 * commit-graph.ts). They are user-facing and latency-sensitive, and were not
 * implicated in the stall trace.
 *
 * Rules for callers:
 * - Never call a `viaGitRead`-wrapped helper from inside another `viaGitRead`
 *   job: at concurrency 2 a nested wait can starve the queue.
 * - This queue and the per-project write queue (`withGitLock`) must never
 *   nest in either direction. Read probes run before/outside the write lock.
 */
export const GIT_READ_CONCURRENCY = 2;
const gitReadQueue = new PQueue({ concurrency: GIT_READ_CONCURRENCY });

/**
 * Priorities for the read queue. p-queue semantics: a HIGHER number runs
 * sooner - the OPPOSITE of `GitQueuePriority` in worktree-manager.ts (where
 * lower runs sooner). Deliberately a separate const object; never mix the
 * two.
 */
export const GitReadPriority = {
  /** Fire-and-forget stats capture; yields to user-action reads. */
  BACKGROUND: 0,
  /** Reads on a user-initiated path (Done move, PR link). Default. */
  USER: 1,
} as const;

/** The narrow value union keeps `GitQueuePriority` members (the write queue's
 *  OPPOSITE-direction constants) from type-checking here. */
export type GitReadPriorityValue = (typeof GitReadPriority)[keyof typeof GitReadPriority];

/**
 * Run a read-only git operation through the global concurrency limiter.
 * Rejections propagate to the caller unchanged; keep any never-throws catch
 * INSIDE `operation` so a queued job cannot reject a contract that promises
 * not to.
 */
export async function viaGitRead<T>(
  operation: () => Promise<T>,
  options?: { priority?: GitReadPriorityValue },
): Promise<T> {
  // p-queue v9 .add() returns Promise<T | void>; cast like viaGh
  // (github-connector.ts) - the job function always returns T.
  return gitReadQueue.add(operation, {
    priority: options?.priority ?? GitReadPriority.USER,
  }) as Promise<T>;
}
