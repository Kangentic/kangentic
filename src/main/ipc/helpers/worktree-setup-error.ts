/**
 * The error a move or a resume throws when its worktree phase fails.
 *
 * `workflow-engine-host.ts` reads the prefix back to name the failing step, and
 * the renderer toasts the text as is. The original error rides along as `cause`
 * for callers that want the raw git failure. A non-Error throwable is stringified.
 */
export const WORKTREE_SETUP_FAILED_PREFIX = 'Worktree setup failed: ';

export function wrapWorktreeSetupError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${WORKTREE_SETUP_FAILED_PREFIX}${message}`, { cause: error });
}
