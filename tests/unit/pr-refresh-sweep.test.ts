/**
 * Unit tests for the background PR-refresh sweep (refreshProjectPRs): which tasks
 * are eligible (a non-terminal linked PR or a live worktree, in a non-To Do lane)
 * and that the backbone is invoked NON-FORCE exactly once per eligible task. The
 * live-worktree case is the discovery path - an unlinked task whose PR was created
 * mid-session is found on the next sweep.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Swimlane, Task } from '../../src/shared/types';

// getProjectRepos pulls in the DB/electron chain - stub it.
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: vi.fn() }));
// The sweep funnels each eligible task through linkPR (the wrapper).
vi.mock('../../src/main/pr/pr-linking', () => ({ linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })) }));

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

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane', name: 'In Progress', description: null, role: null, position: 0, color: '#888',
    icon: null, is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: false,
    auto_command: null, plan_exit_target_id: null, agent_override: null, model_override: null,
    effort_override: null, handoff_context: false, session_target: 'main',
    session_spawn_strategy: 'create_or_resume', created_at: 't', ...overrides,
  };
}

/** Two lanes: `lane` is an ordinary working lane, `todo-lane` carries role 'todo'. */
const LANES: Swimlane[] = [
  makeSwimlane({ id: 'lane', name: 'In Progress', position: 1 }),
  makeSwimlane({ id: 'todo-lane', name: 'To Do', position: 0, role: 'todo' }),
];

function withTasks(tasks: Task[]): void {
  vi.mocked(getProjectRepos).mockReturnValue({
    tasks: { list: () => tasks },
    swimlanes: { list: () => LANES },
  } as never);
}

function linkedTaskIds(): string[] {
  return vi.mocked(linkPR).mock.calls.map((call) => (call[1] as { taskId: string }).taskId);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshProjectPRs eligibility', () => {
  it('links non-terminal PRs (open / draft / null-state); skips terminal and no-anchor', async () => {
    const open = makeTask({ id: 'open', pr_number: 1, pr_state: 'open' });
    const draft = makeTask({ id: 'draft', pr_number: 2, pr_state: 'draft' });
    const unknownState = makeTask({ id: 'unknown', pr_number: 3, pr_state: null });
    const merged = makeTask({ id: 'merged', pr_number: 4, pr_state: 'merged' });
    const closed = makeTask({ id: 'closed', pr_number: 5, pr_state: 'closed' });
    // No pr_number AND no worktree -> genuinely no anchor.
    const noAnchor = makeTask({ id: 'none', pr_number: null, pr_state: null, description: 'no pr here', worktree_path: null });
    withTasks([open, draft, unknownState, merged, closed, noAnchor]);

    await refreshProjectPRs({} as never, 'proj-1');

    expect(linkedTaskIds()).toEqual(['open', 'draft', 'unknown']);
    expect(linkedTaskIds()).not.toContain('merged');
    expect(linkedTaskIds()).not.toContain('closed');
    expect(linkedTaskIds()).not.toContain('none');
  });

  it('a PR URL in the description is not an anchor (a cited PR is never the task\'s own)', async () => {
    // The mislink this gate exists for: a task citing a sibling task's PR as
    // background, with no pr_number and no worktree of its own. Scraping the
    // description used to make it sweep-eligible and stamp the cited PR onto it.
    const cited = makeTask({
      id: 'cited', pr_number: null, pr_state: null, worktree_path: null,
      description: 'Follows on from the previous task, PR https://github.com/o/r/pull/9.',
    });
    withTasks([cited]);

    await refreshProjectPRs({} as never, 'proj-1');

    expect(linkPR).not.toHaveBeenCalled();
  });

  it('skips a To Do lane task even with a live worktree (To Do resets the task)', async () => {
    // Mirrors autoLinkPRForTask's lane gate, which every implicit trigger honors.
    const inTodo = makeTask({ id: 'todo', swimlane_id: 'todo-lane', pr_number: 1, pr_state: 'open' });
    const working = makeTask({ id: 'working', swimlane_id: 'lane', pr_number: 2, pr_state: 'open' });
    withTasks([inTodo, working]);

    await refreshProjectPRs({} as never, 'proj-1');

    expect(linkedTaskIds()).toEqual(['working']);
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

  it('discovers an unlinked task with a live worktree (no pr_number)', async () => {
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

describe('refreshProjectPRs repo-read degradation', () => {
  it('a throwing swimlanes.list() degrades to "no To Do lanes" but the sweep still runs', async () => {
    // The lane gate is a filter layered on top of the eligibility check, guarded
    // separately from the task read on purpose: losing the lane read must not
    // take the whole sweep down with it. `inTodo` actually sits in the To Do
    // lane and would be excluded if the lane read succeeded (see the "skips a
    // To Do lane task" test above) - sweeping it here proves the degraded gate
    // falls back to treating every lane as non-To-Do, not to aborting.
    const inTodo = makeTask({ id: 'todo', swimlane_id: 'todo-lane', pr_number: 1, pr_state: 'open' });
    const working = makeTask({ id: 'working', swimlane_id: 'lane', pr_number: 2, pr_state: 'open' });
    vi.mocked(getProjectRepos).mockReturnValue({
      tasks: { list: () => [inTodo, working] },
      swimlanes: {
        list: () => {
          throw new Error('swimlane read failed');
        },
      },
    } as never);

    await expect(refreshProjectPRs({} as never, 'proj-1')).resolves.toBeUndefined();

    expect(linkedTaskIds()).toEqual(['todo', 'working']);
  });

  it('a throwing tasks.list() is swallowed by the outer catch; the sweep returns silently', async () => {
    // tasks.list() sits inside the SAME outer try as the lane read, unlike the
    // lane read's own inner try/catch: a task-read failure (e.g. the project DB
    // closed mid-switch) has nothing left to sweep, so it must propagate to the
    // outer catch and return rather than degrade to an empty task list.
    vi.mocked(getProjectRepos).mockReturnValue({
      tasks: {
        list: () => {
          throw new Error('project DB unavailable');
        },
      },
      swimlanes: { list: () => LANES },
    } as never);

    await expect(refreshProjectPRs({} as never, 'proj-1')).resolves.toBeUndefined();

    expect(linkPR).not.toHaveBeenCalled();
  });
});
