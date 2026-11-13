import type { LaunchStartPath, Task } from '../../../shared/types';
import { worktreeFailureCause } from '../../git/worktree-errors';
import { reportPreflightFailure } from '../../pty/agent-launch-report';
import { BranchCheckoutBlockedError, type SpawnFailureStep } from './task-git';
import { WORKTREE_SETUP_FAILED_PREFIX } from './worktree-setup-error';

/**
 * Which step a failed start died in, and the error to report for it. A move
 * wraps a worktree failure with `wrapWorktreeSetupError`, so the step is read
 * from that wrapper and its `cause` is what git threw. Shared by a move's own
 * failure (`reportMoveSpawnFailure`) and a workflow start's toast.
 */
export function spawnFailureOf(error: unknown): { step: SpawnFailureStep; cause: unknown } {
  if (error instanceof Error && error.message.startsWith(WORKTREE_SETUP_FAILED_PREFIX)) return { step: 'worktree', cause: error.cause ?? error };
  if (error instanceof BranchCheckoutBlockedError) return { step: 'checkout', cause: error };
  return { step: 'agent', cause: error };
}

/**
 * Report a move that failed on its worktree or checkout step. A move rejects its
 * invoke instead of calling `notifySpawnBlocked` (the renderer toasts the
 * rejection), so before this a drag's git failure reached Sentry nowhere. The
 * agent step is reported where `spawnAgent` caught it. Marks the error, so the
 * IPC wrap and MCP's runHandler skip the rethrow.
 */
export function reportMoveSpawnFailure(task: Task, error: unknown, startPath: LaunchStartPath = 'board'): void {
  const { step, cause } = spawnFailureOf(error);
  if (step === 'agent') return;
  reportPreflightFailure({
    cause: step === 'worktree' ? worktreeFailureCause(cause) : step,
    error: cause,
    agent: task.agent_override ?? task.agent,
    startPath,
  });
}
