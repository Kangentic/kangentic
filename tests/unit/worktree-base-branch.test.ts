/**
 * Unit coverage for hardened git preconditions before worktree creation
 * (`src/main/git/base-branch.ts`, wired into `WorktreeManager.ensureWorktree`).
 *
 * Follow-up to #394 (the unborn-HEAD fallback). That closed the repo Kangentic
 * itself creates via `ensureGitRepo`; this closes repos the user already had -
 * chiefly a repo whose only branch is `master` while `defaultBaseBranch`
 * defaults to the hardcoded `'main'`, which used to fail worktree creation
 * with a raw `fatal: invalid reference: main`.
 *
 * Runs the real `git` binary against temp directories (mirroring
 * `ensure-git-repo.test.ts`) rather than mocking child_process: the behavior
 * worth pinning is what `git worktree add` actually does with each resolved
 * ref, and the resolver's whole value is in matching that reality.
 *
 * The load-bearing invariant this file exists to prove: every path here is a
 * path that ALREADY FAILS before this change (see the plan's safety table).
 * A repo whose base resolves normally must take a byte-identical path - no
 * move that currently succeeds may be blocked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { resolveWorktreeBase, describeUnresolvableBase, type WorktreeBaseResolution } from '../../src/main/git/base-branch';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-worktree-base-'));
  clearFetchCache();
});

afterEach(async () => {
  // Retry rather than a single rmSync: these temp trees hold real git worktree
  // checkouts, and on Windows a handle held a beat longer (AV, indexer, the just-exited
  // git process) surfaces as EBUSY/EPERM, which `force` does NOT cover - it only
  // suppresses ENOENT. Mirrors the accommodation `rm-with-retry.ts` makes in production.
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  clearFetchCache();
});

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

function initRepo(dir: string, branch: string): void {
  fs.mkdirSync(dir, { recursive: true });
  // `git init -b` needs git >= 2.28 (2020). Production's `ensureGitRepo` falls back to a
  // bare `git init` for older binaries; here the floor is deliberate, since every case in
  // this file is defined by which branch the repo starts on.
  run(dir, ['init', '-b', branch]);
  run(dir, ['config', 'user.email', 'dev@example.com']);
  run(dir, ['config', 'user.name', 'Dev']);
}

let commitCounter = 0;
beforeEach(() => {
  commitCounter = 0;
});

function commit(dir: string, message: string): void {
  commitCounter += 1;
  fs.writeFileSync(path.join(dir, `f${commitCounter}.txt`), `content ${commitCounter}`);
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-m', message]);
}

function tempRepoPath(name: string): string {
  return path.join(workspace, name);
}

function baseGitConfig(overrides: Partial<{
  worktreesEnabled: boolean;
  defaultBaseBranch: string;
  copyFiles: string[];
  initScript: string | null;
  linkNodeModules: boolean;
}> = {}) {
  return {
    worktreesEnabled: true,
    defaultBaseBranch: 'main',
    copyFiles: [],
    linkNodeModules: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<{
  id: string;
  title: string;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: number | null;
}> = {}) {
  return {
    id: 'task-00000001',
    title: 'Fix the thing',
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    use_worktree: null,
    ...overrides,
  };
}

describe('WorktreeManager.ensureWorktree - base branch resolution', () => {
  it('takes the byte-identical path when the base branch resolves normally (the additive-only invariant)', async () => {
    const repo = tempRepoPath('normal-resolve');
    initRepo(repo, 'main');
    commit(repo, 'init');

    const worktreeManager = new WorktreeManager(repo);
    const result = await worktreeManager.ensureWorktree(makeTask({ id: 'task-aaaaaaaa' }), baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).not.toBeNull();
    // Unaffected by the resolver: base === configured default, no fallback engaged.
    expect(result!.branchName).not.toContain('/');
    const configuredBase = run(result!.worktreePath, ['config', 'kangentic.baseBranch']).trim();
    expect(configuredBase).toBe('main');
  });

  it('falls back to master when the repo only has master and defaultBaseBranch is the unconfigured "main" default', async () => {
    const repo = tempRepoPath('master-only');
    initRepo(repo, 'master');
    commit(repo, 'init');

    const worktreeManager = new WorktreeManager(repo);
    const result = await worktreeManager.ensureWorktree(makeTask({ id: 'task-bbbbbbbb' }), baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).not.toBeNull();
    const configuredBase = run(result!.worktreePath, ['config', 'kangentic.baseBranch']).trim();
    expect(configuredBase).toBe('master');
    // Substitution collapses base === default, so the branch name stays unprefixed
    // (`fix-the-thing-bbbbbbbb`, not `master/fix-the-thing-bbbbbbbb`).
    expect(result!.branchName).not.toContain('/');
  });

  it('namespaces the branch under an explicit per-task base that differs from the configured default', async () => {
    // Distinct from the master-only substitution test above: there `substitutedFor` is set
    // and the resolved base COLLAPSES onto the default, so the branch stays unprefixed. Here
    // the task's explicit base ('release/2.0') resolves on its own (`substitutedFor` is
    // always null for an explicit, single-candidate resolution - see resolveWorktreeBase), so
    // ensureWorktree must keep the ORIGINALLY CONFIGURED default ('main') rather than
    // collapsing it to 'release/2.0', and computeAutoBranchName namespaces the branch name
    // accordingly. This pins the `resolution.substitutedFor ? ... : (gitConfig.defaultBaseBranch...)`
    // wiring in ensureWorktree: reducing it to just `resolution.baseBranch` would silently
    // drop the namespace for every explicit-base task.
    //
    // Base branch name deliberately contains a slash ('release/2.0', flattened to
    // 'release-2.0' by computeAutoBranchName) rather than a bare word like 'develop': a bare
    // 'develop' base would make the auto branch name 'develop/<slug>-<id>', which real git
    // rejects with a D/F ref conflict (`refs/heads/develop` already exists as a leaf ref, so
    // `refs/heads/develop/<slug>-<id>` cannot be created under it) - a fixture artifact of
    // this real-git test file, unrelated to the wiring under test.
    const repo = tempRepoPath('explicit-namespaced');
    initRepo(repo, 'main');
    commit(repo, 'init');
    run(repo, ['checkout', '-b', 'release/2.0']);
    run(repo, ['checkout', 'main']);

    const worktreeManager = new WorktreeManager(repo);
    const task = makeTask({ id: 'task-mmmmmmmm', base_branch: 'release/2.0' });
    const result = await worktreeManager.ensureWorktree(task, baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).not.toBeNull();
    const configuredBase = run(result!.worktreePath, ['config', 'kangentic.baseBranch']).trim();
    expect(configuredBase).toBe('release/2.0');
    expect(result!.branchName.startsWith('release-2.0/')).toBe(true);
  });

  it('throws a written error naming the branch when an explicit per-task base branch does not exist', async () => {
    const repo = tempRepoPath('explicit-missing');
    initRepo(repo, 'main');
    commit(repo, 'init');

    const worktreeManager = new WorktreeManager(repo);
    const task = makeTask({ id: 'task-cccccccc', base_branch: 'release-2.0' });

    await expect(worktreeManager.ensureWorktree(task, baseGitConfig({ defaultBaseBranch: 'main' })))
      .rejects.toThrow(/base branch 'release-2\.0' does not exist/);
  });

  // Explicit 20s timeout (default is 5s): this test does TWO full `ensureWorktree` calls
  // (each shelling out to real git for fetch/worktree-add/sparse-checkout) plus a
  // `removeWorktree` retry loop in between, roughly 3x the git work of any other test in
  // this file. Observed to intermittently exceed the 5s default under CPU/disk contention
  // (e.g. running alongside other real-git-spawning suites) even though it is well under
  // 1s in isolation - a timing flake from real subprocess contention, not a logic issue.
  it('reproduces the identical worktree path on a Done round-trip after a default-chain substitution (master-only repo)', async () => {
    // The transcript-loss failure mode createWorktree's own comments care most about:
    // Claude keys its transcript by the cwd, so a substituted base (master for an
    // unconfigured main) must not change the worktree path on a move back out of Done,
    // where the preserved branch_name comes back as customBranchName.
    const repo = tempRepoPath('roundtrip-substitution');
    initRepo(repo, 'master');
    commit(repo, 'init');

    const worktreeManager = new WorktreeManager(repo);
    const config = baseGitConfig({ defaultBaseBranch: 'main' });
    const first = await worktreeManager.ensureWorktree(makeTask({ id: 'task-kkkkkkkk', title: 'Round trip task' }), config);

    expect(first).not.toBeNull();
    expect(first!.branchName).not.toContain('/');

    // Simulate the real Done-cleanup removal path (not a bare fs.rmSync, which would
    // leave git's own worktree registration stale and fail the second `worktree add`
    // for an unrelated reason - git worktree metadata, not this resolver).
    // Deliberately NOT asserting `removed === true`: `false` is a documented, legitimate
    // Windows outcome (a held handle leaves an empty husk the next createWorktree reuses),
    // so pinning it would fail locally on Windows for a reason this test does not care
    // about. The path reproduction asserted below is the actual invariant, and it holds
    // whether the directory was removed outright or reused as a husk.
    await worktreeManager.removeWorktree(first!.worktreePath);

    // A move back out of Done passes the preserved branch_name; worktree_path is gone.
    const second = await worktreeManager.ensureWorktree(
      makeTask({ id: 'task-kkkkkkkk', title: 'Round trip task', worktree_path: null, branch_name: first!.branchName }),
      config,
    );

    expect(second).not.toBeNull();
    expect(second!.worktreePath).toBe(first!.worktreePath);
    expect(second!.branchName).toBe(first!.branchName);
  }, 20000);

  it('throws and lists the repo\'s real branches when the default chain is fully exhausted', async () => {
    const repo = tempRepoPath('chain-exhausted');
    initRepo(repo, 'trunk');
    commit(repo, 'init');

    const worktreeManager = new WorktreeManager(repo);
    const task = makeTask({ id: 'task-dddddddd' });

    await expect(worktreeManager.ensureWorktree(task, baseGitConfig({ defaultBaseBranch: 'develop' })))
      .rejects.toThrow(/'develop', 'main', or 'master'/);
    await expect(worktreeManager.ensureWorktree(task, baseGitConfig({ defaultBaseBranch: 'develop' })))
      .rejects.toThrow(/Branches found: trunk/);
  });

  it('resolves a base that exists only on origin and was never fetched (fetch retry)', async () => {
    const origin = tempRepoPath('fetch-retry-origin');
    initRepo(origin, 'main');
    commit(origin, 'init');

    const clonePath = tempRepoPath('fetch-retry-clone');
    execFileSync('git', ['clone', origin, clonePath], { windowsHide: true });

    // Create 'develop' on origin AFTER the clone, so the clone's remote-tracking
    // refs do not know about it yet - only a live fetch resolves it.
    run(origin, ['checkout', '-b', 'develop']);
    commit(origin, 'develop commit');
    run(origin, ['checkout', 'main']);

    const worktreeManager = new WorktreeManager(clonePath);
    const task = makeTask({ id: 'task-eeeeeeee', base_branch: 'develop' });
    const result = await worktreeManager.ensureWorktree(task, baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).not.toBeNull();
    const configuredBase = run(result!.worktreePath, ['config', 'kangentic.baseBranch']).trim();
    expect(configuredBase).toBe('develop');
  });

  it('falls back to a verified origin/<base> start point when worktree creation\'s own fetch fails (startPoint seam)', async () => {
    const origin = tempRepoPath('seam-origin');
    initRepo(origin, 'main');
    commit(origin, 'init');
    run(origin, ['checkout', '-b', 'develop']);
    commit(origin, 'develop commit');
    run(origin, ['checkout', 'main']);

    const clonePath = tempRepoPath('seam-clone');
    // `git clone` fetches ALL branches, so `origin/develop` is already a local
    // remote-tracking ref here - resolveWorktreeBase's local-only pass finds it
    // without ever calling fetchIfStale, so the throttle cache stays cold.
    execFileSync('git', ['clone', origin, clonePath], { windowsHide: true });

    // Break the remote AFTER the clone, so createWorktree's OWN (separate,
    // cache-cold) fetch attempt fails. Before the startPoint seam fix, that
    // failure would hand `git worktree add` the bare name 'develop', which does
    // not exist locally (only `origin/develop` does), and this call would throw.
    run(clonePath, ['remote', 'set-url', 'origin', path.join(clonePath, 'does-not-exist')]);

    const worktreeManager = new WorktreeManager(clonePath);
    const task = makeTask({ id: 'task-ffffffff', base_branch: 'develop' });
    const result = await worktreeManager.ensureWorktree(task, baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).not.toBeNull();
    const configuredBase = run(result!.worktreePath, ['config', 'kangentic.baseBranch']).trim();
    expect(configuredBase).toBe('develop');
  });

  it('returns null (no-commits fallback) for a repo with an unborn HEAD, now enforced inside ensureWorktree', async () => {
    const repo = tempRepoPath('no-commits');
    initRepo(repo, 'main');
    // No commit: unborn HEAD.

    const worktreeManager = new WorktreeManager(repo);
    const result = await worktreeManager.ensureWorktree(makeTask({ id: 'task-gggggggg' }), baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).toBeNull();
  });

  // --- Regression pins: states the Step 1 probe confirmed are already no-ops,
  // via real git rather than by inspection, so a future change that breaks
  // one of these is caught here rather than in production. ---

  it('creates a worktree normally from a detached HEAD (regression pin: not a precondition failure)', async () => {
    const repo = tempRepoPath('detached-head');
    initRepo(repo, 'main');
    commit(repo, 'first');
    commit(repo, 'second');
    run(repo, ['checkout', 'HEAD~1']);

    const worktreeManager = new WorktreeManager(repo);
    const result = await worktreeManager.ensureWorktree(makeTask({ id: 'task-hhhhhhhh' }), baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).not.toBeNull();
  });

  it('returns null for a bare repo (regression pin: isGitRepo guard, unaffected by this change)', async () => {
    const bareDir = tempRepoPath('bare.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bareDir], { windowsHide: true });

    const worktreeManager = new WorktreeManager(bareDir);
    const result = await worktreeManager.ensureWorktree(makeTask({ id: 'task-iiiiiiii' }), baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).toBeNull();
  });

  it('returns null when .git is a broken file pointer (regression pin: isInsideWorktree guard)', async () => {
    const dir = tempRepoPath('broken-git-file');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent/path/.git/worktrees/x\n');

    const worktreeManager = new WorktreeManager(dir);
    const result = await worktreeManager.ensureWorktree(makeTask({ id: 'task-jjjjjjjj' }), baseGitConfig({ defaultBaseBranch: 'main' }));

    expect(result).toBeNull();
  });
});

describe('resolveWorktreeBase - candidate order', () => {
  it('tries only the per-task base branch when set, never substituting main/master (explicit stays strict)', async () => {
    const repo = tempRepoPath('explicit-strict');
    initRepo(repo, 'master');
    commit(repo, 'init');

    const resolution = await resolveWorktreeBase(repo, 'main', 'main');

    expect(resolution.kind).toBe('unresolvable');
    if (resolution.kind === 'unresolvable') {
      expect(resolution.explicit).toBe(true);
      expect(resolution.attempted).toEqual(['main']);
    }
  });

  it('treats an empty-string task base branch as "not set" (falls through to the default chain, not an explicit empty candidate)', async () => {
    // `WorktreeManager.ensureWorktree` passes `task.base_branch ?? null` - a `??`, not a
    // `||` - so an empty string (as opposed to null/undefined) survives that line unchanged.
    // resolveWorktreeBase is the seam that must still catch it: `taskBaseBranch?.trim() ||
    // null` collapses '' to null internally, so this stays a non-explicit default-chain
    // resolution instead of an explicit, guaranteed-unresolvable '' candidate.
    const repo = tempRepoPath('empty-string-base');
    initRepo(repo, 'master');
    commit(repo, 'init');

    const resolution = await resolveWorktreeBase(repo, '', 'main');

    expect(resolution).toMatchObject({ kind: 'resolved', baseBranch: 'master' });
    if (resolution.kind === 'resolved') {
      expect(resolution.substitutedFor).toBe('main');
    }
  });

  it('deduplicates the default chain when defaultBaseBranch is already "master"', async () => {
    const repo = tempRepoPath('dedup-master');
    initRepo(repo, 'trunk');
    commit(repo, 'init');

    const resolution = await resolveWorktreeBase(repo, null, 'master');

    expect(resolution.kind).toBe('unresolvable');
    if (resolution.kind === 'unresolvable') {
      expect(resolution.attempted).toEqual(['master', 'main']);
      expect(resolution.explicit).toBe(false);
    }
  });

  it('marks substitutedFor null when the FIRST candidate resolves (no fallback engaged)', async () => {
    const repo = tempRepoPath('first-candidate-resolves');
    initRepo(repo, 'develop');
    commit(repo, 'init');

    const resolution = await resolveWorktreeBase(repo, null, 'develop');

    expect(resolution).toMatchObject({ kind: 'resolved', baseBranch: 'develop', substitutedFor: null });
  });

  it('substitutes a later default-chain candidate resolved only via the fetch pass (substitutedFor at index > 0)', async () => {
    // Every other fetch-pass test in this file supplies an explicit per-task base, which
    // forces a single-item candidate list -- substitutedFor is trivially null there. This
    // needs the UNCONFIGURED-default chain (['main', 'master']) with the winner at index 1,
    // resolved only by a live fetch (never locally), to exercise
    // `substitutedFor: candidates[0]` at a winning index > 0.
    const origin = tempRepoPath('fetch-pass-substitution-origin');
    initRepo(origin, 'trunk');
    commit(origin, 'init');

    const clonePath = tempRepoPath('fetch-pass-substitution-clone');
    execFileSync('git', ['clone', origin, clonePath], { windowsHide: true });

    // Create 'master' on origin AFTER the clone, so the clone's remote-tracking refs do
    // not know about it yet. 'main' (index 0, the unconfigured default) never exists on
    // origin at all, so its fetch fails outright; only 'master' (index 1) resolves, and
    // only via a live fetch.
    run(origin, ['checkout', '-b', 'master']);
    commit(origin, 'master commit');
    run(origin, ['checkout', 'trunk']);

    const resolution = await resolveWorktreeBase(clonePath, null, 'main');

    expect(resolution).toMatchObject({
      kind: 'resolved',
      baseBranch: 'master',
      startPoint: 'origin/master',
      substitutedFor: 'main',
    });
  });
});

describe('resolveWorktreeBase - listBranches truncation (MAX_LISTED_BRANCHES)', () => {
  it('caps availableBranches at 10 even when the repo has more', async () => {
    const repo = tempRepoPath('many-branches');
    initRepo(repo, 'branch-00');
    commit(repo, 'init');
    for (let branchIndex = 1; branchIndex < 14; branchIndex++) {
      run(repo, ['branch', `branch-${String(branchIndex).padStart(2, '0')}`]);
    }

    const resolution = await resolveWorktreeBase(repo, 'does-not-exist', 'main');

    expect(resolution.kind).toBe('unresolvable');
    if (resolution.kind === 'unresolvable') {
      expect(resolution.availableBranches.length).toBe(10);
    }
  });
});

/**
 * A narrowed `remote.origin.fetch` refspec (e.g. `+refs/heads/main:refs/remotes/origin/main`)
 * is the practical, real-git lever for the "fetch process exits 0 but the wanted
 * remote-tracking ref never lands" case: `git fetch origin <branch>` for a branch outside
 * the configured refspec still succeeds (writes FETCH_HEAD) but does NOT also populate
 * `refs/remotes/origin/<branch>`. Verified empirically against real git before writing these
 * tests. Both re-verify guards this fixture exercises (base-branch.ts's fetch pass and
 * worktree-manager.ts's createWorktree startPoint seam) exist specifically to not trust that
 * kind of false-positive success.
 */
function buildNarrowedRefspecFixture(label: string): { origin: string; clone: string } {
  const origin = tempRepoPath(`${label}-origin`);
  initRepo(origin, 'main');
  commit(origin, 'init'); // f1.txt

  const clonePath = tempRepoPath(`${label}-clone`);
  execFileSync('git', ['clone', origin, clonePath], { windowsHide: true });

  // Both created AFTER the clone, so neither is a remote-tracking ref in the clone yet.
  run(origin, ['checkout', '-b', 'feature-only-remote']);
  commit(origin, 'feature commit'); // f2.txt
  run(origin, ['checkout', 'main']);

  run(origin, ['checkout', '-b', 'develop']);
  commit(origin, 'develop commit'); // f3.txt
  run(origin, ['checkout', 'main']);

  run(clonePath, ['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);

  return { origin, clone: clonePath };
}

describe('resolveWorktreeBase - narrowed refspec (fetch succeeds, ref never lands)', () => {
  it('does not trust a fetch that succeeds without landing the remote-tracking ref', async () => {
    const { clone } = buildNarrowedRefspecFixture('narrowed-refspec-resolver');

    const resolution = await resolveWorktreeBase(clone, 'feature-only-remote', 'main');

    expect(resolution.kind).toBe('unresolvable');
    if (resolution.kind === 'unresolvable') {
      expect(resolution.attempted).toEqual(['feature-only-remote']);
      expect(resolution.explicit).toBe(true);
    }
  });
});

describe('WorktreeManager createWorktree seam - narrowed refspec (fetch succeeds, ref never lands)', () => {
  it('falls back to verifiedStartPoint instead of trusting a fetch that reports success without landing the ref', async () => {
    const { clone } = buildNarrowedRefspecFixture('narrowed-refspec-seam');
    // A LOCAL 'develop' branch that shadows the name but not the content (it points at
    // main's commit, no f3.txt). This is what resolveWorktreeBase's LOCAL pass finds (no
    // network), handing createWorktree a verifiedStartPoint of 'develop' BEFORE
    // createWorktree's own (separate, cache-cold) fetch of 'develop' ever runs.
    run(clone, ['branch', 'develop', 'main']);

    const worktreeManager = new WorktreeManager(clone);
    const task = makeTask({ id: 'task-llllllll', base_branch: 'develop' });
    // defaultBaseBranch matches the (explicit) base branch here purely so the auto-generated
    // branch name comes out unprefixed (e.g. `fix-the-thing-task-lll`); leaving it as the
    // unrelated 'main' default would namespace the new branch under `develop/...`, which
    // collides with the shadow branch literally named 'develop' in git's ref namespace
    // (refs/heads/develop vs refs/heads/develop/...) - a ref-naming artifact of this
    // fixture, unrelated to the seam under test.
    const result = await worktreeManager.ensureWorktree(task, baseGitConfig({ defaultBaseBranch: 'develop' }));

    expect(result).not.toBeNull();
    // Proves the worktree was cut from the LOCAL 'develop' shadow branch, not from a
    // bogus 'origin/develop' that the fetch process merely claimed to succeed against
    // (which does not exist as a ref at all and would fail `git worktree add` outright).
    expect(fs.existsSync(path.join(result!.worktreePath, 'f3.txt'))).toBe(false);
  });
});

describe('describeUnresolvableBase - message formatting', () => {
  it('names the branch and offers the fix for an explicit per-task base', () => {
    const message = describeUnresolvableBase({
      kind: 'unresolvable',
      attempted: ['release-2.0'],
      explicit: true,
      availableBranches: ['main', 'develop'],
    } satisfies Extract<WorktreeBaseResolution, { kind: 'unresolvable' }>);

    expect(message).toContain("this task's base branch 'release-2.0' does not exist");
    expect(message).toContain('Pick a different base branch for the task');
    expect(message).toContain('Branches found: main, develop.');
  });

  it('lists every attempted default-chain candidate and points at the settings fix', () => {
    const message = describeUnresolvableBase({
      kind: 'unresolvable',
      attempted: ['develop', 'main', 'master'],
      explicit: false,
      availableBranches: ['trunk', 'release'],
    } satisfies Extract<WorktreeBaseResolution, { kind: 'unresolvable' }>);

    expect(message).toContain("no branch named 'develop', 'main', or 'master'");
    expect(message).toContain('Set Default Base Branch in Settings > Git');
    expect(message).toContain('Branches found: trunk, release.');
  });

  it('formats a two-item attempted list without an Oxford comma before "or"', () => {
    const message = describeUnresolvableBase({
      kind: 'unresolvable',
      attempted: ['main', 'master'],
      explicit: false,
      availableBranches: [],
    } satisfies Extract<WorktreeBaseResolution, { kind: 'unresolvable' }>);

    expect(message).toContain("no branch named 'main' or 'master'");
    // No branches found: the clause is omitted rather than printed empty.
    expect(message).not.toContain('Branches found:');
  });
});
