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
  /**
   * `for-each-ref --points-at=<sha>` output: FULL refnames, one per line. Empty
   * by default so every pre-existing test keeps its exact resolver call
   * sequence - Tier 6 bails on an empty candidate set without touching a
   * connector.
   */
  pointsAtRefs: [] as string[],
  /** Every `raw` argv, so a test can assert a tier did NOT read the refs. */
  rawCalls: [] as string[][],
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
  // Every call's args. Tier 6 can query more than one branch in a single
  // resolve, so `lastArgs` alone cannot prove which names were asked about.
  allArgs: {} as Record<string, unknown[][]>,
  /**
   * Whether the owning connector declares that its commit resolver proves
   * ownership. True by default because both shipped connectors do; a test flips
   * it to exercise the tightening a future connector would get by omission.
   */
  selfVerifiesCommits: true,
}));

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    revparse: async (args: string[]) => (args.includes('--abbrev-ref') ? (git.branch ?? 'HEAD') : git.sha),
    raw: async (args: string[]) => {
      git.rawCalls.push(args);
      // Discriminate by VERB, not by arity: both reads go through `raw`, and a
      // single catch-all string made the ref read indistinguishable from the
      // commits-ahead-of-base count.
      if (args[0] === 'for-each-ref') {
        return git.pointsAtRefs.length > 0 ? `${git.pointsAtRefs.join('\n')}\n` : '';
      }
      return git.aheadCount;
    },
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

// The pull_request adoption signal, so a describe block below can assert it
// fires on a real link only, not on the automatic sweeps this file already
// exercises (a cleared stale link, or an unchanged re-resolve).
const trackFeatureUsedSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: trackFeatureUsedSpy }));

vi.mock('../../src/main/pr/pr-registry', async () => {
  // Re-export the REAL error classes rather than redeclaring them. The ladder
  // now defers a degrade at one tier so later tiers still run, and that
  // deferral (`createDeferredDegrade` in shared/pr-dispatch.ts) recognizes a
  // degrade by `instanceof` against shared/pr-errors. Local look-alike classes
  // would fail that check, so a deferred error would rethrow immediately and
  // the deferral would be silently untestable here.
  const { PRResolverUnavailableError, PRResolverTransientError } = await import(
    '../../src/main/pr/shared/pr-errors'
  );
  const make = (key: 'byNumber' | 'byBranch' | 'byCommit') => async (...args: unknown[]) => {
    conn.calls.push(key);
    conn.lastArgs[key] = args;
    conn.allArgs[key] = [...(conn.allArgs[key] ?? []), args];
    const value = conn[key];
    if (value instanceof Error) throw value;
    // A function stands in for a per-argument answer, which Tier 6 needs: it
    // queries several branches in one resolve, and the whole point is that the
    // stored slug misses while the pushed branch hits.
    const answer = typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value;
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  return {
    PRResolverUnavailableError,
    PRResolverTransientError,
    resolvePRByNumber: make('byNumber'),
    resolvePRForBranch: make('byBranch'),
    resolvePRByCommit: make('byCommit'),
    commitAnchorSelfVerifies: async () => conn.selfVerifiesCommits,
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
    pr_url: null, pr_state: null, head_sha: null, pushed_branch: null, resolved_base_branch: null, external_id: null, external_source: null,
    external_url: null, base_branch: 'main', use_worktree: 1, labels: [], priority: 0,
    model_override: null, effort_override: null, agent_override: null, attachment_count: 0,
    archived_at: null, created_at: 't', updated_at: 't', ...overrides,
  };
}

function depsFor(
  task: Task,
  opts: {
    updateSpy?: ReturnType<typeof vi.fn>;
    force?: boolean;
    preserveLinkOnNotFound?: boolean;
    defaultBaseBranch?: string;
  } = {},
) {
  const update = opts.updateSpy ?? vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
  return {
    tasks: { getById: () => task, update } as never,
    projectPath: '/repo',
    onLinked: vi.fn(),
    force: opts.force ?? true, // ladder tests bypass the throttle unless they're testing it
    preserveLinkOnNotFound: opts.preserveLinkOnNotFound,
    defaultBaseBranch: opts.defaultBaseBranch,
  };
}

const resolved = (number: number, state = 'open') => ({ url: `u${number}`, number, state });

/**
 * A REAL object name. Tier 6's ref read refuses a non-hex sha unread, so the
 * `sha-current` placeholder the older tests use skips that tier entirely - which
 * is exactly why they kept their original call sequences when it was added.
 */
const HEX_SHA = '8eff97af1b3753bac423e2f225539f1e36dc12a6';
const readRefs = () => git.rawCalls.filter((args) => args[0] === 'for-each-ref');
/** Every branch name any tier asked the branch resolver about. */
const queriedBranches = () => (conn.allArgs.byBranch ?? []).map((args) => args[1]);

beforeEach(() => {
  conn.byNumber = null; conn.byBranch = null; conn.byCommit = null; conn.detect = null; conn.calls = [];
  conn.lastArgs = {}; conn.allArgs = {}; conn.selfVerifiesCommits = true;
  git.branch = 'real-branch'; git.sha = 'sha-current'; git.aheadCount = '1';
  git.pointsAtRefs = []; git.rawCalls = [];
  repos.value = {}; // no state leaks into the ladder tests, which never touch getProjectRepos
  recordPushSpy.mockClear(); // module-scope spy: a stale call would satisfy the wrong test
  trackFeatureUsedSpy.mockClear();
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

  it('tier 6: links via the REMOTE branch whose tip is the task HEAD when the pushed name diverges', async () => {
    // The filed bug (AKWISE #15). The local worktree branch is the Kangentic
    // slug; the branch actually pushed, and used as the PR source, is
    // `maint/adopt-central-package-management`. Nothing reconciled the two, so:
    // tier 1 has no number, tiers 2/4 query the slug and miss, and tier 3 is
    // gated off because the PR already merged into base (0 commits ahead).
    git.branch = 'adopt-central-packag-f07d8383';
    // A REAL object name: the ref read refuses a non-hex sha unread, so the
    // placeholder the other tests use would skip this tier entirely.
    git.sha = '8eff97af1b3753bac423e2f225539f1e36dc12a6';
    git.aheadCount = '0';
    git.pointsAtRefs = [
      'refs/heads/adopt-central-packag-f07d8383',
      'refs/remotes/origin/maint/adopt-central-package-management',
    ];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'maint/adopt-central-package-management' ? resolved(1369, 'merged') : null);
    const task = makeTask({ branch_name: 'adopt-central-packag-f07d8383', base_branch: 'develop' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(1369);
    // The load-bearing assertion: the PUSHED branch was queried, not the slug.
    expect(conn.lastArgs.byBranch?.[1]).toBe('maint/adopt-central-package-management');
    // And the identity is recorded, so the next resolve does not depend on the
    // remote ref still pointing at exactly this sha.
    expect(result.task?.pushed_branch).toBe('maint/adopt-central-package-management');
  });

  it('tier 6: bails when a REMOTE base points at the sha (fresh worktree on base tip)', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/develop', 'refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = makeTask({ base_branch: 'develop' });
    const result = await linkPRForTask(task.id, depsFor(task));
    // Only tier 2's own query. The candidate at the base tip is never asked about.
    expect(queriedBranches()).toEqual(['real-branch']);
    expect(result.status).toBe('not-found');
  });

  it('tier 6: bails when the LOCAL base points at the sha (worktree cut from a stale local base)', async () => {
    // Offline, `origin/<base>` has moved on and does not point at the sha, but
    // refs/heads/<base> still does. Red-green for scanning refs/heads/ at all.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/heads/develop', 'refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = makeTask({ base_branch: 'develop' });
    await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).toEqual(['real-branch']);
  });

  it('tier 6: bails on a remote HEAD symref, and never queries `origin` or `HEAD` as a branch', async () => {
    // `%(refname:short)` renders refs/remotes/origin/HEAD as the bare remote
    // name, which is not a branch. It also proves the sha is the default
    // branch's tip, whatever base_branch claims - here deliberately not 'main'.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = makeTask({ base_branch: 'develop' });
    await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).not.toContain('origin');
    expect(queriedBranches()).not.toContain('HEAD');
    expect(queriedBranches()).toEqual(['real-branch']);
  });

  it('tier 6: skips the branch tier 2 already tried, and dedupes one branch across two remotes', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = [
      'refs/remotes/origin/real-branch', // tier 2 queried this already
      'refs/remotes/origin/pushed-name',
      'refs/remotes/upstream/pushed-name', // same branch, second remote
    ];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'pushed-name' ? resolved(88) : null);
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(88);
    expect(queriedBranches()).toEqual(['real-branch', 'pushed-name']);
  });

  it('tier 6: refuses an option-shaped branch name', async () => {
    // git permits a leading dash in a ref name, and a resolver would parse it as
    // an option rather than a branch.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/--output=pwned', 'refs/remotes/origin/ok-branch'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'ok-branch' ? resolved(89) : null);
    const task = makeTask();
    await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).not.toContain('--output=pwned');
  });

  it('tier 6: gives up rather than fanning out when more than two branches share the tip', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/a', 'refs/remotes/origin/b', 'refs/remotes/origin/c'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'real-branch' ? null : resolved(90));
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).toEqual(['real-branch']);
    expect(result.status).toBe('not-found');
  });

  it('tier 6: two branches resolving to DIFFERENT PRs is ambiguous, so it does not guess', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/one', 'refs/remotes/origin/two'];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'one' ? resolved(91) : branch === 'two' ? resolved(92) : null);
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('not-found');
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pushed_branch).toBeNull();
  });

  it('tier 6: two branches resolving to the SAME PR is not ambiguous and links', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/one', 'refs/remotes/origin/two'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'real-branch' ? null : resolved(93));
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(93);
  });

  it('tier 6: a degrade inside it still surfaces and preserves the existing link', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/pushed-name'];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'pushed-name' ? new PRResolverUnavailableError('gh CLI not found') : null);
    const task = makeTask({ pr_number: 77, pr_url: 'u77', pr_state: 'open' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('resolver-unavailable');
    expect(result.task?.pr_number).toBe(77);
  });

  it('tier 6: still records the branch it established when the resolver degrades', async () => {
    // The identity is proven by LOCAL git state - a remote tip equal to HEAD,
    // that tip is not base's, and the task has commits of its own - none of
    // which a provider outage says anything about. Dropping it here loses it in
    // exactly the window the capture rule exists for: `gh` comes back after the
    // task has committed past the pushed tip, and by then no remote ref matches
    // `head_sha` any more, so Tier 6 is quiet for good.
    git.sha = HEX_SHA;
    git.aheadCount = '1';
    git.pointsAtRefs = ['refs/remotes/origin/maint/pushed-name'];
    conn.byBranch = new PRResolverUnavailableError('gh CLI not found');
    const task = makeTask({ base_branch: 'main' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('resolver-unavailable');
    expect(result.task?.pushed_branch).toBe('maint/pushed-name');
  });

  it('tier 6: records the pushed branch even when no PR exists yet, if the task has commits of its own', async () => {
    // The agent pushes the branch BEFORE opening the PR. Waiting for a PR to
    // appear loses the identity, because the task may commit past the pushed tip
    // first and then no remote ref matches head_sha at all.
    git.sha = HEX_SHA;
    git.aheadCount = '1';
    git.pointsAtRefs = ['refs/remotes/origin/maint/pushed-name'];
    conn.byBranch = null;
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('not-found');
    expect(result.task?.pushed_branch).toBe('maint/pushed-name');
  });

  it('tier 6: never re-queries the branch tier 5 already tried', async () => {
    // The `name !== task.pushed_branch` half of the candidate filter. Tier 5
    // asks about the recorded branch and misses; without this half Tier 6 asks
    // the provider the identical question a second time in the same resolve,
    // which on Azure is a second one-second `az` cold start per sweep.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/maint/pushed-name'];
    conn.byBranch = null;
    const task = makeTask({ pushed_branch: 'maint/pushed-name' });
    await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches().filter((name) => name === 'maint/pushed-name')).toHaveLength(1);
  });

  it('tier 6: links from the one candidate that resolves when a second one does not', async () => {
    // Two branches share the tip, only one carries a PR. The distinct-number
    // check is over the HITS, not the candidates, so a single hit among several
    // candidates is unambiguous and must link - and must record the branch that
    // actually answered, not whichever the ref read listed first.
    git.sha = HEX_SHA;
    git.pointsAtRefs = [
      'refs/remotes/origin/stale-mirror',
      'refs/remotes/origin/maint/pushed-name',
    ];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'maint/pushed-name' ? resolved(97) : null);
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(97);
    expect(result.task?.pushed_branch).toBe('maint/pushed-name');
  });

  it('tier 6: does NOT record a branch for a task with no commits of its own (follow-on task shape)', async () => {
    // Task B cut from task A's branch with zero commits sits on A's tip.
    // Recording A's branch on B would let tier 5 link A's PR to B permanently.
    git.sha = HEX_SHA;
    git.aheadCount = '0';
    git.pointsAtRefs = ['refs/remotes/origin/task-a-branch'];
    conn.byBranch = null;
    const task = makeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pushed_branch).toBeNull();
  });

  it('tier 5: resolves from the recorded pushed branch without reading refs at all', async () => {
    // The durable half. Once recorded it survives the task committing past the
    // pushed tip, and the remote branch being deleted after the merge.
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'maint/pushed-name' ? resolved(94) : null);
    const task = makeTask({ pushed_branch: 'maint/pushed-name' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(94);
    expect(readRefs()).toHaveLength(0);
  });

  it('tier 6: never reads refs when a stronger tier already answered', async () => {
    // Cost guard. The ref read is per-task on every sweep, so a tier-2 hit must
    // not pay for it.
    conn.byBranch = resolved(95);
    const task = makeTask();
    await linkPRForTask(task.id, depsFor(task));
    expect(readRefs()).toHaveLength(0);
  });

  it('tier 6: never reads refs when there is no sha to anchor on', async () => {
    const task = makeTask({ worktree_path: null, head_sha: null });
    await linkPRForTask(task.id, depsFor(task));
    expect(readRefs()).toHaveLength(0);
  });

  it('tier 3: skips the commit anchor when the owning connector does not vouch for commit ownership', async () => {
    // The linker's commits-ahead-of-base gate is a filter, not a proof: it
    // measures against a base the task may never have recorded and cannot see a
    // PR that merely INHERITED the commit. So the connector has to vouch, and a
    // future one that omits the declaration loses the tier rather than silently
    // relying on that gate. Red-green: with the tightening removed, byCommit is
    // called and PR 704 is linked to a task no connector vouched for.
    conn.selfVerifiesCommits = false;
    conn.byCommit = resolved(704, 'merged');
    const task = makeTask({ worktree_path: null, head_sha: 'sha-stored' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(conn.calls).not.toContain('byCommit');
    expect(result.task?.pr_number).toBeNull();
  });

  it('tier 6: measures the base-tip bail against resolved_base_branch when no base was chosen', async () => {
    // base_branch is NULL for most tasks (nothing infers it), so without the
    // recorded resolution the bail would measure against the project default
    // and `develop` would look like an ordinary candidate. Red-green: if the
    // ladder ignores resolved_base_branch, `develop` gets queried as a PR
    // source branch, which is the magnet this guard exists to stop.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/develop', 'refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = makeTask({ base_branch: null, resolved_base_branch: 'develop' });
    await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).not.toContain('develop');
    expect(queriedBranches()).toEqual(['real-branch']);
  });

  it('tier 6: an empty base_branch falls through to resolved_base_branch, not a hardcoded default (|| not ??)', async () => {
    // Same shape as the resolved_base_branch test above, but with base_branch set
    // to '' instead of left null - the only input that distinguishes `||` from
    // `??` for the baseBranch fallthrough. Under `??`, '' is not nullish and
    // wins outright, so the bail below measures against '' instead of 'develop'
    // and 'develop' gets queried as an ordinary candidate branch. Red-green:
    // swapping that `||` chain to `??` flips this test to a query.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/develop', 'refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = makeTask({ base_branch: '', resolved_base_branch: 'develop' });
    await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).not.toContain('develop');
    expect(queriedBranches()).toEqual(['real-branch']);
  });

  it('tier 6: a recorded resolved_base_branch is enough to make the base known', async () => {
    // The companion to the bail above: with a base recorded, the tier is alive
    // for a task that chose no base explicitly and whose project config the
    // caller did not supply.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/maint/pushed-name'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'maint/pushed-name' ? resolved(96) : null);
    const task = makeTask({ base_branch: null, resolved_base_branch: 'develop' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(96);
  });

  it('tier 6: bails when the base branch is unknown, since the base-tip guard cannot fire', async () => {
    // Without a base, a fresh worktree on the base tip is indistinguishable from
    // a task whose work was pushed elsewhere, so the tier declines to run.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = makeTask({ base_branch: null });
    await linkPRForTask(task.id, depsFor(task));
    expect(readRefs()).toHaveLength(0);
  });

  it('tier 6: an empty defaultBaseBranch does not count as a known base (|| not != null)', async () => {
    // Same shape as the "unknown base" test above, but with the LAST layer set
    // to '' instead of left undefined - the only input that distinguishes `||`
    // from `!= null` for baseBranchIsKnown. Under `!= null`, '' reports the base
    // as known, and tier 6 would then measure its bail against 'main', the
    // hardcoded guess baseBranch itself falls through to when every real layer
    // is absent. Red-green: reverting baseBranchIsKnown to `!= null` flips this
    // test to a ref read.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = makeTask({ base_branch: null });
    await linkPRForTask(task.id, depsFor(task, { defaultBaseBranch: '' }));
    expect(readRefs()).toHaveLength(0);
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

  /**
   * A tier that cannot CHECK must not discard the tiers below it. The registry
   * now throws when no connector owns the repo's remote, or when the owner has
   * no resolver of that kind, so without the deferral one such throw would kill
   * every later tier - including the slug tier, which is the last chance for a
   * task with no worktree.
   */
  it('a degraded tier does not abort the ladder: a later tier still resolves', async () => {
    conn.byNumber = new PRResolverUnavailableError('az missing');
    conn.byCommit = resolved(70, 'merged');
    const task = makeTask({ pr_number: 70, worktree_path: null, head_sha: 'sha-current' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(conn.calls).toContain('byCommit');
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(70);
  });

  it('rethrows the deferred degrade when no tier resolves, so degradeStatus is still set', async () => {
    conn.byNumber = new PRResolverUnavailableError('az missing');
    conn.byCommit = null;
    const task = makeTask({ pr_number: 71, worktree_path: null, head_sha: 'sha-current' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/az missing/);
  });

  // Both classes block the clear identically; the transient is the more
  // informative message, so it is the one reported.
  it('reports a transient over an unavailable when both tiers degraded', async () => {
    conn.byNumber = new PRResolverUnavailableError('az missing');
    conn.byCommit = new PRResolverTransientError('HTTP 503');
    const task = makeTask({ pr_number: 72, worktree_path: null, head_sha: 'sha-current' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('transient-error');
  });

  /**
   * RED-GREEN for the `resolveFailed` guard. An UNEXPECTED exception is not a
   * clean "there is no PR", so it must not clear the link. Before the guard the
   * generic catch left `degradeStatus` undefined and `prCleared` fired.
   */
  it('an unexpected resolver error never clears an existing link', async () => {
    conn.byNumber = new TypeError('connector bug');
    const updateSpy = vi.fn();
    const task = makeTask({ pr_number: 73, pr_url: 'u73', pr_state: 'open', worktree_path: null });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_url).toBe('u73');
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
 * `linkPR`'s board-config-first base resolution:
 *   defaultBaseBranch = boardConfigManager.getDefaultBaseBranchForPath(projectPath)
 *     || configManager.getEffectiveConfig(projectPath).git.defaultBaseBranch
 * Every other `linkPR` test's context omits `boardConfigManager` entirely, so the
 * property access throws inside the wrapper's try/catch and `defaultBaseBranch`
 * is always undefined there - the board-wins ordering has never reached a real
 * value. This proves it does by observing where it lands in the ladder: tier 6's
 * base-tip bail, which only fires when the base it is handed actually matches a
 * ref.
 */
describe('linkPR (IPC wrapper): board config default base branch wins over project config', () => {
  it('the board config base branch reaches the ladder ahead of the project config default', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/develop'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'develop' ? resolved(555) : null);
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = makeTask({
      pr_number: null, base_branch: null, resolved_base_branch: null,
      worktree_path: null, branch_name: null, head_sha: HEX_SHA,
    });
    repos.value = { tasks: { getById: () => task, update: updateSpy } as never };
    const context = {
      currentProjectId: 'proj-1',
      projectRepo: { getById: () => ({ id: 'proj-1', path: '/repo' }) },
      boardConfigManager: { getDefaultBaseBranchForPath: () => 'develop' },
      configManager: { getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardEvents: { emitBoardChanged: vi.fn() },
      sessionManager: { getSessionProjectId: () => null },
    } as never as IpcContext;

    const result = await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    // 'develop' is recognized as the base (the board config value, not 'main'),
    // so tier 6's base-tip bail fires and never queries it as a candidate
    // branch. Red-green: reverting the board-config-first expression to
    // config-only leaves the base as 'main', the bail does not fire, 'develop'
    // is queried, resolves to PR 555, and both assertions below fail.
    expect(queriedBranches()).toEqual([]);
    expect(result.status).toBe('not-found');
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

/**
 * The `pull_request` adoption signal fires only on a REAL link (`prChanged &&
 * next`), never on the automatic sweeps that return early with no match, and
 * never on the stale-link clear that runs in the same function. Each case
 * below reuses a scenario already proven above by its status/write
 * assertions, so this only has to add the analytics assertion.
 */
describe('linkPRForTask: pull_request adoption signal fires on a real link only', () => {
  it('fires once when a PR is newly linked', async () => {
    conn.byNumber = resolved(10);
    const task = makeTask({ pr_number: 99, head_sha: 'sha' });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('linked');
    expect(trackFeatureUsedSpy).toHaveBeenCalledTimes(1);
    expect(trackFeatureUsedSpy).toHaveBeenCalledWith('pull_request');
  });

  it('never fires when a stale link is cleared (the sweep noticing its own housekeeping)', async () => {
    conn.byNumber = null;
    const task = makeTask({ pr_number: 99, pr_url: 'u99', pr_state: 'merged', worktree_path: null, head_sha: null, branch_name: null });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('not-found');
    expect(trackFeatureUsedSpy).not.toHaveBeenCalled();
  });

  it('never fires when the resolved PR is already current (no write at all)', async () => {
    conn.byNumber = resolved(50, 'open');
    const task = makeTask({ pr_number: 50, pr_url: 'u50', pr_state: 'open', worktree_path: null });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('unchanged');
    expect(trackFeatureUsedSpy).not.toHaveBeenCalled();
  });
});
