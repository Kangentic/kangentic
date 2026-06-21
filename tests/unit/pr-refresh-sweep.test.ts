/**
 * Unit tests for the background PR-refresh sweep (refreshProjectPRs): which tasks
 * are eligible (non-terminal linked PR, a live worktree, or a description PR
 * anchor) and that the backbone is invoked NON-FORCE exactly once per eligible
 * task. The live-worktree case is the discovery path - an unlinked task whose PR
 * was created mid-session is found on the next sweep.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';

// getProjectRepos pulls in the DB/electron chain - stub it.
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn() }));
// The sweep funnels each eligible task through linkPR (the wrapper).
vi.mock('../../src/main/pr/pr-linking', () => ({ linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })) }));
// detectCanonicalPR decides the description-anchor branch of eligibility.
vi.mock('../../src/main/pr/pr-registry', () => ({
  detectCanonicalPR: vi.fn((text: string) => (text.includes('/pull/') ? { url: 'u', number: 99 } : null)),
}));

import { refreshProjectPRs } from '../../src/main/pr/pr-refresh';
import { getProjectRepos } from '../../src/main/ipc/helpers/project-repos';
import { linkPR } from '../../src/main/pr/pr-linking';

let idCounter = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
  idCounter += 1;
  return {
    id: `task-${idCounter}`, display_id: idCounter, title: 'T', description: '', swimlane_id: 'lane', position: 0,
    agent: null, session_id: null, worktree_path: '/mock/worktrees/wt', branch_name: 'slug', pr_number: null,
    pr_url: null, pr_state: null, head_sha: null, external_id: null, external_source: null,
    external_url: null, base_branch: 'main', use_worktree: 1, labels: [], priority: 0,
    model_override: null, effort_override: null, agent_override: null, attachment_count: 0,
    archived_at: null, created_at: 't', updated_at: 't', ...overrides,
  };
}

function withTasks(tasks: Task[]): void {
  vi.mocked(getProjectRepos).mockReturnValue({ tasks: { list: () => tasks } } as never);
}

function linkedTaskIds(): string[] {
  return vi.mocked(linkPR).mock.calls.map((call) => (call[1] as { taskId: string }).taskId);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshProjectPRs eligibility', () => {
  it('links non-terminal PRs (open / draft / null-state) and description-anchored tasks; skips terminal and no-anchor', async () => {
    const open = makeTask({ id: 'open', pr_number: 1, pr_state: 'open' });
    const draft = makeTask({ id: 'draft', pr_number: 2, pr_state: 'draft' });
    const unknownState = makeTask({ id: 'unknown', pr_number: 3, pr_state: null });
    const merged = makeTask({ id: 'merged', pr_number: 4, pr_state: 'merged' });
    const closed = makeTask({ id: 'closed', pr_number: 5, pr_state: 'closed' });
    const descAnchored = makeTask({ id: 'desc', pr_number: null, pr_state: null, description: 'see https://github.com/o/r/pull/7' });
    // No pr_number, no description anchor, AND no worktree -> genuinely no anchor.
    const noAnchor = makeTask({ id: 'none', pr_number: null, pr_state: null, description: 'no pr here', worktree_path: null });
    withTasks([open, draft, unknownState, merged, closed, descAnchored, noAnchor]);

    await refreshProjectPRs({} as never, 'proj-1');

    expect(linkedTaskIds()).toEqual(['open', 'draft', 'unknown', 'desc']);
    expect(linkedTaskIds()).not.toContain('merged');
    expect(linkedTaskIds()).not.toContain('closed');
    expect(linkedTaskIds()).not.toContain('none');
  });

  it('invokes linkPR non-force (no force flag) so terminal-skip + TTL coalesce stay in effect', async () => {
    withTasks([makeTask({ id: 'open', pr_number: 1, pr_state: 'open' })]);

    await refreshProjectPRs({} as never, 'proj-1');

    expect(linkPR).toHaveBeenCalledTimes(1);
    const options = vi.mocked(linkPR).mock.calls[0][1] as { projectId: string; force?: boolean };
    expect(options.projectId).toBe('proj-1');
    expect(options.force).toBeUndefined();
  });

  it('does nothing when no task is eligible', async () => {
    // worktree_path: null keeps these out of the discovery path (the makeTask
    // default sets a worktree, which would make the second task eligible).
    withTasks([
      makeTask({ pr_number: 4, pr_state: 'merged', worktree_path: null }),
      makeTask({ pr_number: null, pr_state: null, description: '', worktree_path: null }),
    ]);

    await refreshProjectPRs({} as never, 'proj-1');

    expect(linkPR).not.toHaveBeenCalled();
  });

  it('discovers an unlinked task with a live worktree (no pr_number, no description anchor)', async () => {
    const wtOnly = makeTask({ id: 'wt-only', pr_number: null, pr_state: null, description: '', worktree_path: '/mock/worktrees/wt' });
    const bare = makeTask({ id: 'bare', pr_number: null, pr_state: null, description: '', worktree_path: null, branch_name: null });
    // Terminal guard runs before the worktree check: a merged PR is never swept,
    // even with a live worktree.
    const mergedWt = makeTask({ id: 'merged-wt', pr_number: 9, pr_state: 'merged', worktree_path: '/mock/worktrees/wt' });
    withTasks([wtOnly, bare, mergedWt]);

    await refreshProjectPRs({} as never, 'proj-1');

    expect(linkedTaskIds()).toEqual(['wt-only']);
    expect(linkedTaskIds()).not.toContain('bare');
    expect(linkedTaskIds()).not.toContain('merged-wt');
  });

  it('swallows a per-task failure and continues the sweep', async () => {
    vi.mocked(linkPR).mockRejectedValueOnce(new Error('boom'));
    withTasks([
      makeTask({ id: 'first', pr_number: 1, pr_state: 'open' }),
      makeTask({ id: 'second', pr_number: 2, pr_state: 'open' }),
    ]);

    await expect(refreshProjectPRs({} as never, 'proj-1')).resolves.toBeUndefined();
    expect(linkPR).toHaveBeenCalledTimes(2);
  });
});
