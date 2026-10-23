/**
 * resolveTaskChanges against real repositories: which span of history a
 * completed task's Changes tab shows, and what it says when there is none.
 *
 * Each shape below is one the resolver must tell apart, taken from real tasks:
 * a run of commits a rebase merge landed on main (#878), a branch that never
 * merged, a captured head that is the base's own tip (two merged tasks shared
 * one), commits linked but not one run, and commits this clone does not have.
 *
 * The later blocks pin what a code review changed: `truncated` means only "cut
 * at the commit cap", the base is whichever of `origin/<base>` and the local
 * base has the commit, a union diffs each commit as the range from its first
 * parent, and the resolver branches (root, merge, off-history fork point) that
 * had no test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveTaskChanges, TASK_CHANGES_MAX_COMMITS, type TaskChangesResolveInput } from '../../src/main/git/task-changes';
import { EMPTY_TREE_HASH } from '../../src/main/git/diff-service';

let repository: string;

function run(args: string[], cwd = repository): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString().trim();
}

function writeFile(relativePath: string, content: string): void {
  const absolutePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function commit(message: string, files: Record<string, string>): string {
  for (const [relativePath, content] of Object.entries(files)) writeFile(relativePath, content);
  run(['add', '-A']);
  run(['commit', '-q', '-m', message]);
  return run(['rev-parse', 'HEAD']);
}

/** Merges `branchName` into the checked-out branch with a merge commit (never a fast-forward), and returns it. */
function mergeWithMergeCommit(branchName: string): string {
  // `-m` keeps git from opening an editor for the message.
  run(['merge', '-q', '--no-ff', '-m', `merge ${branchName}`, branchName]);
  return run(['rev-parse', 'HEAD']);
}

/** Distinct full-length hashes no repository has (never all zeros, which git reads as the null oid). */
function missingHashes(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => 'd'.repeat(32) + index.toString(16).padStart(8, '0'));
}

function input(overrides: Partial<TaskChangesResolveInput>): TaskChangesResolveInput {
  return {
    repoPath: repository,
    baseBranch: 'main',
    branchName: null,
    headSha: null,
    forkPointSha: null,
    linkedCommitShas: [],
    ...overrides,
  };
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-task-changes-'));
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'dev@example.com']);
  run(['config', 'user.name', 'Dev']);
  run(['config', 'core.autocrlf', 'false']);
  run(['config', 'commit.gpgsign', 'false']);
  commit('root', { 'src/app.ts': 'one\n' });
});

afterEach(() => {
  // Retries: on Windows a handle the just-exited git process held a beat
  // longer surfaces as EBUSY/EPERM, which `force` does not cover.
  fs.rmSync(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('resolveTaskChanges', () => {
  it('a run of linked commits on the base is one range, oldest^..newest', async () => {
    const before = commit('another task', { 'src/other.ts': 'x\n' });
    const first = commit('fix(review): first', { 'src/app.ts': 'one\ntwo\n' });
    const second = commit('feat(board): second', { 'src/badge.tsx': 'pill\n' });
    const third = commit('docs: third', { 'docs/marks.md': 'list\n' });
    commit('a later task', { 'src/later.ts': 'y\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [third, first, second] }));

    expect(result.emptyReason).toBeNull();
    expect(result.range).toEqual({ base: before, head: third });
    expect(result.commits.map((entry) => entry.hash)).toEqual([third, second, first]);
    expect(result.files.map((file) => file.path).sort()).toEqual(['docs/marks.md', 'src/app.ts', 'src/badge.tsx']);
    expect(result.totals).toEqual({ insertions: 3, deletions: 0, filesChanged: 3 });
  });

  it('linked commits that are not one run list on their own, with the union of their files', async () => {
    const first = commit('task: first', { 'src/app.ts': 'one\ntwo\n' });
    commit('someone else in between', { 'src/other.ts': 'x\n' });
    const second = commit('task: second', { 'src/app.ts': 'one\ntwo\nthree\n', 'src/new.ts': 'n\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [first, second] }));

    expect(result.range).toBeNull();
    expect(result.totals).toBeNull();
    expect(result.commits.map((entry) => entry.hash)).toEqual([second, first]);
    const app = result.files.find((file) => file.path === 'src/app.ts');
    // One line from each commit, and the newest commit is the one a click opens.
    expect(app).toMatchObject({ insertions: 2, deletions: 0, newestCommitSha: second });
    expect(result.files.find((file) => file.path === 'src/new.ts')).toMatchObject({ newestCommitSha: second });
    expect(result.files.some((file) => file.path === 'src/other.ts')).toBe(false);
    // Biggest change first.
    expect(result.files[0].path).toBe('src/app.ts');
  });

  it('an unmerged branch is the range from where it was cut to its tip', async () => {
    const forkPoint = run(['rev-parse', 'HEAD']);
    run(['checkout', '-q', '-b', 'task-branch']);
    commit('task: one', { 'src/app.ts': 'one\nedited\n' });
    const tip = commit('task: two', { 'src/feature.ts': 'f\n' });
    run(['checkout', '-q', 'main']);
    commit('main moves on', { 'src/main-only.ts': 'm\n' });

    const result = await resolveTaskChanges(input({ branchName: 'task-branch', linkedCommitShas: [] }));

    expect(result.range).toEqual({ base: forkPoint, head: tip });
    expect(result.commits).toHaveLength(2);
    expect(result.files.map((file) => file.path).sort()).toEqual(['src/app.ts', 'src/feature.ts']);
  });

  it('the branch\'s reflog creation point beats a merge-base a base rewrite moved back', async () => {
    commit('shared history', { 'src/shared.ts': 's\n' });
    const mergeBaseAfterRewrite = run(['rev-parse', 'HEAD~1']);
    const creationPoint = run(['rev-parse', 'HEAD']);
    // `checkout -b` records "branch: Created from HEAD" in the branch's reflog.
    run(['checkout', '-q', '-b', 'task-branch']);
    const tip = commit('task: work', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', 'main']);
    run(['reset', '-q', '--hard', mergeBaseAfterRewrite]);
    commit('rewritten main', { 'src/rewritten.ts': 'r\n' });

    const result = await resolveTaskChanges(input({ branchName: 'task-branch' }));

    expect(result.range).toEqual({ base: creationPoint, head: tip });
  });

  it('a recorded fork point newer than the merge-base wins, as after a base history rewrite', async () => {
    commit('shared history', { 'src/shared.ts': 's\n' });
    const mergeBaseAfterRewrite = run(['rev-parse', 'HEAD~1']);
    const forkPoint = run(['rev-parse', 'HEAD']);
    // A branch made by `update-ref` has no "Created from" reflog entry, so only
    // the recorded fork point knows where it started.
    run(['update-ref', 'refs/heads/task-branch', forkPoint]);
    run(['checkout', '-q', 'task-branch']);
    const tip = commit('task: work', { 'src/task.ts': 't\n' });
    // Rewrite main so it no longer has the fork point: the merge-base falls back.
    run(['checkout', '-q', 'main']);
    run(['reset', '-q', '--hard', mergeBaseAfterRewrite]);
    commit('rewritten main', { 'src/rewritten.ts': 'r\n' });

    const withoutForkPoint = await resolveTaskChanges(input({ branchName: 'task-branch' }));
    expect(withoutForkPoint.range?.base).toBe(mergeBaseAfterRewrite);

    const withForkPoint = await resolveTaskChanges(input({ branchName: 'task-branch', forkPointSha: forkPoint }));
    expect(withForkPoint.range).toEqual({ base: forkPoint, head: tip });
    expect(withForkPoint.files.map((file) => file.path)).toEqual(['src/task.ts']);
  });

  it('a captured head that is the base\'s own tip gives no range, so other tasks\' work never shows', async () => {
    commit('other task one', { 'src/a.ts': 'a\n' });
    const mainTip = commit('other task two', { 'src/b.ts': 'b\n' });

    const result = await resolveTaskChanges(input({ headSha: mainTip, linkedCommitShas: [] }));

    expect(result.range).toBeNull();
    expect(result.emptyReason).toBe('no-commits');
  });

  it('prefers the linked run over the branch: after a rebase merge the branch holds the pre-rebase hashes', async () => {
    run(['checkout', '-q', '-b', 'task-branch']);
    const preRebase = commit('task: work', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', 'main']);
    commit('main moves on', { 'src/m.ts': 'm\n' });
    run(['cherry-pick', preRebase]);
    const landed = run(['rev-parse', 'HEAD']);

    const result = await resolveTaskChanges(input({ branchName: 'task-branch', linkedCommitShas: [landed] }));

    expect(result.commits.map((entry) => entry.hash)).toEqual([landed]);
    expect(result.range?.head).toBe(landed);
  });

  it('says why when nothing resolves', async () => {
    const missing = 'a'.repeat(40);
    await expect(resolveTaskChanges(input({ linkedCommitShas: null }))).resolves.toMatchObject({ emptyReason: 'indexing-off', commits: [] });
    await expect(resolveTaskChanges(input({ linkedCommitShas: [missing] }))).resolves.toMatchObject({ emptyReason: 'not-in-clone', commits: [] });
    await expect(resolveTaskChanges(input({ linkedCommitShas: [] }))).resolves.toMatchObject({ emptyReason: 'no-commits', commits: [] });
  });

  it('an unmerged branch still resolves with indexing off', async () => {
    run(['checkout', '-q', '-b', 'task-branch']);
    commit('task: work', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', 'main']);

    const result = await resolveTaskChanges(input({ branchName: 'task-branch', linkedCommitShas: null }));

    expect(result.emptyReason).toBeNull();
    expect(result.files.map((file) => file.path)).toEqual(['src/task.ts']);
  });

  it('ignores linked hashes this clone lacks, keeping the ones it has', async () => {
    const present = commit('task: work', { 'src/task.ts': 't\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [present, 'b'.repeat(40)] }));

    expect(result.commits.map((entry) => entry.hash)).toEqual([present]);
  });
});

describe('resolveTaskChanges truncated', () => {
  // `truncated` means "the list was cut at the commit cap" and nothing else.
  // Linked commits this clone lacks are not listed either, but they are not
  // older ones left out, so they never set it.

  it('a landed run is not truncated when the clone lacks some linked commits', async () => {
    const rootSha = run(['rev-parse', 'HEAD']);
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [second, first, ...missingHashes(2)] }));

    expect(result.range).toEqual({ base: rootSha, head: second });
    expect(result.commits.map((entry) => entry.hash)).toEqual([second, first]);
    expect(result.truncated).toBe(false);
  });

  it('linked commits that are not one run are not truncated when the clone lacks some', async () => {
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    commit('someone else in between', { 'src/other.ts': 'x\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [first, second, 'b'.repeat(40)] }));

    expect(result.range).toBeNull();
    expect(result.commits.map((entry) => entry.hash)).toEqual([second, first]);
    expect(result.truncated).toBe(false);
  });

  it('exactly the cap of linked commits is not truncated, even with most of them missing', async () => {
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    commit('someone else in between', { 'src/other.ts': 'x\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });
    const linkedCommitShas = [first, second, ...missingHashes(TASK_CHANGES_MAX_COMMITS - 2)];
    expect(linkedCommitShas).toHaveLength(TASK_CHANGES_MAX_COMMITS);

    const result = await resolveTaskChanges(input({ linkedCommitShas }));

    expect(result.commits.map((entry) => entry.hash)).toEqual([second, first]);
    expect(result.truncated).toBe(false);
  });

  it('a landed run is truncated when more commits were linked than the cap', async () => {
    const rootSha = run(['rev-parse', 'HEAD']);
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });
    const third = commit('task: third', { 'src/third.ts': '3\n' });
    // The real commits come first, so the cut keeps them and drops only padding.
    const linkedCommitShas = [third, second, first, ...missingHashes(TASK_CHANGES_MAX_COMMITS - 2)];
    expect(linkedCommitShas).toHaveLength(TASK_CHANGES_MAX_COMMITS + 1);

    const result = await resolveTaskChanges(input({ linkedCommitShas }));

    expect(result.range).toEqual({ base: rootSha, head: third });
    expect(result.commits.map((entry) => entry.hash)).toEqual([third, second, first]);
    expect(result.truncated).toBe(true);
  });

  it('a union is truncated when more commits were linked than the cap', async () => {
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    commit('someone else in between', { 'src/other.ts': 'x\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });
    const linkedCommitShas = [second, first, ...missingHashes(TASK_CHANGES_MAX_COMMITS - 1)];
    expect(linkedCommitShas).toHaveLength(TASK_CHANGES_MAX_COMMITS + 1);

    const result = await resolveTaskChanges(input({ linkedCommitShas }));

    expect(result.range).toBeNull();
    expect(result.commits.map((entry) => entry.hash)).toEqual([second, first]);
    expect(result.truncated).toBe(true);
  });
});

describe('resolveTaskChanges base refs', () => {
  // A stale `origin/main` with no remote configured: a plain ref at an older
  // commit is all the resolver reads.

  it('finds a landed run on a local base that is ahead of a stale origin', async () => {
    const stale = commit('another task', { 'src/other.ts': 'x\n' });
    run(['update-ref', 'refs/remotes/origin/main', stale]);
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });
    const third = commit('task: third', { 'src/third.ts': '3\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [third, first, second] }));

    // A range, not the union fallback: the run is on the local base even though
    // origin/main has not seen it yet.
    expect(result.range).toEqual({ base: stale, head: third });
    expect(result.commits.map((entry) => entry.hash)).toEqual([third, second, first]);
    expect(result.totals).toEqual({ insertions: 3, deletions: 0, filesChanged: 3 });
  });

  it('finds a landed run that origin has and the local base does not', async () => {
    const before = commit('another task', { 'src/other.ts': 'x\n' });
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });
    run(['update-ref', 'refs/remotes/origin/main', second]);
    run(['reset', '-q', '--hard', before]);

    const result = await resolveTaskChanges(input({ linkedCommitShas: [second, first] }));

    expect(result.range).toEqual({ base: before, head: second });
    expect(result.commits.map((entry) => entry.hash)).toEqual([second, first]);
  });

  it('a branch fast-forwarded into the local base is on the base, even with an older origin', async () => {
    const rootSha = run(['rev-parse', 'HEAD']);
    run(['update-ref', 'refs/remotes/origin/main', rootSha]);
    run(['checkout', '-q', '-b', 'task-branch']);
    commit('task: work', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', 'main']);
    run(['merge', '-q', '--ff-only', 'task-branch']);

    const result = await resolveTaskChanges(input({ branchName: 'task-branch', linkedCommitShas: null }));

    // The tip is on the local base, so the branch is merged: no range, and the
    // reason is that indexing is off (nothing links commits to the task).
    expect(result.range).toBeNull();
    expect(result.files).toEqual([]);
    expect(result.emptyReason).toBe('indexing-off');
  });

  it('measures an unmerged branch against a local base that is ahead of origin', async () => {
    const rootSha = run(['rev-parse', 'HEAD']);
    const merged = commit('another task, merged here and not pushed', { 'src/other.ts': 'x\n' });
    run(['update-ref', 'refs/remotes/origin/main', rootSha]);
    // `update-ref` leaves no "Created from" reflog entry, which would otherwise
    // move the start to the same commit and hide which base was measured.
    run(['update-ref', 'refs/heads/task-branch', merged]);
    run(['checkout', '-q', 'task-branch']);
    const tip = commit('task: work', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', 'main']);

    const result = await resolveTaskChanges(input({ branchName: 'task-branch', linkedCommitShas: [] }));

    // From the local base's tip the branch was cut at, not from the older origin
    // commit, which would list the other task's unpushed commit too.
    expect(result.range).toEqual({ base: merged, head: tip });
    expect(result.files.map((file) => file.path)).toEqual(['src/task.ts']);
  });
});

describe('resolveTaskChanges union diffs', () => {
  it('a root commit in the union is all additions, and a file sums the commits that touched it', async () => {
    const rootSha = run(['rev-parse', 'HEAD']);
    const shared = commit('task: shared', { 'src/shared.ts': 'a\nb\n' });
    commit('someone else in between', { 'src/other.ts': 'x\n' });
    const sharedAgain = commit('task: shared again', { 'src/shared.ts': 'a\nB\nc\nd\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [rootSha, shared, sharedAgain] }));

    expect(result.range).toBeNull();
    expect(result.totals).toBeNull();
    expect(result.commits.map((entry) => entry.hash)).toEqual([sharedAgain, shared, rootSha]);
    // Added with two lines, then one replaced and two added: +2 +3 and -0 -1.
    // The newest commit that touched it gives the status and the click target.
    expect(result.files.find((file) => file.path === 'src/shared.ts')).toMatchObject({
      status: 'M',
      insertions: 5,
      deletions: 1,
      newestCommitSha: sharedAgain,
    });
    // Nothing newer touched it, so it keeps the root commit's status: added.
    expect(result.files.find((file) => file.path === 'src/app.ts')).toMatchObject({
      status: 'A',
      insertions: 1,
      deletions: 0,
      newestCommitSha: rootSha,
    });
    expect(result.files.some((file) => file.path === 'src/other.ts')).toBe(false);
  });

  it('a merge commit in the union is diffed against its first parent', async () => {
    const task = commit('task: first', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', '-b', 'side']);
    commit('side work', { 'src/side.ts': 's1\ns2\n' });
    run(['checkout', '-q', 'main']);
    commit('main moves on', { 'src/main-only.ts': 'm\n' });
    const mergeCommit = mergeWithMergeCommit('side');

    const result = await resolveTaskChanges(input({ linkedCommitShas: [task, mergeCommit] }));

    // The unlinked commit between them keeps this a union, not one run.
    expect(result.range).toBeNull();
    expect(result.commits.map((entry) => entry.hash)).toEqual([mergeCommit, task]);
    // The merge brought in the side branch's file. main's own file was already
    // on the first parent, so it is not part of the merge's diff.
    expect(result.files.map((file) => file.path)).toEqual(['src/side.ts', 'src/task.ts']);
    expect(result.files[0]).toMatchObject({ status: 'A', insertions: 2, deletions: 0, newestCommitSha: mergeCommit });
  });
});

describe('resolveTaskChanges resolver branches', () => {
  it('a landed run that starts at the root commit is diffed from the empty tree', async () => {
    const rootSha = run(['rev-parse', 'HEAD']);
    const second = commit('task: second', { 'src/b.ts': 'b\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [second, rootSha] }));

    expect(result.range).toEqual({ base: EMPTY_TREE_HASH, head: second });
    expect(result.commits.map((entry) => entry.hash)).toEqual([second, rootSha]);
    expect(result.files.map((file) => file.path).sort()).toEqual(['src/app.ts', 'src/b.ts']);
    expect(result.totals).toEqual({ insertions: 2, deletions: 0, filesChanged: 2 });
  });

  it('the root commit alone is a run from the empty tree', async () => {
    const rootSha = run(['rev-parse', 'HEAD']);
    commit('a later task', { 'src/later.ts': 'y\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [rootSha] }));

    expect(result.range).toEqual({ base: EMPTY_TREE_HASH, head: rootSha });
    expect(result.commits.map((entry) => entry.hash)).toEqual([rootSha]);
    expect(result.files.map((file) => file.path)).toEqual(['src/app.ts']);
  });

  it('a run whose oldest commit is a merge commit falls to the union', async () => {
    run(['checkout', '-q', '-b', 'side']);
    commit('side work', { 'src/side.ts': 's\n' });
    run(['checkout', '-q', 'main']);
    commit('main moves on', { 'src/main-only.ts': 'm\n' });
    const mergeCommit = mergeWithMergeCommit('side');
    const after = commit('task: after the merge', { 'src/after.ts': 'a\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [mergeCommit, after] }));

    // A range from the merge's first parent would also list the side branch's
    // commits, which are not the task's, so there is no range.
    expect(result.range).toBeNull();
    expect(result.totals).toBeNull();
    expect(result.emptyReason).toBeNull();
    expect(result.commits.map((entry) => entry.hash)).toEqual([after, mergeCommit]);
    expect(result.files.map((file) => file.path).sort()).toEqual(['src/after.ts', 'src/side.ts']);
  });

  it('linked commits that are in the clone but not on the base fall to the union', async () => {
    run(['checkout', '-q', '-b', 'task-branch']);
    const first = commit('task: one', { 'src/one.ts': '1\n' });
    const second = commit('task: two', { 'src/two.ts': '2\n' });
    run(['checkout', '-q', 'main']);
    commit('main moves on', { 'src/main-only.ts': 'm\n' });

    const result = await resolveTaskChanges(input({ linkedCommitShas: [first, second] }));

    expect(result.range).toBeNull();
    expect(result.totals).toBeNull();
    expect(result.emptyReason).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.commits.map((entry) => entry.hash)).toEqual([second, first]);
    expect(result.files.map((file) => file.path).sort()).toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('with no ref for the base nothing can be shown to have landed, so a run lists as the union', async () => {
    const first = commit('task: first', { 'src/first.ts': '1\n' });
    const second = commit('task: second', { 'src/second.ts': '2\n' });
    run(['checkout', '-q', '-b', 'task-branch']);
    commit('task: branch work', { 'src/branch.ts': 'b\n' });

    const withLinked = await resolveTaskChanges(input({ baseBranch: 'trunk', linkedCommitShas: [first, second] }));
    expect(withLinked.range).toBeNull();
    expect(withLinked.commits.map((entry) => entry.hash)).toEqual([second, first]);

    // A branch cannot be measured against a base that does not exist either.
    const branchOnly = await resolveTaskChanges(input({ baseBranch: 'trunk', branchName: 'task-branch', linkedCommitShas: [] }));
    expect(branchOnly.range).toBeNull();
    expect(branchOnly.emptyReason).toBe('no-commits');
  });

  it('a recorded fork point that is not on the branch history is ignored, so the merge-base is used', async () => {
    const forkPoint = run(['rev-parse', 'HEAD']);
    run(['checkout', '-q', '-b', 'task-branch']);
    const tip = commit('task: work', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', 'main']);
    // Newer than the merge-base and in the base's history, but never on the branch.
    const offBranch = commit('main moves on', { 'src/main-only.ts': 'm\n' });

    for (const forkPointSha of [offBranch, 'c'.repeat(40)]) {
      const result = await resolveTaskChanges(input({ branchName: 'task-branch', forkPointSha }));
      expect(result.range).toEqual({ base: forkPoint, head: tip });
      expect(result.files.map((file) => file.path)).toEqual(['src/task.ts']);
    }
  });

  it('a recorded fork point older than the merge-base is ignored too', async () => {
    const older = run(['rev-parse', 'HEAD']);
    const mergeBase = commit('main moves on', { 'src/main-only.ts': 'm\n' });
    // `update-ref` leaves no "Created from" reflog entry, which would otherwise
    // put the start back at the merge-base and hide whether the fork point won.
    run(['update-ref', 'refs/heads/task-branch', mergeBase]);
    run(['checkout', '-q', 'task-branch']);
    const tip = commit('task: work', { 'src/task.ts': 't\n' });
    run(['checkout', '-q', 'main']);

    const result = await resolveTaskChanges(input({ branchName: 'task-branch', forkPointSha: older }));

    expect(result.range).toEqual({ base: mergeBase, head: tip });
    expect(result.files.map((file) => file.path)).toEqual(['src/task.ts']);
  });
});
