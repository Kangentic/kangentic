import { describe, it, expect } from 'vitest';
import { describeIpcError } from '../../src/renderer/lib/ipc-error';

/**
 * Observed live in a preview before this existed, on the branch-checkout guard:
 *
 *   Failed to move task: Error invoking remote method 'task:move':
 *   BranchCheckoutBlockedError: Cannot switch branches in C:\... "Task A" is
 *   already running an agent there. Stop that task, or enable worktree mode.
 *
 * Two layers of plumbing in front of a sentence written for the user.
 */
describe('describeIpcError', () => {
  it('strips the Electron channel decoration and the Error class name', () => {
    const raw = new Error(
      "Error invoking remote method 'task:move': BranchCheckoutBlockedError: "
      + 'Cannot switch branches in C:\\proj: "Task A" is already running an agent there.',
    );
    expect(describeIpcError(raw)).toBe(
      'Cannot switch branches in C:\\proj: "Task A" is already running an agent there.',
    );
  });

  it('strips a plain Error: prefix too', () => {
    expect(describeIpcError(new Error("Error invoking remote method 'task:move': Error: Worktree setup failed")))
      .toBe('Worktree setup failed');
  });

  it('leaves an undecorated message untouched', () => {
    expect(describeIpcError(new Error('Worktree setup failed: disk full'))).toBe('Worktree setup failed: disk full');
  });

  it('does not eat a colon that is part of the message', () => {
    // `fatal:` is lowercase and does not end in Error, so it is not a class name.
    expect(describeIpcError(new Error('fatal: not a git repository'))).toBe('fatal: not a git repository');
    // A drive letter must survive.
    expect(describeIpcError(new Error('Cannot read C:\\proj'))).toBe('Cannot read C:\\proj');
  });

  it('falls back for a non-Error or empty rejection', () => {
    expect(describeIpcError('a string')).toBe('Unknown error');
    expect(describeIpcError(undefined)).toBe('Unknown error');
    expect(describeIpcError(new Error(''))).toBe('Unknown error');
    expect(describeIpcError(new Error("Error invoking remote method 'x': "), 'Move failed')).toBe('Move failed');
  });
});
