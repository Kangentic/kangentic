/**
 * The error a move or a resume throws when its worktree phase fails.
 *
 * The prefix is load-bearing: `workflow-engine-host.ts` names the failing step
 * from `startsWith('Worktree setup failed: ')`, and the renderer toasts the
 * text as is. The original error rides along as `cause`.
 *
 * The revert half (task moved back to its source column, the CAS skip when a
 * newer move won, the abort skip, and the original error surviving a failed
 * rollback) runs through the real `handleTaskMove` in task-move-rollback.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  WORKTREE_SETUP_FAILED_PREFIX,
  wrapWorktreeSetupError,
} from '../../src/main/ipc/helpers/worktree-setup-error';

describe('wrapWorktreeSetupError', () => {
  it('prefixes the original message', () => {
    const original = new Error("fatal: a branch named 'on-fix-login-bug' already exists");
    expect(wrapWorktreeSetupError(original).message).toBe(
      "Worktree setup failed: fatal: a branch named 'on-fix-login-bug' already exists",
    );
  });

  it('keeps the prefix the workflow host parses', () => {
    expect(WORKTREE_SETUP_FAILED_PREFIX).toBe('Worktree setup failed: ');
    expect(wrapWorktreeSetupError(new Error('x')).message.startsWith(WORKTREE_SETUP_FAILED_PREFIX)).toBe(true);
  });

  it('carries the original error as cause', () => {
    const original = new Error('branch already exists');
    expect(wrapWorktreeSetupError(original).cause).toBe(original);
  });

  it('stringifies a non-Error throwable and still keeps it as cause', () => {
    const wrapped = wrapWorktreeSetupError('string error');
    expect(wrapped.message).toBe('Worktree setup failed: string error');
    expect(wrapped.cause).toBe('string error');
    expect(wrapped).toBeInstanceOf(Error);
  });
});
