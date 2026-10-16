/**
 * Send to Backlog asks before it runs only when it would tear something down.
 *
 * `sendToBacklogAsksFirst` is the one rule shared by the board card, the task
 * detail window, and the Agent Monitor row, so a regression here changes the
 * prompt on all three surfaces at once. The helper is pure, so the whole truth
 * table is pinned directly.
 *
 * Each case names the mutation it would turn red under:
 *   - session-only and worktree-only are separate cases so that `||` becoming
 *     `&&` (which only a task holding BOTH would survive) goes red;
 *   - the skip switch is checked against a task holding both, so a dropped
 *     short-circuit goes red;
 *   - the empty task is checked with the switch on and off, so a helper that
 *     always asks, or never asks, goes red.
 */

import { describe, it, expect } from 'vitest';
import { sendToBacklogAsksFirst } from '../../src/renderer/utils/send-to-backlog-confirm';

describe('sendToBacklogAsksFirst', () => {
  it('asks for a task that holds a session and no worktree', () => {
    // Red if `||` becomes `&&`: a session alone would stop asking.
    expect(sendToBacklogAsksFirst({ session_id: 'session-1', worktree_path: null }, false)).toBe(true);
  });

  it('asks for a task that holds a worktree and no session', () => {
    // Red if `||` becomes `&&`, or if the worktree half of the test is dropped.
    expect(sendToBacklogAsksFirst({ session_id: null, worktree_path: '/mock/worktrees/42' }, false)).toBe(true);
  });

  it('asks for a task that holds both', () => {
    // Red if the helper never asks (always false): the one case a demote tears
    // down a session AND a worktree would then go through unconfirmed.
    expect(sendToBacklogAsksFirst({ session_id: 'session-1', worktree_path: '/mock/worktrees/42' }, false)).toBe(true);
  });

  it('never asks once the user turned the question off, even for a task holding both', () => {
    // Red if the skipDeleteConfirm short-circuit is dropped: both fields are set,
    // so the field test alone would answer true.
    expect(sendToBacklogAsksFirst({ session_id: 'session-1', worktree_path: '/mock/worktrees/42' }, true)).toBe(false);
  });

  it('never asks once the user turned the question off, for a session-only and a worktree-only task', () => {
    // Red if only one of the two fields honours the skip switch.
    expect(sendToBacklogAsksFirst({ session_id: 'session-1', worktree_path: null }, true)).toBe(false);
    expect(sendToBacklogAsksFirst({ session_id: null, worktree_path: '/mock/worktrees/42' }, true)).toBe(false);
  });

  it('never asks for a task with neither a session nor a worktree', () => {
    // Red if the helper always asks: nothing would be torn down.
    expect(sendToBacklogAsksFirst({ session_id: null, worktree_path: null }, false)).toBe(false);
  });

  it('treats an empty string like no session and no worktree', () => {
    // Red if the check becomes `!== null`: an empty id or path holds nothing.
    expect(sendToBacklogAsksFirst({ session_id: '', worktree_path: '' }, false)).toBe(false);
  });

  it('keeps the neither-held answer false with the switch on', () => {
    // Red if the helper ever answers true for an empty task regardless of the switch.
    expect(sendToBacklogAsksFirst({ session_id: null, worktree_path: null }, true)).toBe(false);
  });
});
