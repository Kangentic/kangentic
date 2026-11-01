/**
 * `WorktreeManager.moveWorktreeAside`: the Done move's rename-then-prune, pinned
 * branch by branch.
 *
 * The method takes a worktree off its path at once (`removed-worktrees.ts` then
 * deletes the copy in the background), so every early exit and every ordering
 * matters: a refusal or a failed rename must change NOTHING, because the caller
 * then removes the worktree in place; a failed prune must not undo a move that
 * already happened; an already-gone path still needs its git record pruned.
 *
 * Real git and the real filesystem against a temp repo, one repo per test. Two
 * seams wrap the real implementations so a test can fail one step on demand:
 * `moveIntoRemovedWorktrees` (the rename) and `runGitWithTimeout` (the prune).
 * Both delegate to the real function unless a test says otherwise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../../src/main/git/removed-worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/removed-worktrees')>();
  return { ...actual, moveIntoRemovedWorktrees: vi.fn(actual.moveIntoRemovedWorktrees) };
});

vi.mock('../../src/main/git/git-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/git-spawn')>();
  return { ...actual, runGitWithTimeout: vi.fn(actual.runGitWithTimeout) };
});

import {
  WorktreeManager,
  setWorktreeRemovedListener,
  setWorktreeRemovingListener,
} from '../../src/main/git/worktree-manager';
import { moveIntoRemovedWorktrees, removedWorktreesRootFor } from '../../src/main/git/removed-worktrees';
import { runGitWithTimeout } from '../../src/main/git/git-spawn';
import { isWorktreeCreationInFlight, runWorktreeCreation } from '../../src/main/git/worktree-creation-registry';
import { worktreesRootFor } from '../../src/main/git/task-worktree-folder';

// Real git and real renames: give the file room under a loaded run.
vi.setConfig({ testTimeout: 60_000 });

type MoveIntoRemovedWorktrees = typeof moveIntoRemovedWorktrees;
type RunGitWithTimeout = typeof runGitWithTimeout;

let actualMoveIntoRemovedWorktrees: MoveIntoRemovedWorktrees;
let actualRunGitWithTimeout: RunGitWithTimeout;

const removedListener = vi.fn(async (_worktreePath: string): Promise<void> => undefined);
const removingListener = vi.fn(async (_worktreePath: string): Promise<void> => undefined);

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const workspaces: string[] = [];

interface Fixture {
  projectPath: string;
  worktreePath: string;
  rootModules: string;
  sentinel: string;
  manager: WorktreeManager;
}

function git(cwd: string, args: string[]): string {
  // stderr piped, so git's line-ending notices stay out of the run's output; a
  // failing command still carries its stderr in the error message.
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * A repo with one commit and one real linked worktree at
 * `<project>/.kangentic/worktrees/<folder>`, the only place
 * `assertRemovableWorktreePath` accepts. Its own temp workspace, removed after
 * the test.
 */
function createFixture(folder = '1'): Fixture {
  // The real path: git records one, and os.tmpdir() can be an alias of it (a
  // /var symlink on macOS, an 8.3 short name on Windows), which would make
  // every worktree-list comparison below miss.
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-move-aside-')));
  workspaces.push(workspace);
  const projectPath = path.join(workspace, 'project');
  fs.mkdirSync(projectPath);
  git(projectPath, ['init', '-q', '-b', 'main']);
  git(projectPath, ['config', 'user.email', 'dev@example.com']);
  git(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\nnode_modules/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  git(projectPath, ['add', '-A']);
  // A developer's global `commit.gpgsign` would prompt or fail with no key here.
  git(projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);

  const worktreePath = path.join(worktreesRootFor(projectPath), folder);
  git(projectPath, ['worktree', 'add', '-q', '-b', `task-${folder}`, worktreePath, 'main']);

  const rootModules = path.join(projectPath, 'node_modules');
  const sentinel = path.join(rootModules, 'shared-pkg', 'sentinel.txt');
  return { projectPath, worktreePath, rootModules, sentinel, manager: new WorktreeManager(projectPath) };
}

/**
 * What `linkNodeModules` leaves in a default-setup worktree: its node_modules is
 * a link to the project root's, whose files must survive the move.
 */
function linkRootNodeModules(fixture: Fixture): string {
  fs.mkdirSync(path.dirname(fixture.sentinel), { recursive: true });
  fs.writeFileSync(fixture.sentinel, 'root\n');
  const link = path.join(fixture.worktreePath, 'node_modules');
  fs.symlinkSync(fixture.rootModules, link, process.platform === 'win32' ? 'junction' : 'dir');
  // The link really reaches the root's files, so a "link is gone" assertion
  // later is about this link and not about one that never worked.
  expect(fs.readFileSync(path.join(link, 'shared-pkg', 'sentinel.txt'), 'utf8')).toBe('root\n');
  return link;
}

function gitWorktreePaths(projectPath: string): string[] {
  return git(projectPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
}

function removedCopies(projectPath: string): string[] {
  try {
    return fs.readdirSync(removedWorktreesRootFor(projectPath));
  } catch {
    return [];
  }
}

function isPruneCall(args: readonly string[]): boolean {
  return args[0] === 'worktree' && args[1] === 'prune';
}

function pruneCalls(): unknown[][] {
  return vi.mocked(runGitWithTimeout).mock.calls.filter(([, args]) => isPruneCall(args));
}

/** Whether `lstat` finds anything at the path (a dangling link counts, unlike `existsSync`). */
function lstatExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  actualMoveIntoRemovedWorktrees = (
    await vi.importActual<typeof import('../../src/main/git/removed-worktrees')>('../../src/main/git/removed-worktrees')
  ).moveIntoRemovedWorktrees;
  actualRunGitWithTimeout = (
    await vi.importActual<typeof import('../../src/main/git/git-spawn')>('../../src/main/git/git-spawn')
  ).runGitWithTimeout;
});

beforeEach(() => {
  // Each test starts with both seams delegating to the real functions and no
  // call history, whatever the test before it did to them.
  vi.mocked(moveIntoRemovedWorktrees).mockReset();
  vi.mocked(moveIntoRemovedWorktrees).mockImplementation(actualMoveIntoRemovedWorktrees);
  vi.mocked(runGitWithTimeout).mockReset();
  vi.mocked(runGitWithTimeout).mockImplementation(actualRunGitWithTimeout);
  removedListener.mockClear();
  removingListener.mockClear();
  setWorktreeRemovedListener(removedListener);
  setWorktreeRemovingListener(removingListener);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  setWorktreeRemovedListener(null);
  setWorktreeRemovingListener(null);
  warnSpy.mockRestore();
  logSpy.mockRestore();
  for (const workspace of workspaces.splice(0)) {
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('WorktreeManager.moveWorktreeAside', () => {
  it('refuses a path whose creation is still in flight and changes nothing', async () => {
    const fixture = createFixture();
    const link = linkRootNodeModules(fixture);
    expect(gitWorktreePaths(fixture.projectPath)).toContain(path.resolve(fixture.worktreePath));

    let releaseCreation: () => void = () => undefined;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const creation = runWorktreeCreation(fixture.worktreePath, undefined, () => creationGate);
    try {
      // The claim is taken synchronously, so the registry holds the path now.
      expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(true);

      const moved = await fixture.manager.moveWorktreeAside(fixture.worktreePath);

      expect(moved).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('move aside skipped'));
      // The worktree is exactly where it was, link and all.
      expect(fs.existsSync(path.join(fixture.worktreePath, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(fixture.worktreePath, 'README.md'))).toBe(true);
      expect(lstatExists(link)).toBe(true);
      expect(fs.readFileSync(path.join(link, 'shared-pkg', 'sentinel.txt'), 'utf8')).toBe('root\n');
      expect(gitWorktreePaths(fixture.projectPath)).toContain(path.resolve(fixture.worktreePath));
      expect(removedCopies(fixture.projectPath)).toEqual([]);
      expect(fs.existsSync(removedWorktreesRootFor(fixture.projectPath))).toBe(false);
      // It refused before releasing handles, renaming, pruning or announcing a removal.
      expect(moveIntoRemovedWorktrees).not.toHaveBeenCalled();
      expect(pruneCalls()).toHaveLength(0);
      expect(removingListener).not.toHaveBeenCalled();
      expect(removedListener).not.toHaveBeenCalled();
    } finally {
      releaseCreation();
      await creation;
    }
    expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(false);
  });

  it('changes nothing when the rename fails: no prune, the node_modules link stays, no removal is announced', async () => {
    const fixture = createFixture();
    const link = linkRootNodeModules(fixture);
    vi.mocked(moveIntoRemovedWorktrees).mockImplementation(async () => null);

    const moved = await fixture.manager.moveWorktreeAside(fixture.worktreePath);

    expect(moved).toBe(false);
    // The rename was attempted, so the false is the failed rename and not an earlier refusal.
    expect(moveIntoRemovedWorktrees).toHaveBeenCalledTimes(1);
    expect(moveIntoRemovedWorktrees).toHaveBeenCalledWith(fixture.projectPath, fixture.worktreePath);
    expect(removingListener).toHaveBeenCalledWith(fixture.worktreePath);
    // The link is removed only after a successful rename: still here, still working.
    expect(lstatExists(link)).toBe(true);
    expect(fs.readFileSync(path.join(link, 'shared-pkg', 'sentinel.txt'), 'utf8')).toBe('root\n');
    // Still a worktree: its .git file is intact and git still lists it.
    expect(fs.existsSync(path.join(fixture.worktreePath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.worktreePath, 'README.md'))).toBe(true);
    expect(gitWorktreePaths(fixture.projectPath)).toContain(path.resolve(fixture.worktreePath));
    expect(removedCopies(fixture.projectPath)).toEqual([]);
    // No prune ran. The directory still exists, so git would keep its record
    // either way: only the call itself tells these apart.
    expect(pruneCalls()).toHaveLength(0);
    expect(removedListener).not.toHaveBeenCalled();
  });

  it('tolerates a failed prune: still true, the directory has left its path, the removal is announced', async () => {
    const fixture = createFixture();
    vi.mocked(runGitWithTimeout).mockImplementation(async (cwd, args, options) => {
      if (isPruneCall(args)) throw new Error('simulated prune failure');
      return actualRunGitWithTimeout(cwd, args, options);
    });

    const moved = await fixture.manager.moveWorktreeAside(fixture.worktreePath);

    expect(moved).toBe(true);
    // The prune was attempted and failed, and only warned.
    expect(pruneCalls()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('simulated prune failure'));
    // The move itself had already happened.
    expect(fs.existsSync(fixture.worktreePath)).toBe(false);
    const copies = removedCopies(fixture.projectPath);
    expect(copies).toHaveLength(1);
    expect(copies[0].startsWith('1-')).toBe(true);
    // The failed prune left git's record behind, which is what the debounced
    // background prune is for. It proves the failure was really injected.
    expect(gitWorktreePaths(fixture.projectPath)).toContain(path.resolve(fixture.worktreePath));
    expect(removedListener).toHaveBeenCalledTimes(1);
    expect(removedListener).toHaveBeenCalledWith(fixture.worktreePath);
  });

  it('answers true for a path that is already gone, moves nothing, and still prunes git\'s record', async () => {
    const fixture = createFixture();
    fs.rmSync(fixture.worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(fs.existsSync(fixture.worktreePath)).toBe(false);
    // The record outlives the directory, which is the state the prune exists for.
    expect(gitWorktreePaths(fixture.projectPath)).toContain(path.resolve(fixture.worktreePath));

    const moved = await fixture.manager.moveWorktreeAside(fixture.worktreePath);

    expect(moved).toBe(true);
    expect(gitWorktreePaths(fixture.projectPath)).not.toContain(path.resolve(fixture.worktreePath));
    expect(pruneCalls()).toHaveLength(1);
    expect(moveIntoRemovedWorktrees).not.toHaveBeenCalled();
    expect(removedCopies(fixture.projectPath)).toEqual([]);
    expect(removingListener).toHaveBeenCalledWith(fixture.worktreePath);
    expect(removedListener).toHaveBeenCalledWith(fixture.worktreePath);
  });

  it('moves a worktree aside: the copy keeps no node_modules link or .git, the link\'s target survives, the record is pruned', async () => {
    const fixture = createFixture();
    const link = linkRootNodeModules(fixture);
    expect(fs.existsSync(path.join(fixture.worktreePath, '.git'))).toBe(true);
    expect(gitWorktreePaths(fixture.projectPath)).toContain(path.resolve(fixture.worktreePath));

    const moved = await fixture.manager.moveWorktreeAside(fixture.worktreePath);

    expect(moved).toBe(true);
    // Off its path at once: nothing at the link's old location either.
    expect(fs.existsSync(fixture.worktreePath)).toBe(false);
    expect(lstatExists(link)).toBe(false);
    const copies = removedCopies(fixture.projectPath);
    expect(copies).toHaveLength(1);
    expect(copies[0].startsWith('1-')).toBe(true);
    const copy = path.join(removedWorktreesRootFor(fixture.projectPath), copies[0]);
    // The copy is files for the deleter, not a worktree and not a way into the root's modules.
    expect(fs.existsSync(path.join(copy, 'README.md'))).toBe(true);
    expect(lstatExists(path.join(copy, 'node_modules'))).toBe(false);
    expect(lstatExists(path.join(copy, '.git'))).toBe(false);
    // Removing the link never touched what it pointed at.
    expect(fs.readFileSync(fixture.sentinel, 'utf8')).toBe('root\n');
    // git no longer lists the worktree, so the same path can be added again.
    expect(gitWorktreePaths(fixture.projectPath)).not.toContain(path.resolve(fixture.worktreePath));
    expect(pruneCalls()).toHaveLength(1);
    expect(removingListener).toHaveBeenCalledWith(fixture.worktreePath);
    expect(removedListener).toHaveBeenCalledWith(fixture.worktreePath);
  });
});
