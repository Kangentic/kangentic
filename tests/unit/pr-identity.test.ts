/**
 * `holdsPRIdentity` and `PR_IDENTITY_COLUMNS` (src/main/pr/pr-identity.ts).
 *
 * The list is the contract between two writers that must agree: the To Do move
 * (`forgetPRLinkOnTodoReset`) nulls exactly these columns, and the To Do sweep
 * reads a leftover branch's tip into `head_sha` only for a row that still holds
 * one of them. If the sweep's predicate and the reset's write drift apart, the
 * sweep hands a forgotten task its old commit back and Tier 3 re-links the old
 * PR. Intended behavior comes from those two callers' documented contracts, not
 * from the implementation's loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
  cancelVerdictRepollsForTask: vi.fn(),
}));

import { PR_IDENTITY_COLUMNS, holdsPRIdentity, type PRIdentityColumn } from '../../src/main/pr/pr-identity';
import { forgetPRLinkOnTodoReset } from '../../src/main/pr/pr-link-reset';

const SIX_COLUMNS = ['pr_url', 'pr_number', 'pr_state', 'pr_merge_readiness', 'pushed_branch', 'head_sha'];

function emptyIdentityRow(): Record<PRIdentityColumn, null> {
  return {
    pr_url: null,
    pr_number: null,
    pr_state: null,
    pr_merge_readiness: null,
    pushed_branch: null,
    head_sha: null,
  };
}

const populatedValues: Record<PRIdentityColumn, string | number> = {
  pr_url: 'https://github.com/owner/repo/pull/12',
  pr_number: 12,
  pr_state: 'open',
  pr_merge_readiness: 'ready',
  pushed_branch: 'feature/thing',
  head_sha: 'abc123',
};

describe('PR_IDENTITY_COLUMNS', () => {
  it('is exactly the six columns a To Do reset forgets', () => {
    expect([...PR_IDENTITY_COLUMNS].sort()).toEqual([...SIX_COLUMNS].sort());
  });

  it('lists each column once', () => {
    expect(new Set(PR_IDENTITY_COLUMNS).size).toBe(PR_IDENTITY_COLUMNS.length);
  });
});

describe('holdsPRIdentity', () => {
  it('is false for a row with none of the columns set', () => {
    expect(holdsPRIdentity(emptyIdentityRow() as never)).toBe(false);
  });

  it.each(SIX_COLUMNS)('is true when only %s is set', (column) => {
    const row = { ...emptyIdentityRow(), [column]: populatedValues[column as PRIdentityColumn] };
    expect(holdsPRIdentity(row as never)).toBe(true);
  });

  it('is true when every column is set', () => {
    expect(holdsPRIdentity(populatedValues as never)).toBe(true);
  });

  it('treats an undefined column like null', () => {
    expect(holdsPRIdentity({} as never)).toBe(false);
  });

  // pr_number 0 and an empty string are values, not absence: the predicate is
  // a null check, so a stored falsy value still ties the row to a PR.
  it('treats a falsy but non-null value as held', () => {
    expect(holdsPRIdentity({ ...emptyIdentityRow(), pr_number: 0 } as never)).toBe(true);
    expect(holdsPRIdentity({ ...emptyIdentityRow(), head_sha: '' } as never)).toBe(true);
  });
});

describe('parity with forgetPRLinkOnTodoReset', () => {
  const context = { mainWindow: null } as never;

  let update: ReturnType<typeof vi.fn>;
  let storedRow: Record<string, unknown>;

  beforeEach(() => {
    update = vi.fn();
    storedRow = { id: 'task-1', ...populatedValues };
  });

  it('nulls exactly the columns holdsPRIdentity reads, no more and no fewer', () => {
    const tasks = { getById: vi.fn(() => storedRow), update } as never;

    const cleared = forgetPRLinkOnTodoReset(
      context,
      tasks,
      { id: 'task-1', worktree_path: '/home/dev/proj/.kangentic/worktrees/1', branch_name: 'b', pushed_branch: 'feature/thing', head_sha: 'abc123' },
      'project-1',
    );

    expect(cleared).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    const { id, ...nulledColumns } = patch;
    expect(id).toBe('task-1');
    expect(Object.keys(nulledColumns).sort()).toEqual([...PR_IDENTITY_COLUMNS].sort());
    for (const value of Object.values(nulledColumns)) {
      expect(value).toBeNull();
    }
  });

  it('leaves a row the sweep reads as "forgotten" untouched', () => {
    const tasks = { getById: vi.fn(() => ({ id: 'task-1', ...emptyIdentityRow() })), update } as never;

    const cleared = forgetPRLinkOnTodoReset(
      context,
      tasks,
      { id: 'task-1', worktree_path: '/home/dev/proj/.kangentic/worktrees/1', branch_name: 'b', pushed_branch: null, head_sha: null },
      'project-1',
    );

    expect(cleared).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
