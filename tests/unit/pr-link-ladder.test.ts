import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../src/shared/types';

/**
 * Unit tests for the confidence ladder in linkPRForTask: which anchor
 * wins (pr_number -> worktree branch -> commit SHA -> slug), write-only-on-change,
 * the TTL coalesce + terminal-skip throttle (force bypasses), and transient-error
 * surfacing that preserves an existing link.
 *
 * The connectors, simple-git, and project-repos are mocked so the core logic is
 * tested in isolation (no gh CLI, no native DB).
 */

const git = vi.hoisted(() => ({
  branch: 'real-branch' as string | null,
  sha: 'sha-current' as string | null,
  // `rev-list --count <base>..<sha>` output: commits the head has of its own
  // beyond base. '0' = a branchless worktree on base's tip (Tier 3 skipped);
  // '1'+ = the task's own work (Tier 3 runs).
  aheadCount: '1',
}));
const conn = vi.hoisted(() => ({
  byNumber: null as unknown,
  byBranch: null as unknown,
  byCommit: null as unknown,
  detect: null as unknown,
  canonical: null as unknown,
  calls: [] as string[],
}));

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    revparse: async (args: string[]) => (args.includes('--abbrev-ref') ? (git.branch ?? 'HEAD') : git.sha),
    raw: async () => git.aheadCount,
  }),
}));

// The core never calls getProjectRepos; mock it so importing pr-linking doesn't
// pull in the DB/electron chain.
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: () => ({}) }));

vi.mock('../../src/main/pr/pr-registry', () => {
  class PRResolverUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = 'PRResolverUnavailableError'; }
  }
  class PRResolverTransientError extends Error {
    constructor(message: string) { super(message); this.name = 'PRResolverTransientError'; }
  }
  const make = (key: 'byNumber' | 'byBranch' | 'byCommit') => async () => {
    conn.calls.push(key);
    const value = conn[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  return {
    PRResolverUnavailableError,
    PRResolverTransientError,
    resolvePRByNumber: make('byNumber'),
    resolvePRForBranch: make('byBranch'),
    resolvePRByCommit: make('byCommit'),
    detectPR: () => conn.detect ?? null,
    detectCanonicalPR: () => conn.canonical ?? null,
  };
});

import { linkPRForTask } from '../../src/main/pr/pr-linking';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../src/main/pr/pr-registry';

let idCounter = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
  idCounter += 1;
  return {
    id: `task-${idCounter}`, display_id: idCounter, title: 'T', description: '', swimlane_id: 'lane', position: 0,
    agent: null, session_id: null, worktree_path: '/wt', branch_name: 'slug', pr_number: null,
    pr_url: null, pr_state: null, head_sha: null, external_id: null, external_source: null,
    external_url: null, base_branch: 'main', use_worktree: 1, labels: [], priority: 0,
    model_override: null, effort_override: null, agent_override: null, attachment_count: 0,
    archived_at: null, created_at: 't', updated_at: 't', ...overrides,
  };
}

function depsFor(task: Task, opts: { updateSpy?: ReturnType<typeof vi.fn>; force?: boolean } = {}) {
  const update = opts.updateSpy ?? vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
  return {
    tasks: { getById: () => task, update } as never,
    projectPath: '/repo',
    onLinked: vi.fn(),
    force: opts.force ?? true, // ladder tests bypass the throttle unless they're testing it
  };
}

const resolved = (number: number, state = 'open') => ({ url: `u${number}`, number, state });

beforeEach(() => {
  conn.byNumber = null; conn.byBranch = null; conn.byCommit = null; conn.detect = null; conn.canonical = null; conn.calls = [];
  git.branch = 'real-branch'; git.sha = 'sha-current'; git.aheadCount = '1';
});

describe('linkPRForTask confidence ladder', () => {
  it('tier 1: prefers pr_number over branch and commit', async () => {
    conn.byNumber = resolved(10); conn.byBranch = resolved(20); conn.byCommit = resolved(30);
    const task = makeTask({ pr_number: 99, head_sha: 'sha' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(10);
    expect(conn.calls[0]).toBe('byNumber');
    expect(conn.calls).not.toContain('byBranch');
  });

  it('tier 2: worktree present resolves by the real HEAD branch', async () => {
    conn.byBranch = resolved(20);
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(20);
    expect(conn.calls).toEqual(['byBranch']);
  });

  it('tier 3: no worktree but head_sha set resolves by commit', async () => {
    conn.byCommit = resolved(30, 'merged');
    const task = makeTask({ worktree_path: null, head_sha: 'sha-stored' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(30);
    expect(result.task?.pr_state).toBe('merged');
    expect(conn.calls).toContain('byCommit');
  });

  it('tier 4: no worktree and no sha falls back to the slug branch', async () => {
    conn.byBranch = resolved(40);
    const task = makeTask({ worktree_path: null, head_sha: null });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(40);
    expect(conn.calls).toContain('byBranch');
  });

  it('tier 3: skips the commit anchor when the commit has no commits ahead of base', async () => {
    // HEAD is base's tip - a branchless worktree, or a single-parent rebase/squash
    // merge tip that a parent-count check would have missed. Not this task's work.
    git.aheadCount = '0';
    conn.byCommit = resolved(702, 'merged'); // the PR that owns base's tip - not this task's PR
    const task = makeTask({ worktree_path: null, branch_name: null, head_sha: 'base-tip' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(conn.calls).not.toContain('byCommit');
    expect(result.status).toBe('not-found');
  });

  it('regression: a fresh worktree on base tip does not link the just-merged PR (magnet bug)', async () => {
    // A newly created task's worktree is branched from base with zero commits, so
    // its HEAD == base's tip == the last-merged PR's rebased commit. With 0 commits
    // ahead of base the commit anchor must not run and magnet onto that PR.
    git.aheadCount = '0';
    conn.byBranch = null; // no PR exists for this brand-new branch yet
    conn.byCommit = resolved(36, 'merged'); // the last-merged PR the commit would magnet onto
    const task = makeTask(); // worktree present, real HEAD branch, no pr_number
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(conn.calls).not.toContain('byCommit');
    expect(result.status).toBe('not-found');
    expect(result.task?.pr_number).toBeNull();
  });

  it('clears a stale link when the resolver cleanly finds no PR (never leaves a stale merged)', async () => {
    // The PR vanished (branch/PR deleted): every tier returns null with no degrade.
    // The stale link - including a stale `merged` - must be cleared atomically.
    conn.byNumber = null; // pr_number no longer resolves
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({ pr_number: 99, pr_url: 'u99', pr_state: 'merged', worktree_path: null, head_sha: null, branch_name: null });
    const deps = depsFor(task, { updateSpy });
    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: null, pr_url: null, pr_state: null }));
    expect(deps.onLinked).toHaveBeenCalledWith(expect.objectContaining({ pr_number: null }));
    expect(result.task?.pr_number).toBeNull();
  });

  it('write-only-on-change: returns unchanged and does not write when the PR is already current', async () => {
    conn.byNumber = resolved(50, 'open');
    const updateSpy = vi.fn();
    const task = makeTask({ pr_number: 50, pr_url: 'u50', pr_state: 'open', worktree_path: null });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('resolver-unavailable: surfaces the reason when the resolver throws and no scrollback exists', async () => {
    conn.byNumber = new PRResolverUnavailableError('gh CLI not found');
    const task = makeTask({ pr_number: 60, worktree_path: null });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/gh/i);
  });

  it('transient-error: preserves the existing link and does not report not-found', async () => {
    conn.byNumber = new PRResolverTransientError('HTTP 503');
    const updateSpy = vi.fn();
    const task = makeTask({ pr_number: 61, pr_url: 'u61', pr_state: 'open', worktree_path: null });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('transient-error');
    expect(updateSpy).not.toHaveBeenCalled();   // existing link preserved
    expect(result.task?.pr_url).toBe('u61');
  });

  it('opportunistically persists head_sha when the worktree HEAD changes', async () => {
    git.sha = 'sha-new';
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({ head_sha: 'sha-old' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ head_sha: 'sha-new' }));
    expect(result.status).toBe('not-found');
  });
});

describe('linkPRForTask description anchor (tier 0)', () => {
  it('tier 0: a PR URL in the description wins over the develop-tip commit anchor', async () => {
    conn.canonical = { url: 'https://github.com/o/r/pull/708', number: 708 };
    conn.byNumber = resolved(708, 'open');
    conn.byCommit = resolved(702, 'merged'); // what the develop-tip merge commit would resolve to
    const task = makeTask({ head_sha: 'develop-tip', description: 'Reviews https://github.com/o/r/pull/708' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(708);
    expect(result.task?.pr_state).toBe('open');
    expect(conn.calls).not.toContain('byCommit');
    expect(conn.calls).not.toContain('byBranch');
  });

  it('tier 0 self-heals an already-mislinked task (pr_number flips on the next resolve)', async () => {
    conn.canonical = { url: 'https://github.com/o/r/pull/706', number: 706 };
    conn.byNumber = resolved(706, 'open');
    const task = makeTask({ pr_number: 702, pr_url: 'u702', pr_state: 'merged', head_sha: 'develop-tip' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(706);
    expect(result.task?.pr_state).toBe('open');
  });

  it('tier 0 links url+number with unknown state when the named PR cannot be confirmed', async () => {
    conn.canonical = { url: 'https://github.com/o/r/pull/708', number: 708 };
    conn.byNumber = null; // gh ran cleanly but matched nothing
    conn.byCommit = resolved(702, 'merged');
    const task = makeTask({ head_sha: 'develop-tip' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(708);
    expect(result.task?.pr_state).toBeNull();
    expect(conn.calls).not.toContain('byCommit');
  });

  it('tier 0 degrades to the scraper when the resolver is unavailable (error propagates, not swallowed)', async () => {
    conn.canonical = { url: 'https://github.com/o/r/pull/708', number: 708 };
    conn.byNumber = new PRResolverUnavailableError('gh CLI not found'); // gh down on the Tier 0 lookup
    conn.byCommit = resolved(702, 'merged'); // the wrong PR the commit tier would have linked
    const task = makeTask({ head_sha: 'develop-tip' });
    const result = await linkPRForTask(task.id, depsFor(task)); // no getScrollback -> nothing to scrape
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/gh/i);
    expect(conn.calls).not.toContain('byCommit'); // never fell through to the wrong git tiers
  });

  it('tier 0: a description PR URL is itself an anchor when the task has no git state', async () => {
    conn.canonical = { url: 'https://github.com/o/r/pull/708', number: 708 };
    conn.byNumber = resolved(708, 'open');
    // No pr_number, branch, head_sha, or worktree - the old guard would no-anchor bail here.
    const task = makeTask({ pr_number: null, branch_name: null, head_sha: null, worktree_path: null });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(708);
    expect(result.task?.pr_state).toBe('open');
  });
});

describe('linkPRForTask throttle (auto triggers only)', () => {
  it('skips a terminal (merged/closed) PR on auto triggers without calling the resolver', async () => {
    conn.byNumber = resolved(70);
    const task = makeTask({ pr_number: 70, pr_url: 'u70', pr_state: 'merged', worktree_path: null });
    const result = await linkPRForTask(task.id, depsFor(task, { force: false }));
    expect(result.status).toBe('unchanged');
    expect(conn.calls).toEqual([]); // resolver never invoked
  });

  it('force bypasses the terminal-skip and re-resolves', async () => {
    conn.byNumber = resolved(71, 'merged');
    const task = makeTask({ pr_number: 71, pr_url: 'u71', pr_state: 'merged', worktree_path: null });
    const result = await linkPRForTask(task.id, depsFor(task, { force: true }));
    expect(conn.calls).toContain('byNumber');
    expect(result.status).toBe('unchanged'); // resolved to the same PR
  });

  it('coalesces back-to-back auto resolves within the TTL window', async () => {
    conn.byBranch = resolved(80);
    const task = makeTask(); // worktree present, no pr_number
    const first = await linkPRForTask(task.id, depsFor(task, { force: false }));
    expect(first.task?.pr_number).toBe(80);
    const callsAfterFirst = conn.calls.length;

    const second = await linkPRForTask(task.id, depsFor(task, { force: false }));
    expect(second.status).toBe('unchanged');
    expect(conn.calls.length).toBe(callsAfterFirst); // no new resolver calls
  });
});
