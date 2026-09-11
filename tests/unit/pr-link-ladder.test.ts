import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task } from '../../src/shared/types';

/**
 * Unit tests for the confidence ladder in linkPRForTask: which anchor
 * wins (pr_number -> worktree branch -> commit SHA -> stored branch -> pushed
 * branch -> remote tip), write-only-on-change, the TTL coalesce + terminal-skip
 * throttle (force bypasses), and transient-error surfacing that preserves an
 * existing link.
 *
 * The connectors, simple-git, and project-repos are mocked so the core logic is
 * tested in isolation (no gh CLI, no native DB).
 *
 * Every task is built by one of the builders below, each of which produces a
 * state the product actually writes. The suite once handed the ladder
 * `worktree_path: null` with `branch_name: 'slug'` and `use_worktree: 1` and
 * called that "no worktree"; that pairing exists only after a Done move
 * captures the branch, and a task created with `useWorktree: false` (which has
 * no branch, no sha, and until the push capture no anchor at all) was never
 * tested. The tiers written for it passed against inputs the app cannot
 * produce.
 */

const git = vi.hoisted(() => ({
  branch: 'real-branch' as string | null,
  sha: 'sha-current' as string | null,
  /** Every `revparse` call, so a test can prove a no-worktree task never read a HEAD. */
  revparseCalls: 0,
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
    revparse: async (args: string[]) => {
      git.revparseCalls += 1;
      return args.includes('--abbrev-ref') ? (git.branch ?? 'HEAD') : git.sha;
    },
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
// Those wrapper stubs carry only `getById` and `update`: none of them produces
// a Tier 3 or Tier 6 hit, which is the only moment the ladder calls the holder
// lookups (`listByPRNumber` / `listByBranchOrPushedBranch`). A wrapper test
// that does reach a hit must add both, or the missing method throws into the
// generic catch and reads as `resolveFailed` rather than failing visibly.
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

import { linkPRForTask, linkPR, autoLinkPRForTask, recordPushedBranchForSession, cancelPendingVerdictRepolls } from '../../src/main/pr/pr-linking';
import { PRResolverUnavailableError, PRResolverTransientError } from '../../src/main/pr/pr-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { IPC } from '../../src/shared/ipc-channels';

/**
 * The columns that describe a task's git state. No test sets them directly:
 * each builder below fills them for ONE producible state, and `baseTask`
 * throws on an override naming any of them, so an impossible combination
 * cannot be constructed. Tests are not typechecked, so the guard is runtime.
 */
const ANCHOR_COLUMNS = [
  'use_worktree', 'worktree_skip_reason', 'worktree_path', 'branch_name', 'head_sha', 'pushed_branch', 'resolved_base_branch',
] as const;
type AnchorColumn = (typeof ANCHOR_COLUMNS)[number];
type NonAnchorOverrides = Partial<Omit<Task, AnchorColumn>>;

let idCounter = 0;
function baseTask(overrides: NonAnchorOverrides): Task {
  for (const column of ANCHOR_COLUMNS) {
    if (column in overrides) {
      throw new Error(`fixture: "${column}" is an anchor column. Pick the builder for the state you mean instead of overriding it.`);
    }
  }
  idCounter += 1;
  return {
    id: `task-${idCounter}`, display_id: idCounter, title: 'T', description: '', swimlane_id: 'lane', position: 0,
    agent: null, session_id: null, worktree_path: null, worktree_folder: null, worktree_skip_reason: null,
    branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, head_sha: null, pushed_branch: null,
    resolved_base_branch: null, external_id: null, external_source: null, external_url: null, base_branch: 'main',
    use_worktree: null, labels: [], priority: 0, model_override: null, effort_override: null, agent_override: null,
    attachment_count: 0, archived_at: null, created_at: 't', updated_at: 't', ...overrides,
  } as Task;
}

/**
 * A task whose worktree is on disk. `branch_name` is the slug the worktree was
 * created on (an agent may have renamed the live HEAD since); `head_sha` is
 * whatever an earlier resolve backfilled; `pushed_branch` is whatever the
 * agent's push or Tier 6 recorded; `resolved_base_branch` is the base the
 * worktree was cut from, when `recordWorktree` observed one.
 */
function worktreeTask(
  anchors: { branch?: string; headSha?: string | null; pushedBranch?: string | null; resolvedBase?: string | null } = {},
  overrides: NonAnchorOverrides = {},
): Task {
  return {
    ...baseTask(overrides),
    use_worktree: 1,
    worktree_path: '/wt',
    worktree_folder: 'wt',
    branch_name: anchors.branch ?? 'slug',
    head_sha: anchors.headSha ?? null,
    pushed_branch: anchors.pushedBranch ?? null,
    resolved_base_branch: anchors.resolvedBase ?? null,
  };
}

/**
 * A task whose worktree directory is gone. With `branch` this is the Done
 * path: `deleteTaskWorktree` captured the live branch and sha before removal
 * and kept the base. Without it this is a reset (To Do, delete, the Backlog
 * sweep, a missing directory at startup): `branch_name` and the base go with
 * the checkout, the sha is captured when it could be read, and
 * `pushed_branch` survives either way (a remote fact).
 */
function reclaimedWorktreeTask(
  anchors: { branch?: string | null; headSha?: string | null; pushedBranch?: string | null; resolvedBase?: string | null } = {},
  overrides: NonAnchorOverrides = {},
): Task {
  return {
    ...baseTask(overrides),
    use_worktree: 1,
    worktree_path: null,
    worktree_folder: 'wt',
    branch_name: anchors.branch ?? null,
    head_sha: anchors.headSha ?? null,
    pushed_branch: anchors.pushedBranch ?? null,
    resolved_base_branch: anchors.resolvedBase ?? null,
  };
}

/**
 * A task created with `useWorktree: false`. It runs in the shared checkout, so
 * nothing reads a worktree HEAD for it: `head_sha` and `resolved_base_branch`
 * are always null. `branch_name` is set only when a `customBranchName` was
 * given at creation; `pushed_branch` only when its own `git push` was
 * recorded (or `kangentic_link_pr` was handed a `branch`).
 */
function noWorktreeTask(
  anchors: { customBranch?: string; pushedBranch?: string } = {},
  overrides: NonAnchorOverrides = {},
): Task {
  return {
    ...baseTask(overrides),
    use_worktree: 0,
    worktree_skip_reason: 'disabled',
    branch_name: anchors.customBranch ?? null,
    pushed_branch: anchors.pushedBranch ?? null,
  };
}

/** A task that has never spawned: every git column null, the worktree setting inherited. */
function unstartedTask(overrides: NonAnchorOverrides = {}): Task {
  return baseTask(overrides);
}

function depsFor(
  task: Task,
  opts: {
    updateSpy?: ReturnType<typeof vi.fn>;
    force?: boolean;
    bypassThrottle?: boolean;
    preserveLinkOnNotFound?: boolean;
    defaultBaseBranch?: string;
    /**
     * The OTHER tasks on the board, as the two holder lookups see them. Empty
     * by default so every pre-existing test keeps its answer: the inferred
     * tiers consult them only on a hit, and a board with no other task refuses
     * nothing. The resolving task itself may be listed here to prove the
     * lookup excludes it.
     */
    siblings?: Task[];
  } = {},
) {
  const update = opts.updateSpy ?? vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
  const siblings = opts.siblings ?? [];
  return {
    tasks: {
      getById: () => task,
      update,
      listByPRNumber: vi.fn((prNumber: number) => siblings.filter((sibling) => sibling.pr_number === prNumber)),
      listByBranchOrPushedBranch: vi.fn((branchName: string) =>
        siblings.filter((sibling) => sibling.branch_name === branchName || sibling.pushed_branch === branchName)),
    } as never,
    projectPath: '/repo',
    onLinked: vi.fn(),
    force: opts.force ?? true, // ladder tests bypass the throttle unless they're testing it
    bypassThrottle: opts.bypassThrottle,
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
  git.pointsAtRefs = []; git.rawCalls = []; git.revparseCalls = 0;
  repos.value = {}; // no state leaks into the ladder tests, which never touch getProjectRepos
  recordPushSpy.mockClear(); // module-scope spy: a stale call would satisfy the wrong test
  trackFeatureUsedSpy.mockClear();
});

describe('linkPRForTask confidence ladder', () => {
  it('tier 1: prefers pr_number over branch and commit', async () => {
    conn.byNumber = resolved(10); conn.byBranch = resolved(20); conn.byCommit = resolved(30);
    const task = worktreeTask({ headSha: 'sha' }, { pr_number: 99 });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(10);
    expect(conn.calls[0]).toBe('byNumber');
    expect(conn.calls).not.toContain('byBranch');
  });

  it('tier 2: worktree present resolves by the real HEAD branch', async () => {
    conn.byBranch = resolved(20);
    const task = worktreeTask();
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
    const task = worktreeTask({ branch: 'old-slug' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(123);
    expect(conn.calls).toEqual(['byBranch']);
    // The load-bearing assertion: the renamed branch was queried, not the slug.
    expect(conn.lastArgs.byBranch?.[1]).toBe('renamed-branch');
  });

  it('tier 3: no worktree but head_sha set resolves by commit', async () => {
    conn.byCommit = resolved(30, 'merged');
    const task = reclaimedWorktreeTask({ branch: 'slug', headSha: 'sha-stored' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(30);
    expect(result.task?.pr_state).toBe('merged');
    expect(conn.calls).toContain('byCommit');
  });

  it('tier 4: a reclaimed worktree with its branch captured on Done, and no readable sha, resolves by that branch', async () => {
    conn.byBranch = resolved(40);
    const task = reclaimedWorktreeTask({ branch: 'slug' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(40);
    expect(conn.calls).toContain('byBranch');
  });

  it('tier 4: a no-worktree task created with a custom branch resolves by that branch', async () => {
    // The one way `use_worktree = 0` carries a `branch_name`: a `customBranchName`
    // at creation, which `ensureTaskBranchCheckout` checks out in the shared tree.
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'feature/custom' ? resolved(41) : null);
    const task = noWorktreeTask({ customBranch: 'feature/custom' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(41);
    expect(conn.lastArgs.byBranch?.[1]).toBe('feature/custom');
    expect(git.revparseCalls).toBe(0);
  });

  it('tier 3: skips the commit anchor when the commit has no commits ahead of base', async () => {
    // HEAD is base's tip - a branchless worktree, or a single-parent rebase/squash
    // merge tip that a parent-count check would have missed. Not this task's work.
    git.aheadCount = '0';
    conn.byCommit = resolved(702, 'merged'); // the PR that owns base's tip - not this task's PR
    const task = reclaimedWorktreeTask({ headSha: 'base-tip' });
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
    const task = worktreeTask(); // worktree present, real HEAD branch, no pr_number
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(conn.calls).not.toContain('byCommit');
    expect(result.status).toBe('not-found');
    expect(result.task?.pr_number).toBeNull();
  });

  it('tier 6: links via the REMOTE branch whose tip is the task HEAD when the pushed name diverges', async () => {
    // The filed bug. The local worktree branch is the Kangentic
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
    const task = worktreeTask({ branch: 'adopt-central-packag-f07d8383' }, { base_branch: 'develop' });
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
    const task = worktreeTask({}, { base_branch: 'develop' });
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
    const task = worktreeTask({}, { base_branch: 'develop' });
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
    const task = worktreeTask({}, { base_branch: 'develop' });
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
    const task = worktreeTask();
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
    const task = worktreeTask();
    await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).not.toContain('--output=pwned');
  });

  it('tier 6: gives up rather than fanning out when more than two branches share the tip', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/a', 'refs/remotes/origin/b', 'refs/remotes/origin/c'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'real-branch' ? null : resolved(90));
    const task = worktreeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(queriedBranches()).toEqual(['real-branch']);
    expect(result.status).toBe('not-found');
  });

  it('tier 6: two branches resolving to DIFFERENT PRs is ambiguous, so it does not guess', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/one', 'refs/remotes/origin/two'];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'one' ? resolved(91) : branch === 'two' ? resolved(92) : null);
    const task = worktreeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('not-found');
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pushed_branch).toBeNull();
  });

  it('tier 6: two branches resolving to the SAME PR is not ambiguous and links', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/one', 'refs/remotes/origin/two'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'real-branch' ? null : resolved(93));
    const task = worktreeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(93);
  });

  it('tier 6: a degrade inside it still surfaces and preserves the existing link', async () => {
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/pushed-name'];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'pushed-name' ? new PRResolverUnavailableError('gh CLI not found') : null);
    const task = worktreeTask({}, { pr_number: 77, pr_url: 'u77', pr_state: 'open' });
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
    const task = worktreeTask({}, { base_branch: 'main' });
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
    const task = worktreeTask();
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
    const task = worktreeTask({ pushedBranch: 'maint/pushed-name' });
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
    const task = worktreeTask();
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
    const task = worktreeTask();
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pushed_branch).toBeNull();
  });

  it('tier 5: resolves from the recorded pushed branch without reading refs at all', async () => {
    // The durable half. Once recorded it survives the task committing past the
    // pushed tip, and the remote branch being deleted after the merge.
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'maint/pushed-name' ? resolved(94) : null);
    const task = worktreeTask({ pushedBranch: 'maint/pushed-name' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(94);
    expect(readRefs()).toHaveLength(0);
  });

  it('tier 6: never reads refs when a stronger tier already answered', async () => {
    // Cost guard. The ref read is per-task on every sweep, so a tier-2 hit must
    // not pay for it.
    conn.byBranch = resolved(95);
    const task = worktreeTask();
    await linkPRForTask(task.id, depsFor(task));
    expect(readRefs()).toHaveLength(0);
  });

  it('tier 6: never reads refs when there is no sha to anchor on', async () => {
    const task = reclaimedWorktreeTask({ branch: 'slug' });
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
    const task = reclaimedWorktreeTask({ branch: 'slug', headSha: 'sha-stored' });
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
    const task = worktreeTask({ resolvedBase: 'develop' }, { base_branch: null });
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
    const task = worktreeTask({ resolvedBase: 'develop' }, { base_branch: '' });
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
    const task = worktreeTask({ resolvedBase: 'develop' }, { base_branch: null });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.task?.pr_number).toBe(96);
  });

  it('tier 6: bails when the base branch is unknown, since the base-tip guard cannot fire', async () => {
    // Without a base, a fresh worktree on the base tip is indistinguishable from
    // a task whose work was pushed elsewhere, so the tier declines to run.
    git.sha = HEX_SHA;
    git.pointsAtRefs = ['refs/remotes/origin/someone-elses-branch'];
    conn.byBranch = null;
    const task = worktreeTask({}, { base_branch: null });
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
    const task = worktreeTask({}, { base_branch: null });
    await linkPRForTask(task.id, depsFor(task, { defaultBaseBranch: '' }));
    expect(readRefs()).toHaveLength(0);
  });

  it('clears a stale link when the resolver cleanly finds no PR (never leaves a stale merged)', async () => {
    // The PR vanished (branch/PR deleted): every tier returns null with no degrade.
    // The stale link - including a stale `merged` - must be cleared atomically.
    conn.byNumber = null; // pr_number no longer resolves
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = reclaimedWorktreeTask({}, { pr_number: 99, pr_url: 'u99', pr_state: 'merged' });
    const deps = depsFor(task, { updateSpy });
    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null }));
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
    const task = unstartedTask({ pr_number: 240, pr_url: 'u240', pr_state: null });
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
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 50, pr_url: 'u50', pr_state: 'open' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('resolver-unavailable: surfaces the reason when the resolver throws and no scrollback exists', async () => {
    conn.byNumber = new PRResolverUnavailableError('gh CLI not found');
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 60 });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/gh/i);
  });

  it('transient-error: preserves the existing link and does not report not-found', async () => {
    conn.byNumber = new PRResolverTransientError('HTTP 503');
    const updateSpy = vi.fn();
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 61, pr_url: 'u61', pr_state: 'open' });
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
    const task = reclaimedWorktreeTask({ branch: 'slug', headSha: 'sha-current' }, { pr_number: 70 });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(conn.calls).toContain('byCommit');
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(70);
  });

  it('rethrows the deferred degrade when no tier resolves, so degradeStatus is still set', async () => {
    conn.byNumber = new PRResolverUnavailableError('az missing');
    conn.byCommit = null;
    const task = reclaimedWorktreeTask({ branch: 'slug', headSha: 'sha-current' }, { pr_number: 71 });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/az missing/);
  });

  // Both classes block the clear identically; the transient is the more
  // informative message, so it is the one reported.
  it('reports a transient over an unavailable when both tiers degraded', async () => {
    conn.byNumber = new PRResolverUnavailableError('az missing');
    conn.byCommit = new PRResolverTransientError('HTTP 503');
    const task = reclaimedWorktreeTask({ branch: 'slug', headSha: 'sha-current' }, { pr_number: 72 });
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
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 73, pr_url: 'u73', pr_state: 'open' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_url).toBe('u73');
  });

  it('opportunistically persists head_sha when the worktree HEAD changes', async () => {
    git.sha = 'sha-new';
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = worktreeTask({ headSha: 'sha-old' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ head_sha: 'sha-new' }));
    expect(result.status).toBe('not-found');
  });
});

/**
 * The two INFERRED tiers (3 and 6) refuse an answer another task on the board
 * already holds. Git cannot separate "my own pushed tip" from "fast-forwarded
 * onto a sibling's tip": both are the identical state, and the connector keeps
 * a lone candidate whose head does not match the hint ON PURPOSE (a Done task
 * whose branch was pushed under another name). The board can separate them,
 * because the sibling links first in the normal flow. The per-task anchors
 * (Tiers 1, 2, 4, 5) are never refused.
 *
 * The holder lookups on the fake repository answer from `siblings`; the spies
 * are read back through `holderLookups` so a test can prove a lookup ran (the
 * guard found nothing) or never ran (an earlier check answered first).
 */
describe('linkPRForTask inferred tiers never take a PR or branch another task holds', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });
  const refusalLines = () => logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('Refused'));
  const holderLookups = (deps: ReturnType<typeof depsFor>) => deps.tasks as unknown as {
    listByPRNumber: ReturnType<typeof vi.fn>;
    listByBranchOrPushedBranch: ReturnType<typeof vi.fn>;
  };
  /** Task A: a reclaimed worktree that holds PR 388 by number, on its own slug branch. */
  const holderOfPR = (overrides: NonAnchorOverrides = {}) => reclaimedWorktreeTask(
    { branch: 'pr-merge-readiness-pill-1a2b3c4d' },
    { title: 'Merge-readiness pill', pr_number: 388, pr_url: 'u388', pr_state: 'open', ...overrides },
  );

  it('tier 3: refuses the sibling PR the commit tier answers with when that task already holds it (the incident)', async () => {
    // A follower task fast-forwarded its worktree onto a sibling's PR branch:
    // its HEAD is that PR's tip, two commits ahead of main, none of them the
    // follower's own. The commit tier answers the sibling's PR and the
    // connector keeps the lone candidate on purpose. The board knows what git
    // cannot: the sibling already holds that number, archived on Done.
    git.branch = 'azure-devops-evaluat-cac3c91e';
    git.sha = 'sha-current'; // non-hex, so the tier 6 ref read is refused unread and only tier 3 is in play
    git.aheadCount = '2';
    conn.byBranch = null;
    conn.byCommit = resolved(388);
    const holder = holderOfPR({ pr_state: 'merged', archived_at: 't' });
    const updateSpy = vi.fn();
    const task = worktreeTask(
      { branch: 'azure-devops-evaluat-cac3c91e', headSha: 'sha-current' },
      { title: 'Azure DevOps branch policies' },
    );
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy, siblings: [holder] }));
    expect(conn.calls).toContain('byCommit'); // the tier ran; the guard refused its answer
    expect(result.status).toBe('not-found');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pr_url).toBeNull();
    expect(result.task?.pushed_branch).toBeNull();
    const lines = refusalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Refused PR #388 by commit');
    expect(lines[0]).toContain(`"Azure DevOps branch policies" (#${task.display_id})`);
    expect(lines[0]).toContain(`"Merge-readiness pill" (#${holder.display_id})`);
  });

  it('tier 6: refuses the PR at the tip when another task already holds it, and records no pushed_branch', async () => {
    // The same follower, resolved after tier 3 came back empty (say the sibling
    // rebased). The remote branch at its tip is the sibling's PR branch. Two
    // ahead of main on purpose: the sibling's unmerged commits count as "own",
    // so the record-only path would otherwise be armed for this candidate.
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    git.pointsAtRefs = ['refs/remotes/origin/feat/pr-merge-readiness-pill'];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'feat/pr-merge-readiness-pill' ? resolved(388) : null);
    const holder = holderOfPR();
    const updateSpy = vi.fn();
    const task = worktreeTask({ headSha: HEX_SHA });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy, siblings: [holder] }));
    expect(queriedBranches()).toContain('feat/pr-merge-readiness-pill'); // the tier ran
    expect(result.status).toBe('not-found');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pushed_branch).toBeNull();
    const lines = refusalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Refused PR #388 by remote tip');
    expect(lines[0]).toContain(`"Merge-readiness pill" (#${holder.display_id})`);
  });

  it('tier 6: refuses a tip branch another task recorded as its pushed branch, before that task has linked its PR', async () => {
    // The stamp race. A pushed feat/a and opened its PR seconds ago; A's own
    // resolve has not written the number yet, so the by-number lookup is blind.
    // The branch is still A's: its push was captured as pushed_branch.
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    git.pointsAtRefs = ['refs/remotes/origin/feat/a'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'feat/a' ? resolved(388) : null);
    const holder = noWorktreeTask({ pushedBranch: 'feat/a' }, { title: 'A' });
    const updateSpy = vi.fn();
    const task = worktreeTask({ headSha: HEX_SHA }, { title: 'B' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy, siblings: [holder] }));
    expect(result.status).toBe('not-found');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pushed_branch).toBeNull();
    const lines = refusalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Refused remote branch "feat/a"');
    expect(lines[0]).toContain(`"B" (#${task.display_id})`);
    expect(lines[0]).toContain(`"A" (#${holder.display_id})`);
  });

  it('tier 6: does not record a tip branch another task holds when no PR exists yet (B resolved before A opened its PR)', async () => {
    // The ordering the by-number guard cannot reach: there is no number to look
    // up. Without the branch refusal the record-only path stores feat/a as B's
    // pushed_branch (hasOwnCommits counts A's unmerged commits), and once A's
    // PR exists the unguarded tier 5 links it to B from that stored name.
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    conn.byBranch = null;
    git.pointsAtRefs = ['refs/remotes/origin/feat/a'];
    const holder = noWorktreeTask({ pushedBranch: 'feat/a' }, { title: 'A' });
    const updateSpy = vi.fn();
    const task = worktreeTask({ headSha: HEX_SHA });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy, siblings: [holder] }));
    expect(result.status).toBe('not-found');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pushed_branch).toBeNull();
    const lines = refusalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Refused remote branch "feat/a"');
  });

  it('tier 3: still links a commit-tier PR no other task holds (the lone non-matching candidate wins as before)', async () => {
    git.sha = 'sha-current';
    git.aheadCount = '2';
    conn.byBranch = null;
    conn.byCommit = resolved(388);
    const task = worktreeTask({ headSha: 'sha-current' });
    const deps = depsFor(task, { siblings: [] });
    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(388);
    // The guard RAN and found nothing, rather than never running.
    expect(holderLookups(deps).listByPRNumber).toHaveBeenCalledWith(388);
    expect(refusalLines()).toHaveLength(0);
  });

  it('tier 6: still links and records when no other task holds the PR or the branch', async () => {
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    git.pointsAtRefs = ['refs/remotes/origin/feat/mine'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'feat/mine' ? resolved(388) : null);
    const task = worktreeTask({ headSha: HEX_SHA });
    const deps = depsFor(task, { siblings: [] });
    const result = await linkPRForTask(task.id, deps);
    expect(result.task?.pr_number).toBe(388);
    expect(result.task?.pushed_branch).toBe('feat/mine');
    expect(holderLookups(deps).listByBranchOrPushedBranch).toHaveBeenCalledWith('feat/mine');
    expect(holderLookups(deps).listByPRNumber).toHaveBeenCalledWith(388);
    expect(refusalLines()).toHaveLength(0);
  });

  it('tier 6: still records a free tip branch when no PR exists yet', async () => {
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    conn.byBranch = null;
    git.pointsAtRefs = ['refs/remotes/origin/feat/mine'];
    const task = worktreeTask({ headSha: HEX_SHA });
    const deps = depsFor(task, { siblings: [] });
    const result = await linkPRForTask(task.id, deps);
    expect(result.task?.pushed_branch).toBe('feat/mine');
    expect(holderLookups(deps).listByBranchOrPushedBranch).toHaveBeenCalledWith('feat/mine');
    expect(refusalLines()).toHaveLength(0);
  });

  it('tier 1: an explicit number is never refused, even when a sibling holds the same PR (the review-task shape)', async () => {
    conn.byNumber = resolved(388);
    const holder = holderOfPR();
    const task = worktreeTask({ headSha: 'sha-current' }, { pr_number: 388, pr_url: 'u388', pr_state: 'open' });
    const deps = depsFor(task, { siblings: [holder] });
    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('unchanged');
    expect(result.task?.pr_number).toBe(388);
    expect(holderLookups(deps).listByPRNumber).not.toHaveBeenCalled();
    expect(holderLookups(deps).listByBranchOrPushedBranch).not.toHaveBeenCalled();
    expect(refusalLines()).toHaveLength(0);
  });

  it('the lookup excludes the task itself: re-confirming its own number by commit is not a refusal', async () => {
    // Tier 1 missed (say the number resolver refused the secondary-remote
    // fallback) and the commit tier answers the number this task already
    // holds. A self-match must not refuse, or the task would clear its own link.
    git.sha = 'sha-current';
    git.aheadCount = '2';
    conn.byNumber = null;
    conn.byBranch = null;
    conn.byCommit = resolved(388);
    const task = worktreeTask({ headSha: 'sha-current' }, { pr_number: 388, pr_url: 'u388', pr_state: 'open' });
    const result = await linkPRForTask(task.id, depsFor(task, { siblings: [task] }));
    expect(result.status).toBe('unchanged');
    expect(result.task?.pr_number).toBe(388);
    expect(refusalLines()).toHaveLength(0);
  });

  it('the lookup excludes the task itself on the branch side: a remote branch named after its own stored branch_name is not refused', async () => {
    // Tier 6's candidate filter compares against the LIVE HEAD branch
    // ('real-branch' here), not the stored branch_name ('slug'). So a remote
    // branch named after the task's own stored slug is still a Tier 6
    // candidate, and listByBranchOrPushedBranch('slug') returns the task's own
    // row. A self-match must not refuse, or the record-only path would go
    // silent for a task whose worktree branch was ever renamed.
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    conn.byBranch = null;
    git.pointsAtRefs = ['refs/remotes/origin/slug']; // the task's own stored branch_name; live HEAD is 'real-branch'
    const task = worktreeTask({ headSha: HEX_SHA });
    const deps = depsFor(task, { siblings: [task] });
    const result = await linkPRForTask(task.id, deps);
    expect(holderLookups(deps).listByBranchOrPushedBranch).toHaveBeenCalledWith('slug');
    expect(result.task?.pushed_branch).toBe('slug');
    expect(refusalLines()).toHaveLength(0);
  });

  it('a refused commit-tier hit is a miss, not a stop: tier 5 still links the task\'s own PR', async () => {
    // B pushed feat/b (#500) earlier, then fast-forwarded onto A's tip to build
    // on it. The commit tier answers A's PR 388 (feat/b sits at an older commit)
    // and is refused; B's own pushed branch still resolves B's own PR.
    git.sha = 'sha-current';
    git.aheadCount = '2';
    conn.byCommit = resolved(388);
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'feat/b' ? resolved(500) : null);
    const holder = holderOfPR();
    const task = worktreeTask({ headSha: 'sha-current', pushedBranch: 'feat/b' });
    const result = await linkPRForTask(task.id, depsFor(task, { siblings: [holder] }));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(500);
    expect(queriedBranches()).toEqual(['real-branch', 'feat/b']);
    expect(refusalLines()).toHaveLength(1);
  });

  it('tier 6: an ambiguous pair is refused by ambiguity alone; the board is never consulted for it', async () => {
    // Pins the order: the distinct-number check answers first, so the guard
    // never pre-filters `hits`. A pre-filter that dropped a held candidate
    // would leave `hits` empty and arm the record-only path for the survivor.
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    git.pointsAtRefs = ['refs/remotes/origin/one', 'refs/remotes/origin/two'];
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'one' ? resolved(91) : branch === 'two' ? resolved(92) : null);
    const holder = holderOfPR({ pr_number: 91, pr_url: 'u91' });
    const task = worktreeTask({ headSha: HEX_SHA });
    const deps = depsFor(task, { siblings: [holder] });
    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('not-found');
    expect(result.task?.pushed_branch).toBeNull();
    expect(holderLookups(deps).listByPRNumber).not.toHaveBeenCalled();
    expect(holderLookups(deps).listByBranchOrPushedBranch).not.toHaveBeenCalled();
    expect(refusalLines()).toHaveLength(0);
  });

  it('a refused hit still counts as a clean miss: a stale different link is cleared', async () => {
    git.sha = 'sha-current';
    git.aheadCount = '2';
    conn.byNumber = null; // #100 no longer resolves
    conn.byBranch = null;
    conn.byCommit = resolved(388);
    const holder = holderOfPR();
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = worktreeTask({ headSha: 'sha-current' }, { pr_number: 100, pr_url: 'u100', pr_state: 'open' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy, siblings: [holder] }));
    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null,
    }));
    expect(refusalLines()).toHaveLength(1);
  });

  it('tier 6: a refused hit does not swallow a degrade on the OTHER candidate, and records no branch for either', async () => {
    // Two branches share the tip. One resolves to a PR another task already
    // holds (refused); the other's resolve degrades (say `az` timed out on the
    // second candidate in the same pass). A refusal must fall through to the
    // ladder's end-of-function `degrade.pending()` rethrow, not return early:
    // an early `return null` on refusal would swallow the pending degrade, and
    // the pass would read as a confident `not-found` (which clears a real
    // stale link) instead of `resolver-unavailable` (which preserves it).
    git.sha = HEX_SHA;
    git.aheadCount = '2';
    conn.byCommit = null;
    git.pointsAtRefs = ['refs/remotes/origin/held-branch', 'refs/remotes/origin/flaky-branch'];
    conn.byBranch = (_cwd: unknown, branch: unknown) => {
      if (branch === 'held-branch') return resolved(388);
      if (branch === 'flaky-branch') return new PRResolverUnavailableError('az timed out');
      return null;
    };
    const holder = holderOfPR();
    const updateSpy = vi.fn();
    const task = worktreeTask({ headSha: HEX_SHA });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy, siblings: [holder] }));
    // Both candidates ran - the degrade on the second one did not abort the loop.
    expect(queriedBranches()).toEqual(['real-branch', 'held-branch', 'flaky-branch']);
    expect(result.status).toBe('resolver-unavailable');
    expect(result.message).toMatch(/az timed out/);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_number).toBeNull();
    expect(result.task?.pushed_branch).toBeNull();
    const lines = refusalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Refused PR #388 by remote tip');
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
    const task = worktreeTask(
      { branch: 'code-review-32-1dbcebe5', headSha: 'base-tip' },
      { pr_number: 32, description: `Review ${CITED_PR_URL}` },
    );
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
    const task = unstartedTask({ description: CITING_DESCRIPTION });
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
    const task = worktreeTask(
      { branch: 're-review-the-icons-bf9efd2b' },
      { pr_number: 9, pr_url: CITED_PR_URL, pr_state: 'merged', description: CITING_DESCRIPTION },
    );
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null }));
  });

  it('a manually-set pr_number is cleared when it cannot be confirmed, even with a URL in the description', async () => {
    // Deliberate consequence of the description being inert: a stored number that
    // resolves to nothing is a broken link and is cleared, rather than being
    // silently re-supplied from prose. This is the one case where the failure
    // mode is a badge that disappears rather than one that never appears.
    git.aheadCount = '0'; // review shape: commit tier blocked
    conn.byNumber = null; // gh ran cleanly and matched nothing
    conn.byBranch = null;
    const task = worktreeTask(
      { headSha: 'base-tip' },
      { pr_number: 9, pr_url: CITED_PR_URL, pr_state: 'open', description: CITING_DESCRIPTION },
    );
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
    const task = reclaimedWorktreeTask(
      { branch: 'slug' },
      { pr_number: 60, pr_url: 'u60', pr_state: 'open', description: CITING_DESCRIPTION },
    );
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
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 70, pr_url: 'u70', pr_state: 'merged' });
    const result = await linkPRForTask(task.id, depsFor(task, { force: false }));
    expect(result.status).toBe('unchanged');
    expect(conn.calls).toEqual([]); // resolver never invoked
  });

  it('force bypasses the terminal-skip and re-resolves', async () => {
    conn.byNumber = resolved(71, 'merged');
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 71, pr_url: 'u71', pr_state: 'merged' });
    const result = await linkPRForTask(task.id, depsFor(task, { force: true }));
    expect(conn.calls).toContain('byNumber');
    expect(result.status).toBe('unchanged'); // resolved to the same PR
  });

  it('coalesces back-to-back auto resolves within the TTL window', async () => {
    conn.byBranch = resolved(80);
    const task = worktreeTask(); // worktree present, no pr_number
    const first = await linkPRForTask(task.id, depsFor(task, { force: false }));
    expect(first.task?.pr_number).toBe(80);
    const callsAfterFirst = conn.calls.length;

    const second = await linkPRForTask(task.id, depsFor(task, { force: false }));
    expect(second.status).toBe('unchanged');
    expect(conn.calls.length).toBe(callsAfterFirst); // no new resolver calls
  });

  it('bypassThrottle: the PR-command signal resolves inside the TTL window an idle resolve stamped', async () => {
    // The shape: push, turn ends (idle resolve finds no PR yet and stamps the
    // throttle), `gh pr create` inside the next minute. The pr-candidate
    // resolve must not be coalesced away or the card waits for the next idle.
    conn.byBranch = null;
    const task = noWorktreeTask({ pushedBranch: 'maint/pushed' });
    const idle = await linkPRForTask(task.id, depsFor(task, { force: false }));
    expect(idle.status).toBe('not-found');
    const callsAfterIdle = conn.calls.length;

    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'maint/pushed' ? resolved(1383) : null);
    const candidate = await linkPRForTask(task.id, depsFor(task, { force: false, bypassThrottle: true }));

    expect(candidate.status).toBe('linked');
    expect(candidate.task?.pr_number).toBe(1383);
    expect(conn.calls.length).toBeGreaterThan(callsAfterIdle);
  });

  it('bypassThrottle: still leaves a terminal PR alone, unlike force', async () => {
    // `gh pr view` on a merged PR fires the same signal; nothing about a
    // finished PR changes, so the terminal-state skip must survive the bypass.
    conn.byNumber = resolved(70, 'merged');
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 70, pr_url: 'u70', pr_state: 'merged' });

    const result = await linkPRForTask(task.id, depsFor(task, { force: false, bypassThrottle: true }));

    expect(result.status).toBe('unchanged');
    expect(conn.calls).toEqual([]);
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
    const task = unstartedTask({ pr_number: 240, pr_url: 'u240', pr_state: null });
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
    const task = unstartedTask({ pr_number: 240, pr_url: 'u240', pr_state: null });
    const context = contextFor(task, updateSpy);

    const result = await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(result.status).toBe('not-found');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null }));
    expect(result.task?.pr_number).toBeNull();
  });
});

/**
 * The per-project readiness settings reach every readiness-capable tier as a
 * trailing options object the generic layer never inspects. The wrapper reads
 * them off the same effective-config read as the default base branch, so a
 * partial `git` stub (which most tests here use) must read as every option
 * off, never as a thrown resolve.
 */
describe('linkPR (IPC wrapper): resolve options reach every readiness-capable tier', () => {
  function contextFor(task: Task, gitConfig: Record<string, unknown>): IpcContext {
    repos.value = { tasks: { getById: () => task, update: vi.fn((patch: Partial<Task>) => patch as Task) } as never };
    return {
      currentProjectId: 'proj-1',
      projectRepo: { getById: () => ({ id: 'proj-1', path: '/repo' }) },
      configManager: { getEffectiveConfig: () => ({ git: gitConfig }) },
      boardConfigManager: { getDefaultBaseBranchForPath: () => undefined },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardEvents: { emitBoardChanged: vi.fn() },
      sessionManager: { getSessionProjectId: () => null },
    } as never;
  }

  it('forwards evaluateBranchPolicies=true to the number tier and the branch tier', async () => {
    conn.byNumber = null;
    conn.byBranch = resolved(7);
    const task = worktreeTask({}, { pr_number: 7, pr_url: 'u7', pr_state: 'open' });
    const context = contextFor(task, { defaultBaseBranch: 'main', prEvaluateBranchPolicies: true });

    await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(conn.lastArgs.byNumber?.at(-1)).toEqual({ evaluateBranchPolicies: true });
    expect(conn.lastArgs.byBranch?.at(-1)).toEqual({ evaluateBranchPolicies: true });
  });

  it('forwards evaluateBranchPolicies=false when the key is absent, never undefined at the connector', async () => {
    conn.byNumber = resolved(7);
    const task = unstartedTask({ pr_number: 7, pr_url: 'u7', pr_state: 'open' });
    const context = contextFor(task, { defaultBaseBranch: 'main' });

    await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(conn.lastArgs.byNumber?.at(-1)).toEqual({ evaluateBranchPolicies: false });
  });

  it('an unreadable config reads as every option off and still resolves', async () => {
    conn.byNumber = resolved(7);
    const task = unstartedTask({ pr_number: 7, pr_url: 'u7', pr_state: 'open' });
    const context = contextFor(task, {});
    (context.configManager as { getEffectiveConfig: () => unknown }).getEffectiveConfig = () => {
      throw new Error('config unreadable');
    };

    const result = await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });

    expect(result.status).toBe('unchanged');
    expect(conn.lastArgs.byNumber?.at(-1)).toEqual({});
  });

  it('the re-poll timer carries the same options', async () => {
    vi.useFakeTimers();
    try {
      conn.byNumber = { ...resolved(7), mergeReadiness: 'unknown' };
      const task = unstartedTask({ pr_number: 7, pr_url: 'u7', pr_state: 'open', pr_merge_readiness: 'ready' });
      const context = contextFor(task, { defaultBaseBranch: 'main', prEvaluateBranchPolicies: true });

      await linkPR(context, { projectId: 'proj-1', taskId: task.id, force: true });
      conn.lastArgs = {};
      await vi.advanceTimersByTimeAsync(5_000);

      expect(conn.lastArgs.byNumber?.at(-1)).toEqual({ evaluateBranchPolicies: true });
    } finally {
      cancelPendingVerdictRepolls();
      vi.useRealTimers();
    }
  });
});

/**
 * Merge readiness has three rules `pr_state` never needed, because every tier
 * can determine a state and not every tier can determine readiness:
 *   - PRESERVE on undetermined (a tier that cannot judge it leaves the stored
 *     verdict alone, unless the link moved to a different PR),
 *   - HOLD through a pending `unknown` on a determined verdict, re-polling on a
 *     bounded timer before conceding (no flicker on GitHub's post-push
 *     recompute, and an Azure `succeeded` still clears a stale `conflicting`
 *     once the budget is spent),
 *   - otherwise write, including `unknown` over null.
 * Each case reuses the ladder harness: `conn.byNumber` is the Tier-1 answer and
 * `depsFor` mutates the task in place so a re-poll sees the last write.
 */
describe('linkPRForTask merge readiness', () => {
  const withReadiness = (number: number, mergeReadiness: string | undefined) =>
    mergeReadiness === undefined ? resolved(number) : { ...resolved(number), mergeReadiness };
  // A Done task whose worktree was reclaimed and whose branch was captured: the
  // shape the sweep keeps refreshing after the work is done, and one with no
  // live HEAD to backfill, so a "no write" assertion sees only readiness.
  const linkedTask = (overrides: NonAnchorOverrides = {}) =>
    reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 10, pr_url: 'u10', pr_state: 'open', ...overrides });

  beforeEach(() => {
    cancelPendingVerdictRepolls();
  });

  afterEach(() => {
    cancelPendingVerdictRepolls();
    vi.useRealTimers();
  });

  it('writes a verdict on an otherwise unchanged link and notifies the renderer', async () => {
    conn.byNumber = withReadiness(10, 'ready');
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = linkedTask();
    const deps = depsFor(task, { updateSpy });
    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('linked');
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      pr_url: 'u10', pr_number: 10, pr_state: 'open', pr_merge_readiness: 'ready',
    }));
    expect(deps.onLinked).toHaveBeenCalledTimes(1);
  });

  it('writes a changed verdict (ready -> blocked)', async () => {
    conn.byNumber = withReadiness(10, 'blocked');
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_merge_readiness).toBe('blocked');
  });

  it('preserves a stored verdict when the tier cannot judge it (no write, unchanged)', async () => {
    conn.byNumber = withReadiness(10, undefined);
    const updateSpy = vi.fn();
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.task?.pr_merge_readiness).toBe('ready');
  });

  it('carries the preserved verdict into a state-change write', async () => {
    conn.byNumber = { ...resolved(10, 'merged') };
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_state: 'merged', pr_merge_readiness: 'ready' }));
  });

  it('starts from null when an undetermined tier links a DIFFERENT PR', async () => {
    // The old verdict described the old PR; it must not ride onto the new one.
    conn.byNumber = null;
    conn.byBranch = withReadiness(20, undefined);
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = worktreeTask({}, { pr_url: 'u10', pr_state: 'open', pr_merge_readiness: 'ready' });
    await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: 20, pr_merge_readiness: null }));
  });

  it('writes unknown over null, so "asked, no verdict yet" is recorded', async () => {
    conn.byNumber = withReadiness(10, 'unknown');
    const task = linkedTask({ pr_merge_readiness: null });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_merge_readiness).toBe('unknown');
  });

  it('holds a determined verdict through a pending unknown and re-polls for the real answer', async () => {
    vi.useFakeTimers();
    conn.byNumber = withReadiness(10, 'unknown');
    const updateSpy = vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    const deps = depsFor(task, { updateSpy });

    const result = await linkPRForTask(task.id, deps);
    expect(result.status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(task.pr_merge_readiness).toBe('ready');

    // The platform finished recomputing before the first re-poll.
    conn.byNumber = withReadiness(10, 'blocked');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_merge_readiness: 'blocked' }));
    expect(deps.onLinked).toHaveBeenCalledTimes(1);

    // The hold ended with a real answer, so no further timer fires.
    updateSpy.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('concedes to unknown only once the re-poll budget is spent', async () => {
    vi.useFakeTimers();
    conn.byNumber = withReadiness(10, 'unknown');
    const updateSpy = vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
    const task = linkedTask({ pr_merge_readiness: 'conflicting' });

    await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).not.toHaveBeenCalled();

    // First re-poll (5s): still pending, still held.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(task.pr_merge_readiness).toBe('conflicting');

    // Second re-poll (20s more): budget spent, the pending answer finally lands.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_merge_readiness: 'unknown' }));
    expect(task.pr_merge_readiness).toBe('unknown');
  });

  it.each(['queued', 'running'])('holds an in-flight %s verdict through a pending unknown like any determined one', async (inFlight) => {
    // A blocking check in flight is a real answer whose next real answer is
    // ready or blocked; a transient unknown (a policy call that gave no
    // readable answer, GitHub recomputing) must not blank it.
    vi.useFakeTimers();
    conn.byNumber = withReadiness(10, 'unknown');
    const updateSpy = vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
    const task = linkedTask({ pr_merge_readiness: inFlight as Task['pr_merge_readiness'] });

    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(task.pr_merge_readiness).toBe(inFlight);

    conn.byNumber = withReadiness(10, 'ready');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_merge_readiness: 'ready' }));
  });

  it('writes an in-flight verdict straight through: queued and running are answers, not holds', async () => {
    conn.byNumber = withReadiness(10, 'running');
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    const result = await linkPRForTask(task.id, depsFor(task));
    expect(result.status).toBe('linked');
    expect(result.task?.pr_merge_readiness).toBe('running');
  });

  it('does not hold a verdict for a terminal PR: unknown writes straight through', async () => {
    vi.useFakeTimers();
    conn.byNumber = { ...resolved(10, 'merged'), mergeReadiness: 'unknown' };
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_state: 'merged', pr_merge_readiness: 'unknown' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelPendingVerdictRepolls drops a scheduled re-poll', async () => {
    vi.useFakeTimers();
    conn.byNumber = withReadiness(10, 'unknown');
    const updateSpy = vi.fn();
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(vi.getTimerCount()).toBe(1);
    cancelPendingVerdictRepolls();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('scrape degradation keeps the verdict on the same URL and nulls it on a different one', async () => {
    conn.byNumber = new PRResolverUnavailableError('gh missing');
    const sameUrlTask = linkedTask({ pr_merge_readiness: 'ready' });
    conn.detect = { url: 'u10', number: 10 };
    const sameUrlSpy = vi.fn();
    const sameUrlResult = await linkPRForTask(sameUrlTask.id, {
      ...depsFor(sameUrlTask, { updateSpy: sameUrlSpy }),
      getScrollback: () => 'scrollback',
    });
    expect(sameUrlResult.status).toBe('unchanged');
    expect(sameUrlSpy).not.toHaveBeenCalled();

    const otherUrlTask = linkedTask({ pr_merge_readiness: 'ready' });
    conn.detect = { url: 'u11', number: 11 };
    const otherUrlSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    await linkPRForTask(otherUrlTask.id, {
      ...depsFor(otherUrlTask, { updateSpy: otherUrlSpy }),
      getScrollback: () => 'scrollback',
    });
    expect(otherUrlSpy).toHaveBeenCalledWith(expect.objectContaining({
      pr_url: 'u11', pr_number: 11, pr_state: null, pr_merge_readiness: null,
    }));
  });

  it('holds a draft PR through a pending unknown, same as an open one', async () => {
    vi.useFakeTimers();
    conn.byNumber = { ...resolved(10, 'draft'), mergeReadiness: 'unknown' };
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = linkedTask({ pr_state: 'draft', pr_merge_readiness: 'ready' });
    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));
    expect(result.status).toBe('unchanged');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a second resolve landing while a re-poll is pending does not add a timer or consume the budget', async () => {
    vi.useFakeTimers();
    conn.byNumber = withReadiness(10, 'unknown');
    const updateSpy = vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    const deps = depsFor(task, { updateSpy });

    await linkPRForTask(task.id, deps);
    expect(vi.getTimerCount()).toBe(1);

    // A second sweep lands on the same pending answer while the re-poll is
    // already scheduled. force:true bypasses the 60s throttle so this call
    // actually re-resolves instead of coalescing (which would pass vacuously).
    const resolverCallsBeforeSecond = conn.calls.length;
    const secondResult = await linkPRForTask(task.id, { ...deps, force: true });
    expect(conn.calls.length).toBe(resolverCallsBeforeSecond + 1);
    expect(secondResult.status).toBe('unchanged');
    expect(task.pr_merge_readiness).toBe('ready');
    expect(vi.getTimerCount()).toBe(1);

    // The re-poll fires at the FIRST delay (5s), proving the second resolve
    // did not bump the attempt to the second (20s) delay. Red-green: dropping
    // the `if (existing?.timer) return;` guard schedules a second timer at
    // 20s on top of the first, so this 5s advance never fires the write.
    conn.byNumber = withReadiness(10, 'blocked');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_merge_readiness: 'blocked' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a rejecting re-poll clears the hold entry so the next hold restarts from the first delay', async () => {
    vi.useFakeTimers();
    conn.byNumber = withReadiness(10, 'unknown');
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    const updateSpy = vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
    const getByIdSpy = vi.fn((): Task | undefined => task);
    const deps = { ...depsFor(task, { updateSpy }), tasks: { getById: getByIdSpy, update: updateSpy } as never };

    await linkPRForTask(task.id, deps);
    expect(vi.getTimerCount()).toBe(1);

    // The re-poll's own lookup fails (a DB error, not a deletion). The
    // rejection is caught inside schedulePendingVerdictRepoll, so this never
    // surfaces as an unhandled rejection (vitest would fail the test if it did).
    getByIdSpy.mockImplementationOnce(() => { throw new Error('boom'); });
    await vi.advanceTimersByTimeAsync(5_000);
    // Does not discriminate the fix by itself (the timer already self-nulled
    // before the rejection), but documents the fired timer left nothing behind.
    expect(vi.getTimerCount()).toBe(0);

    // The real proof: a fresh hold for the same task starts at the FIRST
    // delay again, not wherever the failed re-poll left the budget. Red-green:
    // dropping the `clearPendingVerdictRepoll(taskId)` inside the `.catch`
    // leaves attempt=1 behind, so this next hold schedules the 20s delay
    // instead of 5s, and the 5s advance below never fires the write.
    await linkPRForTask(task.id, deps);
    expect(vi.getTimerCount()).toBe(1);
    conn.byNumber = withReadiness(10, 'blocked');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_merge_readiness: 'blocked' }));
  });

  it('a task deleted mid-hold drops its entry so the next hold for that task id restarts the budget', async () => {
    vi.useFakeTimers();
    conn.byNumber = withReadiness(10, 'unknown');
    const task = linkedTask({ pr_merge_readiness: 'ready' });
    const updateSpy = vi.fn((patch: Partial<Task>) => { Object.assign(task, patch); return { ...task }; });
    const getByIdSpy = vi.fn((): Task | undefined => task);
    const deps = { ...depsFor(task, { updateSpy }), tasks: { getById: getByIdSpy, update: updateSpy } as never };

    await linkPRForTask(task.id, deps);
    expect(vi.getTimerCount()).toBe(1);

    // The task was deleted between scheduling the hold and the re-poll firing.
    getByIdSpy.mockImplementationOnce(() => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSpy).not.toHaveBeenCalled();

    // The task id is reused (or the task came back): the next hold starts at
    // the FIRST delay again. Red-green: dropping the
    // `clearPendingVerdictRepoll(taskId)` inside the `!task` branch leaves
    // attempt=1 behind, so this next hold schedules the 20s delay instead of
    // 5s, and the 5s advance below never fires the write.
    await linkPRForTask(task.id, deps);
    expect(vi.getTimerCount()).toBe(1);
    conn.byNumber = withReadiness(10, 'blocked');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_merge_readiness: 'blocked' }));
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
    const task = reclaimedWorktreeTask({ headSha: HEX_SHA }, { base_branch: null });
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
    const updateSpy = vi.fn((patch: Partial<Task>) => ({ ...unstartedTask({ pr_number: 240 }), ...patch }) as Task);
    const task = unstartedTask({ pr_number: 240, pr_url: 'u240', pr_state: null });
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
    const task = unstartedTask({ pr_number: 240, pr_url: 'u240', pr_state: 'open' });
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
    const updateSpy = vi.fn((patch: Partial<Task>) => ({ ...unstartedTask({ pr_number: 240 }), ...patch }) as Task);
    const task = unstartedTask({ pr_number: 240, pr_url: 'u240', pr_state: null });
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
    const task = worktreeTask({ headSha: 'sha' }, { pr_number: 99 });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('linked');
    expect(trackFeatureUsedSpy).toHaveBeenCalledTimes(1);
    expect(trackFeatureUsedSpy).toHaveBeenCalledWith('pull_request');
  });

  it('never fires when a stale link is cleared (the sweep noticing its own housekeeping)', async () => {
    conn.byNumber = null;
    const task = reclaimedWorktreeTask({}, { pr_number: 99, pr_url: 'u99', pr_state: 'merged' });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('not-found');
    expect(trackFeatureUsedSpy).not.toHaveBeenCalled();
  });

  it('never fires when the resolved PR is already current (no write at all)', async () => {
    conn.byNumber = resolved(50, 'open');
    const task = reclaimedWorktreeTask({ branch: 'slug' }, { pr_number: 50, pr_url: 'u50', pr_state: 'open' });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('unchanged');
    expect(trackFeatureUsedSpy).not.toHaveBeenCalled();
  });

  it('fires when only the merge-readiness verdict changes (url/number/state unchanged)', async () => {
    conn.byNumber = { ...resolved(10, 'open'), mergeReadiness: 'blocked' };
    const task = reclaimedWorktreeTask({ branch: 'slug' }, {
      pr_number: 10, pr_url: 'u10', pr_state: 'open', pr_merge_readiness: 'ready',
    });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('linked');
    expect(trackFeatureUsedSpy).toHaveBeenCalledTimes(1);
    expect(trackFeatureUsedSpy).toHaveBeenCalledWith('pull_request');
  });
});

/**
 * A task created with `useWorktree: false`. Every anchor the ladder used to
 * resolve from was written behind a worktree read, so this shape could never
 * link, and the shared checkout's live HEAD is not a per-task anchor: every
 * concurrent no-worktree task shares it. The anchor it CAN earn is the branch
 * its own `git push` named, recorded as `pushed_branch`, which Tier 5 resolves
 * from with no git read at all. Three of these on one checkout are the filed
 * bug (three sibling no-worktree tasks, one shared HEAD, zero linked PRs), so
 * the HEAD-never-read assertions are the point.
 */
describe('linkPRForTask: a task with no worktree', () => {
  it('tier 5: links from the branch its own push recorded, with no HEAD read and no ref read', async () => {
    conn.byBranch = (_cwd: unknown, branch: unknown) =>
      (branch === 'maint/build-validation-policy' ? resolved(1383) : null);
    const task = noWorktreeTask({ pushedBranch: 'maint/build-validation-policy' });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.status).toBe('linked');
    expect(result.task?.pr_number).toBe(1383);
    expect(conn.lastArgs.byBranch?.[1]).toBe('maint/build-validation-policy');
    // The resolver ran against the project checkout, since the task has no
    // directory of its own - and never asked that checkout what it has out.
    expect(conn.lastArgs.byBranch?.[0]).toBe('/repo');
    expect(git.revparseCalls).toBe(0);
    expect(readRefs()).toHaveLength(0);
  });

  it('tier 1: links by an explicitly recorded number (the /pull-request skill\'s kangentic_update_task write)', async () => {
    conn.byNumber = resolved(12);
    const task = noWorktreeTask({}, { pr_number: 12 });

    const result = await linkPRForTask(task.id, depsFor(task));

    expect(result.task?.pr_number).toBe(12);
    expect(conn.calls).toEqual(['byNumber']);
    expect(git.revparseCalls).toBe(0);
  });

  it('with nothing recorded it is no-anchor: the resolver is never consulted and no git read happens', async () => {
    // The state the three stranded tasks sat in before the push capture existed.
    // The gate must refuse honestly rather than fall through to a shared-HEAD
    // read that would have linked all three to one PR.
    git.branch = 'maint/whatever-is-checked-out';
    conn.byBranch = resolved(1383);
    const updateSpy = vi.fn();
    const task = noWorktreeTask();

    const result = await linkPRForTask(task.id, depsFor(task, { updateSpy }));

    expect(result.status).toBe('no-anchor');
    expect(conn.calls).toEqual([]);
    expect(git.revparseCalls).toBe(0);
    expect(readRefs()).toHaveLength(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('three concurrent no-worktree tasks on one checkout link three different PRs, never through the shared HEAD', async () => {
    // The checkout has ONE branch out, and it carries a PR of its own. A
    // resolve-time HEAD read would hand that PR to all three tasks. Each task's
    // own push named a different branch, so each resolves its own PR.
    git.branch = 'maint/shared-checkout-branch';
    const prByBranch: Record<string, number> = {
      'feature/a': 1, 'feature/b': 2, 'feature/c': 3, 'maint/shared-checkout-branch': 99,
    };
    conn.byBranch = (_cwd: unknown, branch: unknown) => {
      const number = prByBranch[String(branch)];
      return number === undefined ? null : resolved(number);
    };
    const tasks = [
      noWorktreeTask({ pushedBranch: 'feature/a' }),
      noWorktreeTask({ pushedBranch: 'feature/b' }),
      noWorktreeTask({ pushedBranch: 'feature/c' }),
    ];

    const results = await Promise.all(tasks.map((task) => linkPRForTask(task.id, depsFor(task))));

    expect(results.map((result) => result.task?.pr_number)).toEqual([1, 2, 3]);
    expect(queriedBranches()).not.toContain('maint/shared-checkout-branch');
    expect(git.revparseCalls).toBe(0);
  });

  it('three no-worktree tasks with nothing recorded all stay unlinked, never all on one PR', async () => {
    git.branch = 'maint/shared-checkout-branch';
    conn.byBranch = resolved(99);
    const tasks = [noWorktreeTask(), noWorktreeTask(), noWorktreeTask()];

    const results = await Promise.all(tasks.map((task) => linkPRForTask(task.id, depsFor(task))));

    expect(results.map((result) => result.status)).toEqual(['no-anchor', 'no-anchor', 'no-anchor']);
    expect(results.every((result) => result.task?.pr_number == null)).toBe(true);
    expect(conn.calls).toEqual([]);
  });

  it('the fixture refuses an anchor column in overrides, so an impossible state cannot be built', () => {
    // Tests are not typechecked, so this is the guard: the old fixture let a
    // test hand the ladder `worktree_path: null` next to `branch_name: 'slug'`
    // and `use_worktree: 1`, which only the Done path produces.
    expect(() => noWorktreeTask({}, { head_sha: 'sha' } as never)).toThrow(/head_sha/);
    expect(() => noWorktreeTask({}, { branch_name: 'slug' } as never)).toThrow(/branch_name/);
    expect(() => worktreeTask({}, { worktree_path: null } as never)).toThrow(/worktree_path/);
    expect(() => unstartedTask({ use_worktree: 0 } as never)).toThrow(/use_worktree/);
    expect(() => reclaimedWorktreeTask({}, { pushed_branch: 'x' } as never)).toThrow(/pushed_branch/);
  });
});

/**
 * `autoLinkPRForTask` is the gate every implicit trigger (a move, a session
 * going idle) passes through before `linkPR`. It mirrored the ladder's old
 * anchor gate, so a no-worktree task whose push WAS recorded still bailed
 * here and never reached Tier 5.
 */
describe('autoLinkPRForTask: the anchor gate admits pushed_branch', () => {
  function contextFor(task: Task, updateSpy: ReturnType<typeof vi.fn>): IpcContext {
    repos.value = {
      tasks: { getById: () => task, update: updateSpy },
      swimlanes: { getById: () => ({ id: 'lane', role: null }) },
    } as never;
    return {
      currentProjectId: 'proj-1',
      projectRepo: { getById: () => ({ id: 'proj-1', path: '/repo' }) },
      configManager: { getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) },
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      boardEvents: { emitBoardChanged: vi.fn() },
      sessionManager: { getSessionProjectId: () => null },
    } as never;
  }

  it('proceeds to the ladder for a no-worktree task whose push was recorded, and links it', async () => {
    conn.byBranch = (_cwd: unknown, branch: unknown) => (branch === 'maint/pushed' ? resolved(1385) : null);
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = noWorktreeTask({ pushedBranch: 'maint/pushed' });
    const context = contextFor(task, updateSpy);

    autoLinkPRForTask(context, task.id, 'proj-1');

    await vi.waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ pr_number: 1385 }));
    });
    expect(git.revparseCalls).toBe(0);
  });

  it('still bails for a no-worktree task with nothing recorded', async () => {
    conn.byBranch = resolved(99);
    const updateSpy = vi.fn();
    const task = noWorktreeTask();
    const context = contextFor(task, updateSpy);

    autoLinkPRForTask(context, task.id, 'proj-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(conn.calls).toEqual([]);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

/**
 * `recordPushedBranchForSession` is the write behind the `branch-pushed`
 * session event: the destination the agent's own `git push` named, recorded
 * on the session's task. Patch-only, resolve-free, and refused for the three
 * names that would be wrong: the task's own branch, the stored value, and the
 * effective base (a merge-back's `git push origin HEAD:develop` must not make
 * Tier 5 link the base branch's own PR).
 */
describe('recordPushedBranchForSession', () => {
  /** `boardBase: null` models a board config that names no default base. */
  function contextFor(
    task: Task | undefined,
    updateSpy: ReturnType<typeof vi.fn>,
    options: { boardBase?: string | null } = {},
  ): IpcContext {
    const boardBase = options.boardBase === undefined ? 'develop' : options.boardBase;
    repos.value = {
      tasks: { getById: () => task, getBySessionId: () => task, update: updateSpy },
    } as never;
    return {
      currentProjectId: 'proj-1',
      projectRepo: { getById: () => ({ id: 'proj-1', path: '/repo' }) },
      boardConfigManager: { getDefaultBaseBranchForPath: () => boardBase ?? undefined },
      configManager: { getEffectiveConfig: () => ({ git: { defaultBaseBranch: 'main' } }) },
      sessionManager: { getSessionProjectId: () => 'proj-1' },
    } as never;
  }

  it('writes only { id, pushed_branch } and never resolves', async () => {
    conn.byBranch = resolved(1383);
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = noWorktreeTask();
    const context = contextFor(task, updateSpy);

    await recordPushedBranchForSession(context, 'sess-1', 'maint/build-validation-policy');

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith({ id: task.id, pushed_branch: 'maint/build-validation-policy' });
    expect(conn.calls).toEqual([]);
    expect(git.revparseCalls).toBe(0);
  });

  it('a newer push overwrites an older recorded branch', async () => {
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = worktreeTask({ pushedBranch: 'maint/old-name' });
    const context = contextFor(task, updateSpy);

    await recordPushedBranchForSession(context, 'sess-1', 'maint/new-name');

    expect(updateSpy).toHaveBeenCalledWith({ id: task.id, pushed_branch: 'maint/new-name' });
  });

  it.each([
    ['the task\'s own branch_name', worktreeTask({ branch: 'slug' }), 'slug'],
    ['the stored pushed_branch', worktreeTask({ pushedBranch: 'maint/x' }), 'maint/x'],
    ['the board-config base (no base chosen on the task)', noWorktreeTask({}, { base_branch: null }), 'develop'],
    ['an explicitly chosen base_branch', noWorktreeTask({}, { base_branch: 'release/1.0' }), 'release/1.0'],
    ['the observed resolved_base_branch', reclaimedWorktreeTask({ resolvedBase: 'integration' }, { base_branch: null }), 'integration'],
  ])('writes nothing when the branch is %s', async (_label, task, branch) => {
    const updateSpy = vi.fn();
    const context = contextFor(task, updateSpy);

    await recordPushedBranchForSession(context, 'sess-1', branch);

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('falls through to the project config base when the board config names none', async () => {
    const updateSpy = vi.fn();
    const context = contextFor(noWorktreeTask({}, { base_branch: null }), updateSpy, { boardBase: null });

    await recordPushedBranchForSession(context, 'sess-1', 'main');

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('a task whose chosen base is not the pushed branch still records it (the base guard is exact)', async () => {
    // The negative twin of the refusals above: with `base_branch: 'main'` set
    // on the task, a push to `develop` (the board default it outranks) is a
    // real feature push and must be recorded.
    const updateSpy = vi.fn((patch: Partial<Task>) => patch as Task);
    const task = noWorktreeTask({}, { base_branch: 'main' });
    const context = contextFor(task, updateSpy);

    await recordPushedBranchForSession(context, 'sess-1', 'develop');

    expect(updateSpy).toHaveBeenCalledWith({ id: task.id, pushed_branch: 'develop' });
  });

  it('is a no-op for a session with no task', async () => {
    const updateSpy = vi.fn();
    const context = contextFor(undefined, updateSpy);

    await recordPushedBranchForSession(context, 'sess-unknown', 'feature/x');

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
