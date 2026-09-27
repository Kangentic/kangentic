import { describe, expect, it } from 'vitest';
import { taskUsesWorktree, storedWorktreeChoice } from '../../src/shared/worktree-choice';

// The one rule main (`ensureWorktree`) and the renderer (the New Task dialog,
// the edit form, the branch hint) both decide by.
describe('taskUsesWorktree', () => {
  it('gives no task a worktree while the Worktrees switch is off, whatever the task picked', () => {
    expect(taskUsesWorktree(false, null)).toBe(false);
    expect(taskUsesWorktree(false, true)).toBe(false);
    expect(taskUsesWorktree(false, false)).toBe(false);
  });

  it('with the switch on, an unset choice means Worktree and a set one wins', () => {
    expect(taskUsesWorktree(true, null)).toBe(true);
    expect(taskUsesWorktree(true, undefined)).toBe(true);
    expect(taskUsesWorktree(true, true)).toBe(true);
    expect(taskUsesWorktree(true, false)).toBe(false);
  });
});

describe('storedWorktreeChoice', () => {
  it('reads the tri-state column as a choice', () => {
    expect(storedWorktreeChoice(1)).toBe(true);
    expect(storedWorktreeChoice(0)).toBe(false);
    expect(storedWorktreeChoice(null)).toBe(null);
    expect(storedWorktreeChoice(undefined)).toBe(null);
  });
});
