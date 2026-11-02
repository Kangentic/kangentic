/**
 * The creation registry's hold on a worktree path, as `moveWorktreeAside` and
 * `removeWorktree` see it.
 *
 * A path held in the registry (`tryHoldWorktreeCreation`) is being built or
 * claimed by someone else, so both calls refuse it and change nothing. The one
 * exception is the holder itself, which passes `ownCreation: true` to discard
 * what it made (a spare worktree's build or claim). Both directions are pinned
 * here against a real repo and a real linked worktree, because each is a
 * different failure: a refusal that stops refusing deletes a worktree under a
 * running setup script, and an `ownCreation` that stops being honored leaves a
 * discarded spare on disk forever.
 *
 * A false return alone cannot tell a refusal from a removal that failed, so the
 * refusal tests also read the refusal's own warning and the worktree's state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { removedWorktreesRootFor } from '../../src/main/git/removed-worktrees';
import { worktreesRootFor } from '../../src/main/git/task-worktree-folder';
import {
  isWorktreeCreationInFlight,
  tryHoldWorktreeCreation,
} from '../../src/main/git/worktree-creation-registry';
import { isSamePath } from '../../src/shared/paths';

// Real git and real renames: give the file room under a loaded run.
vi.setConfig({ testTimeout: 60_000 });

interface Fixture {
  projectPath: string;
  worktreePath: string;
  manager: WorktreeManager;
}

const workspaces: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function git(cwd: string, args: string[]): string {
  // stderr piped, so git's line-ending notices stay out of the run's output; a
  // failing command still carries its stderr in the error message.
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/**
 * A repo with one commit and one real linked worktree at
 * `<project>/.kangentic/worktrees/1`, the only place `assertRemovableWorktreePath`
 * accepts. Its own temp workspace, removed after the test.
 */
function createFixture(): Fixture {
  // The real path: git records one, and os.tmpdir() can be an alias of it (a
  // /var symlink on macOS, an 8.3 short name on Windows), which would make
  // every worktree-list comparison below miss.
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-own-creation-')));
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

  const worktreePath = path.join(worktreesRootFor(projectPath), '1');
  git(projectPath, ['worktree', 'add', '-q', '-b', 'task-1', worktreePath, 'main']);
  return { projectPath, worktreePath, manager: new WorktreeManager(projectPath) };
}

/** Whether git lists a worktree at `worktreePath`. The paths git prints and Node builds can differ in case or separator. */
function gitListsWorktree(projectPath: string, worktreePath: string): boolean {
  return git(projectPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .some((listed) => isSamePath(listed, worktreePath));
}

function removedCopies(projectPath: string): string[] {
  try {
    return fs.readdirSync(removedWorktreesRootFor(projectPath));
  } catch {
    return [];
  }
}

/** The worktree is intact: its .git file and a tracked file are on disk and git still lists it. */
function expectWorktreeUntouched(fixture: Fixture): void {
  expect(fs.existsSync(path.join(fixture.worktreePath, '.git'))).toBe(true);
  expect(fs.existsSync(path.join(fixture.worktreePath, 'README.md'))).toBe(true);
  expect(gitListsWorktree(fixture.projectPath, fixture.worktreePath)).toBe(true);
}

/** The refusal's own warning was logged, so a false return is the refusal and not a failed removal. */
function expectWarned(fragment: string): void {
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(fragment));
}

function expectNotWarned(fragment: string): void {
  expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(fragment));
}

/** Hold the path in the registry and prove the hold took. */
function holdPath(worktreePath: string): () => void {
  const release = tryHoldWorktreeCreation(worktreePath);
  expect(release).not.toBeNull();
  // A hold that was never taken would make the "own creation" cases pass for
  // the wrong reason, so every test sees the path held before it acts.
  expect(isWorktreeCreationInFlight(worktreePath)).toBe(true);
  return release as () => void;
}

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  for (const workspace of workspaces.splice(0)) {
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('WorktreeManager.moveWorktreeAside on a path the creation registry holds', () => {
  it('refuses it when the caller is not the holder: false, and the worktree stays on its path and in git', async () => {
    const fixture = createFixture();
    expectWorktreeUntouched(fixture);
    const release = holdPath(fixture.worktreePath);
    try {
      const moved = await fixture.manager.moveWorktreeAside(fixture.worktreePath);

      expect(moved).toBe(false);
      expectWarned('move aside skipped');
      expectWorktreeUntouched(fixture);
      expect(removedCopies(fixture.projectPath)).toEqual([]);
      // A refusal never touches the hold it respected.
      expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(true);
    } finally {
      release();
    }
    expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(false);
  });

  it('moves it aside with ownCreation: true, off its path and out of git, and leaves the hold to its owner', async () => {
    const fixture = createFixture();
    expectWorktreeUntouched(fixture);
    const release = holdPath(fixture.worktreePath);
    try {
      const moved = await fixture.manager.moveWorktreeAside(fixture.worktreePath, { ownCreation: true });

      expect(moved).toBe(true);
      expectNotWarned('move aside skipped');
      expect(fs.existsSync(fixture.worktreePath)).toBe(false);
      expect(gitListsWorktree(fixture.projectPath, fixture.worktreePath)).toBe(false);
      // The files went to the deleter's folder rather than vanishing.
      expect(removedCopies(fixture.projectPath)).toHaveLength(1);
      // Moving its own worktree does not end the owner's claim on the path.
      expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(true);
    } finally {
      release();
    }
    expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(false);
  });
});

describe('WorktreeManager.removeWorktree on a path the creation registry holds', () => {
  it('refuses it when the caller is not the holder: false, and the worktree stays on its path and in git', async () => {
    const fixture = createFixture();
    expectWorktreeUntouched(fixture);
    const release = holdPath(fixture.worktreePath);
    try {
      const removed = await fixture.manager.removeWorktree(fixture.worktreePath, { removalProfile: 'fast' });

      expect(removed).toBe(false);
      expectWarned('remove skipped');
      expectWorktreeUntouched(fixture);
      expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(true);
    } finally {
      release();
    }
    expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(false);
  });

  it('removes it with ownCreation: true, off its path and out of git, and leaves the hold to its owner', async () => {
    const fixture = createFixture();
    expectWorktreeUntouched(fixture);
    const release = holdPath(fixture.worktreePath);
    try {
      const removed = await fixture.manager.removeWorktree(fixture.worktreePath, {
        removalProfile: 'fast',
        ownCreation: true,
      });

      expect(removed).toBe(true);
      expectNotWarned('remove skipped');
      expect(fs.existsSync(fixture.worktreePath)).toBe(false);
      expect(gitListsWorktree(fixture.projectPath, fixture.worktreePath)).toBe(false);
      expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(true);
    } finally {
      release();
    }
    expect(isWorktreeCreationInFlight(fixture.worktreePath)).toBe(false);
  });
});
