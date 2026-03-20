/**
 * Unit tests for the revert-on-worktree-failure logic in handleTaskMove Priority 4.
 *
 * When ensureTaskWorktree or ensureTaskBranchCheckout throws (e.g. duplicate
 * branch from a previous incomplete cleanup), the task must be moved back to
 * its original column (fromSwimlaneId) and the error re-thrown with a
 * user-friendly "Worktree setup failed: ..." wrapper.
 */
import { describe, it, expect } from 'vitest';

interface MoveInput {
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
}

/**
 * Replicates the Priority 4 revert logic from handleTaskMove.
 *
 * On worktree/branch setup failure:
 * 1. Move the task back to fromSwimlaneId at its original position
 * 2. Re-throw with a "Worktree setup failed: <original message>" wrapper
 *
 * If the revert itself fails, the original error is still thrown.
 */
async function executeWithRevert(
  setupFn: () => Promise<void>,
  revertFn: (input: MoveInput) => void,
  input: MoveInput,
  fromSwimlaneId: string,
  originalPosition: number,
): Promise<void> {
  try {
    await setupFn();
  } catch (error) {
    try {
      revertFn({ taskId: input.taskId, targetSwimlaneId: fromSwimlaneId, targetPosition: originalPosition });
    } catch (revertError) {
      console.error('[TASK_MOVE] Failed to revert task move:', revertError);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Worktree setup failed: ${message}`);
  }
}

describe('Worktree move revert', () => {
  const input: MoveInput = {
    taskId: 'task-123',
    targetSwimlaneId: 'in-progress-lane',
    targetPosition: 0,
  };
  const fromSwimlaneId = 'backlog-lane';
  const originalPosition = 2;

  it('does nothing when setup succeeds', async () => {
    const moves: MoveInput[] = [];

    await executeWithRevert(
      async () => { /* success */ },
      (moveInput) => moves.push(moveInput),
      input,
      fromSwimlaneId,
      originalPosition,
    );

    expect(moves).toHaveLength(0);
  });

  it('reverts task to original column on setup failure', async () => {
    const moves: MoveInput[] = [];

    await expect(
      executeWithRevert(
        async () => { throw new Error("fatal: a branch named 'my-branch' already exists"); },
        (moveInput) => moves.push(moveInput),
        input,
        fromSwimlaneId,
        originalPosition,
      ),
    ).rejects.toThrow('Worktree setup failed:');

    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({
      taskId: 'task-123',
      targetSwimlaneId: 'backlog-lane',
      targetPosition: 2,
    });
  });

  it('wraps the original error message', async () => {
    const originalMessage = "fatal: a branch named 'on-fix-login-bug' already exists";

    await expect(
      executeWithRevert(
        async () => { throw new Error(originalMessage); },
        () => { /* revert succeeds */ },
        input,
        fromSwimlaneId,
        originalPosition,
      ),
    ).rejects.toThrow(`Worktree setup failed: ${originalMessage}`);
  });

  it('still throws original error when revert fails', async () => {
    await expect(
      executeWithRevert(
        async () => { throw new Error('branch already exists'); },
        () => { throw new Error('DB connection lost'); },
        input,
        fromSwimlaneId,
        originalPosition,
      ),
    ).rejects.toThrow('Worktree setup failed: branch already exists');
  });

  it('handles non-Error throwables', async () => {
    await expect(
      executeWithRevert(
        async () => { throw 'string error'; },
        () => { /* revert succeeds */ },
        input,
        fromSwimlaneId,
        originalPosition,
      ),
    ).rejects.toThrow('Worktree setup failed: string error');
  });
});
