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
  calls: [] as string[],
  // Args the last call to each resolver received, so a test can assert which
  // branch/commit was queried (e.g. the live HEAD branch, not the stored slug).
  lastArgs: {} as Record<string, unknown[]>,
}));

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    revparse: async (args: string[]) => (args.includes('--abbrev-ref') ? (git.branch ?? 'HEAD') : git.sha),
    raw: async () => git.aheadCount,
  }),
}));

// linkPRForTask never calls getProjectRepos, but linkPR (the IPC wrapper) does,
// to resolve the task repo before delegating to linkPRForTask. Mock it so
// importing pr-linking doesn't pull in the DB/electron chain, and make the
// return value swappable per test (via `repos.value`) so the linkPR tests below
// can hand it a real-enough tasks repo instead of the empty ladder-tests default.
const repos = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({ getProjectRepos: () => repos.value }));

// linkPR's onLinked pushes through the shared `sendToRenderer`, which mirrors
// every send into the IPC recorder. The recorder imports `electron` at module
// scope (for its inbound ipcMain.handle patch), so it is stubbed here for the
// same reason getProjectRepos is above - and the spy doubles as the assertion
// that the PR-link push is no longer invisible to `kangentic_get_ipc_log`.
const recordPushSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/diagnostics/ipc-recorder', () => ({ recordPush: recordPushSpy }));

vi.mock('../../src/main/pr/pr-registry', () => {
  class PRResolverUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = 'PRResolverUnavailableError'; }
  }
  class PRResolverTransientError extends Error {
    constructor(message: string) { super(message); this.name = 'PRResolverTransientError'; }
  }
  const make = (key: 'byNumber' | 'byBranch' | 'byCommit') => async (...args: unknown[]) => {
    conn.calls.push(key);
    conn.lastArgs[key] = args;
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
  };
});

import { linkPRForTask, linkPR } from '../../src/main/pr/pr-linking';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../src/main/pr/pr-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';

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

function depsFor(
  task: Task,
  opts: { updateSpy?: ReturnType<typeof vi.fn>; force?: boolean; preserveLinkOnNotFound?: boolean } = {},
) {
  const update = opts.updateSpy ?? vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
  return {
    tasks: { getById: () => task, update } as never,
    projectPath: '/repo',
    onLinked: vi.fn(),
    force: opts.force ?? true, // ladder tests bypass the throttle unless they're testing it
    preserveLinkOnNotFound: opts.preserveLinkOnNotFound,
  };
}

const resolved = (number: number, state = 'open') => ({ url: `u${number}`, number, state });

beforeEach(() => {
  conn.byNumber = null; conn.byBranch = null; conn.byCommit = null; conn.detect = null; conn.calls = []; conn.lastArgs = {};
  git.branch = 'real-branch'; git.sha = 'sha-current'; git.aheadCount = '1';
  repos.value = {}; // no state leaks into the ladder tests, which never touch getProjectRepos
  recordPushSpy.mockClear(); // module-scope spy: a stale call would satisfy the wrong test
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

  it('tier 2: branch rename - resolves by the live HEAD branch, not the stored slug', async () => {
    // The agent renamed the worktree branch after creation (team branch
    // conventions): tasks.branch_name is the old slug, but the worktree's live
    // HEAD is the renamed branch, and the PR exists only for the renamed branch.
    // Tier 2 must query the live HEAD, never the stored slug.
    git.branch = 'renamed-branch';
    conn.byBranch = resolved(123, 'open');
    const task = makeTask({ branch_name: 'old-slug', worktree_path: '/wt', pr_number: null });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(123);
    expect(conn.calls).toEqual(['byBranch']);
    // The load-bearing assertion: the renamed branch was queried, not the slug.
    expect(conn.lastArgs.byBranch?.[1]).toBe('renamed-branch');
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

  it('preserveLinkOnNotFound: a link-time resolve never clears the write that fired it', async () => {
    // The counterpart to the clear above. A link-time resolve exists to FILL IN
    // the state of a link that was just written; if the URL names a PR this repo
    // cannot resolve (typo, cross-repo, private), clearing here would delete what
    // the user typed in the same breath as the save. The link stays with a null
    // state, and the non-force sweep clears it on a later pass if it is bogus.
    conn.byNumber = null;
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({ pr_number: 240, pr_url: 'u240', pr_state: null, worktree_path: null, head_sha: null, branch_name: null });
    const deps = depsFor(task, { updateSpy, preserveLinkOnNotFound: true });
    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('not-found');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deps.onLinked).not.toHaveBeenCalled();
    expect(result.task?.pr_number).toBe(240);
    expect(result.task?.pr_url).toBe('u240');
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

/**
 * A PR URL in the task DESCRIPTION is not an anchor. A URL cited as background
 * ("this follows on from <url>") is textually identical to one naming the task's
 * own PR, so scraping prose stamped citations onto unrelated tasks. A review task
 * names its PR through the structured pr_url / pr_number fields instead, which
 * lands on Tier 1.
 *
 * `CITED_PR_URL` is deliberately a real, well-formed PR URL: the point of each
 * case is that the linker sees it and still ignores it.
 */
describe('linkPRForTask description PR URLs are never an anchor', () => {
  const CITED_PR_URL = 'https://github.com/o/r/pull/9';
  const CITING_DESCRIPTION = `Follows on from the previous task, branch \`own-the-icons-e1547bbf\`, PR ${CITED_PR_URL}.`;

  it('the code-review shape resolves by pr_number, not by the base-tip commit', async () => {
    // The shape tier 0 was originally written for: a review worktree branched
    // from base with no commits of its own, so its HEAD is base's tip. The
    // commits-ahead-of-base guard now blocks the commit tier there, and the PR
    // the task is reviewing is named by pr_number rather than scraped from prose.
    git.aheadCount = '0';
    git.branch = 'code-review-32-1dbcebe5';
    conn.byNumber = resolved(32, 'open');
    conn.byCommit = resolved(702, 'merged'); // what base's tip would have magneted onto
    const task = makeTask({
      pr_number: 32,
      branch_name: 'code-review-32-1dbcebe5',
      head_sha: 'base-tip',
      description: `Review ${CITED_PR_URL}`,
    });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(32);
    expect(result.task?.pr_state).toBe('open');
    expect(conn.calls).not.toContain('byCommit');
  });

  it('regression: a cited PR URL with no git state is no-anchor, not a link', async () => {
    // The mislink this rule exists for: a task that was never started, citing a
    // sibling task's PR as background. No pr_number, branch, head_sha, or
    // worktree - nothing to resolve from, whatever the description mentions.
    const updateSpy = vi.fn();
    const task = makeTask({
      pr_number: null, branch_name: null, head_sha: null, worktree_path: null,
      description: CITING_DESCRIPTION,
    });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('no-anchor');
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pr_url).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(conn.calls).toEqual([]); // the resolver was never consulted
  });

  it('recovery: an already-mislinked task is cleared once its git anchors find no PR', async () => {
    // The stuck row the mislink leaves behind: pr_number/url/state all pointing
    // at the cited PR. With the description inert, every tier returns null, so
    // the confident-not-found clear finally fires and all three fields go null.
    conn.byNumber = null;   // the cited PR is not this task's, and the number no longer resolves for it
    conn.byBranch = null;   // no PR exists for this task's own branch
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({
      pr_number: 9, pr_url: CITED_PR_URL, pr_state: 'merged',
      branch_name: 're-review-the-icons-bf9efd2b',
      description: CITING_DESCRIPTION,
    });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: null, pr_url: null, pr_state: null }));
  });

  it('a manually-set pr_number is cleared when it cannot be confirmed, even with a URL in the description', async () => {
    // Deliberate consequence of the description being inert: a stored number that
    // resolves to nothing is a broken link and is cleared, rather than being
    // silently re-supplied from prose. This is the one case where the failure
    // mode is a badge that disappears rather than one that never appears.
    git.aheadCount = '0'; // review shape: commit tier blocked
    conn.byNumber = null; // gh ran cleanly and matched nothing
    conn.byBranch = null;
    const task = makeTask({
      pr_number: 9, pr_url: CITED_PR_URL, pr_state: 'open',
      head_sha: 'base-tip',
      description: CITING_DESCRIPTION,
    });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('not-found');
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pr_url).toBeNull();
    expect(result.task?.pr_state).toBeNull();
  });

  it('degrades rather than clearing when the resolver is unavailable', async () => {
    // A degraded resolve must never be mistaken for a confident not-found: the
    // existing link survives, and the description is not consulted as a fallback.
    conn.byNumber = new PRResolverUnavailableError('gh CLI not found');
    const updateSpy = vi.fn();
    const task = makeTask({
      pr_number: 60, pr_url: 'u60', pr_state: 'open',
      worktree_path: null, description: CITING_DESCRIPTION,
    });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy })); // no getScrollback -> nothing to scrape
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/gh/i);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_number).toBe(60);
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

/**
 * `linkPR` is the IPC-side wrapper every real caller (TASK_UPDATE's link-time
 * resolve, the kebab refresh, MCP link_pr) goes through. Every other test in
 * this file calls `linkPRForTask` directly, so a forwarding bug where the
 * wrapper resolves the project/task but drops an option on its way to the
 * backbone would ship with the whole suite green. These two tests exercise the
 * real `linkPR` and assert the EFFECT (does the link survive), not just that a
 * property was passed along, so a dropped `preserveLinkOnNotFound` forward is
 * caught by an actual wrong write, not a mock-call inspection that could pass
 * against a stub that never clears for unrelated reasons.
 */
describe('linkPR (IPC wrapper): preserveLinkOnNotFound reaches the backbone', () => {
  function contextFor(task: Task, updateSpy: ReturnType<typeof vi.fn>): IpcContext {
    repos.value = { tasks: { getById: () => task, update: updateSpy } as never };
    return {
      currentProjectId: 'proj-1',
      projectRepo: { getById: () => ({ id: 'proj-1', path: '/repo' }) },
      configManager: { getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardEvents: { emitBoardChanged: vi.fn() },
      sessionManager: { getSessionProjectId: () => null },
    } as never;
  }

  it('preserveLinkOnNotFound: the wrapper does not clear the write that fired it', async () => {
    // Mirrors the linkPRForTask-level test above (line ~195), but through the
    // real linkPR wrapper: the resolver cleanly matches nothing, and no other
    // tier can fire (no worktree, no sha, no branch), so the only question is
    // whether the option survived the project/task resolution on its way in.
    conn.byNumber = null;
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({
      pr_number: 240, pr_url: 'u240', pr_state: null,
      worktree_path: null, head_sha: null, branch_name: null,
    });
    const context = contextFor(task, updateSpy);

    const result = await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true, preserveLinkOnNotFound: true });

    expect(result.status).toBe('not-found');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_number).toBe(240);
    expect(result.task?.pr_url).toBe('u240');
  });

  it('without preserveLinkOnNotFound the wrapper still clears (proves the assertion above is not vacuous)', async () => {
    // Same setup, option omitted. If this ever stopped clearing too, the test
    // above would pass for the wrong reason (a stub/wrapper that never clears
    // regardless of the option), so this negative case is load-bearing.
    conn.byNumber = null;
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({
      pr_number: 240, pr_url: 'u240', pr_state: null,
      worktree_path: null, head_sha: null, branch_name: null,
    });
    const context = contextFor(task, updateSpy);

    const result = await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: null, pr_url: null, pr_state: null }));
    expect(result.task?.pr_number).toBeNull();
  });
});

/**
 * The wrapper's `onLinked` notification, which the toast-storm fix rewrote.
 *
 * Two independent regressions are pinned here because they live on the same
 * three lines:
 *   1. It must push the QUIET `task:prLinkChanged`, never `task:updatedByAgent`.
 *      Every caller reaching linkPR is the app reconciling a link on its own (the
 *      refresh sweep, autoLinkPRForTask, a pr-candidate hit, the task-detail
 *      "Link / refresh PR" control), so a toast there announced agent news for
 *      work no agent did - and a sweep touching N tasks raised N toasts.
 *   2. It must go through `sendToRenderer`, so the push reaches `recordPush`.
 *      The old raw `webContents.send` bypassed the recorder entirely, which is
 *      why these toasts left no trace in ipc-*.jsonl.
 *
 * The board event is asserted alongside because it must NOT go quiet with the
 * toast: the monitor and the mobile bridge's board-event bus both consume it.
 */
describe('linkPR (IPC wrapper): onLinked notifies quietly and is recorded', () => {
  function contextFor(task: Task, updateSpy: ReturnType<typeof vi.fn>) {
    const send = vi.fn();
    const emitBoardChanged = vi.fn();
    repos.value = { tasks: { getById: () => task, update: updateSpy } as never };
    const context = {
      currentProjectId: 'proj-1',
      projectRepo: { getById: () => ({ id: 'proj-1', path: '/repo' }) },
      configManager: { getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) },
      mainWindow: { isDestroyed: () => false, webContents: { send } },
      boardEvents: { emitBoardChanged },
      sessionManager: { getSessionProjectId: () => null },
    } as never as IpcContext;
    return { context, send, emitBoardChanged };
  }

  it('a newly linked PR pushes task:prLinkChanged (not task:updatedByAgent), records it, and still emits the board event', async () => {
    conn.byNumber = { url: 'https://github.com/o/r/pull/7', number: 7, state: 'open' };
    const updateSpy = vi.fn((patch: Partial<Task>) => ({ ...makeTask({ pr_number: 240 }), ...patch }) as Task);
    const task = makeTask({
      pr_number: 240, pr_url: 'u240', pr_state: null,
      worktree_path: null, head_sha: null, branch_name: null,
    });
    const { context, send, emitBoardChanged } = contextFor(task, updateSpy);

    await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(send).toHaveBeenCalledTimes(1);
    const [channel, ...args] = send.mock.calls[0];
    expect(channel).toBe(IPC.TASK_PR_LINK_CHANGED);
    // Payload is the bare projectId, mirroring task:sessionResync. Asserted so a
    // future widening to (id, title, projectId) cannot silently re-tempt a toast.
    expect(args).toEqual(['proj-1']);

    // Revert proof: restoring the raw `context.mainWindow.webContents.send(...)`
    // reds this line while leaving the channel assertions above green.
    expect(recordPushSpy).toHaveBeenCalledWith(IPC.TASK_PR_LINK_CHANGED, ['proj-1']);

    // Must NOT go quiet with the toast - other main-process consumers need it.
    expect(emitBoardChanged).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', change: 'task-updated', ids: [task.id] }),
    );
  });

  it('the prCleared branch notifies on the same quiet channel', async () => {
    // The second onLinked call site (a stale link the sweep cleared). It is the
    // sweep noticing its own housekeeping, so it is quiet for the same reason -
    // and a test that only covered the "linked" branch would miss it entirely.
    conn.byNumber = null;
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({
      pr_number: 240, pr_url: 'u240', pr_state: 'open',
      worktree_path: null, head_sha: null, branch_name: null,
    });
    const { context, send } = contextFor(task, updateSpy);

    const result = await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(IPC.TASK_PR_LINK_CHANGED, 'proj-1');
  });

  it('a destroyed main window records the push as dropped instead of throwing', async () => {
    // The old hand-rolled `if (!isDestroyed())` guard simply skipped the send and
    // left no trace. Routing through sendToRenderer means a lost push is still
    // recorded with a PushDropped marker.
    conn.byNumber = { url: 'https://github.com/o/r/pull/7', number: 7, state: 'open' };
    const updateSpy = vi.fn((patch: Partial<Task>) => ({ ...makeTask({ pr_number: 240 }), ...patch }) as Task);
    const task = makeTask({
      pr_number: 240, pr_url: 'u240', pr_state: null,
      worktree_path: null, head_sha: null, branch_name: null,
    });
    const { context, send } = contextFor(task, updateSpy);
    (context.mainWindow as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;

    await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(send).not.toHaveBeenCalled();
    expect(recordPushSpy).toHaveBeenCalledWith(IPC.TASK_PR_LINK_CHANGED, ['proj-1'], { dropped: true });
  });
});
