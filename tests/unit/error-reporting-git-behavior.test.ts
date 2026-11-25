/**
 * What a user loses if these reports go quiet: a worktree that works worse and
 * says nothing. A merge-back onto the wrong base, a build with no node_modules
 * or without a shared folder, a branch left under an old title or never
 * deleted, a Changes panel that stops updating or lists the wrong commits, a
 * spare worktree or a removed copy that stays on disk, and a PR that never
 * links. Each used to end in a log line, or in nothing.
 *
 * Every case runs the real module under `src/main/git`, makes one dependency
 * fail, and reads what reached `reportHandledError`: the `git_worktree` source,
 * the site's `stage`, and that the failing error's text (a task title, a path)
 * went nowhere. Where a site leaves out an expected outcome, the negative case
 * sends that outcome through and asserts nothing was reported.
 *
 * Two cases also pin a destructive step that now stops: a `node_modules` link
 * that will not come out refuses the worktree's removal, and a removed copy
 * that still holds a link is answered to the caller.
 *
 * Modules are re-imported per test (`vi.resetModules`), because the reporter
 * latches a key once per run. No case starts a real git: every git run goes
 * through the fake client or the fake runner below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitCommandError } from '../../src/main/git/git-command-error';
import type { GitClient } from '../../src/main/git/git-client';
import { reportedFailures, reportedText as sharedReportedText } from './helpers/reported-failures';

type GitRunner = (cwd: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

const hoisted = vi.hoisted(() => ({
  reportHandledError: vi.fn(),
  /** What `gitAt` hands out. Null runs the real factory. */
  makeGit: null as ((directory: string) => unknown) | null,
  /** What `runGitWithTimeout` runs. Null starts a real git. */
  runGit: null as ((cwd: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>) | null,
  /** What `classifyBaseRef` answers. Null asks real git. */
  baseRef: null as { kind: 'commit'; sha: string } | null,
  /** What `removeWithRetry` rejects with. Null runs the real removal. */
  removeError: null as Error | null,
  /** Every path `removeWithRetry` was asked to remove. */
  removeTargets: [] as string[],
  /** What `renameWithRetry` rejects with. Null runs the real rename. */
  renameError: null as Error | null,
  /** Thrown by the next `isShuttingDown()` read, once. */
  shutdownReadError: null as Error | null,
}));

vi.mock('../../src/main/analytics/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/analytics/error-reporting')>()),
  reportHandledError: hoisted.reportHandledError,
}));

vi.mock('../../src/main/git/git-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/git-client')>();
  return {
    ...actual,
    gitAt: (directory: string) => (hoisted.makeGit ? hoisted.makeGit(directory) : actual.gitAt(directory)),
  };
});

vi.mock('../../src/main/git/git-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/git-spawn')>();
  return {
    ...actual,
    runGitWithTimeout: (cwd: string, args: readonly string[], options: Parameters<typeof actual.runGitWithTimeout>[2]) => (
      hoisted.runGit ? hoisted.runGit(cwd, args) : actual.runGitWithTimeout(cwd, args, options)
    ),
  };
});

vi.mock('../../src/main/git/base-ref', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/base-ref')>();
  return {
    ...actual,
    classifyBaseRef: (projectPath: string, base: string) => (
      hoisted.baseRef ? Promise.resolve(hoisted.baseRef) : actual.classifyBaseRef(projectPath, base)
    ),
  };
});

vi.mock('../../src/main/git/rm-with-retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/git/rm-with-retry')>();
  return {
    ...actual,
    removeWithRetry: (target: string, options?: Parameters<typeof actual.removeWithRetry>[1]) => {
      hoisted.removeTargets.push(target);
      return hoisted.removeError ? Promise.reject(hoisted.removeError) : actual.removeWithRetry(target, options);
    },
  };
});

vi.mock('../../src/main/fs/directory-move', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/fs/directory-move')>();
  return {
    ...actual,
    renameWithRetry: (sourcePath: string, destinationPath: string) => (
      hoisted.renameError ? Promise.reject(hoisted.renameError) : actual.renameWithRetry(sourcePath, destinationPath)
    ),
  };
});

vi.mock('../../src/main/shutdown-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/shutdown-state')>();
  return {
    ...actual,
    isShuttingDown: () => {
      const error = hoisted.shutdownReadError;
      if (error) {
        hoisted.shutdownReadError = null;
        throw error;
      }
      return actual.isShuttingDown();
    },
  };
});

/** A task title, as it would sit in a branch name, a folder name or a runtime error. */
const USER_TITLE = 'Fix Acme billing';
const USER_SLUG = 'fix-acme-billing';
const TASK_ID = '1a2b3c4d-0000-4000-8000-000000000000';
const TASK_BRANCH = `${USER_SLUG}-1a2b3c4d`;
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MERGE_BASE_SHA = 'c'.repeat(40);
const PARENT_SHA = 'd'.repeat(40);

let workspace: string;
let projectPath: string;
const createdLinks: string[] = [];

interface Report {
  sent: Error;
  tags: Record<string, string>;
}

function reports(): Report[] {
  return reportedFailures(hoisted.reportHandledError);
}

/** The reports this area's reporter sent, without the removal reporter's own. */
function gitWorktreeReports(): Report[] {
  return reports().filter((report) => report.tags.source === 'git_worktree');
}

function stagesReported(): string[] {
  return gitWorktreeReports().map((report) => report.tags.stage);
}

/** The tags of the one `git_worktree` report that was sent. */
function onlyGitWorktreeTags(): Record<string, string> {
  const found = gitWorktreeReports();
  expect(found).toHaveLength(1);
  return found[0].tags;
}

/** Everything every report carried, as text, so a leaked title or path cannot hide in any field. */
const reportedText = (): string => sharedReportedText(hoisted.reportHandledError);

function expectNoUserText(): void {
  expect(reportedText()).not.toMatch(/acme/i);
}

/** A code defect whose message quotes a task title, as V8 quotes the property it could not read. */
function defect(): TypeError {
  return new TypeError(`Cannot read properties of undefined (reading '${USER_TITLE}')`);
}

/** A filesystem failure as Node raises it, with the path in its message. */
function errnoError(code: string, syscall: string, failedPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed, ${syscall} '${failedPath}'`), { code, syscall, path: failedPath });
}

/** A git command the client rejected, with git's own words for why. */
function gitRefusal(stderr: string, exitCode = 128): GitCommandError {
  return new GitCommandError({ stdout: '', stderr: `${stderr}\n`, exitCode });
}

/** A git run `runGitWithTimeout` rejected, shaped as `spawnWithAbort` shapes it. */
function gitExit(args: readonly string[], exitCode: number, stderr: string): Error {
  return Object.assign(new Error(`git ${args.join(' ')} exited with code ${exitCode}: ${stderr}`), { exitCode, timedOut: false });
}

/** A git client whose every call goes to `raw`, so one function scripts a whole run. */
function fakeGit(raw: (args: string[]) => Promise<string>, overrides: Partial<GitClient> = {}): GitClient {
  return {
    raw,
    revparse: async (options) => (await raw(['rev-parse', ...options])).trim(),
    status: async () => ({ files: [], not_added: [] }),
    diff: async () => '',
    diffSummary: async () => ({ changed: 0, insertions: 0, deletions: 0, files: [] }),
    show: async () => '',
    checkout: async () => '',
    merge: async () => '',
    ...overrides,
  };
}

/** Link `linkPath` to `target` the way Kangentic links a folder: a junction on Windows, a symlink elsewhere. */
function makeLink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  createdLinks.push(linkPath);
}

/** Remove a link itself, never what it points at. */
function removeLink(linkPath: string): void {
  try {
    fs.rmdirSync(linkPath);
  } catch {
    fs.rmSync(linkPath, { force: true });
  }
}

function worktreePathFor(folder: string): string {
  return path.join(projectPath, '.kangentic', 'worktrees', folder);
}

beforeEach(() => {
  vi.resetModules();
  hoisted.reportHandledError.mockReset();
  hoisted.makeGit = null;
  hoisted.runGit = null;
  hoisted.baseRef = null;
  hoisted.removeError = null;
  hoisted.removeTargets = [];
  hoisted.renameError = null;
  hoisted.shutdownReadError = null;
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-git-report-')));
  projectPath = path.join(workspace, 'project');
  fs.mkdirSync(projectPath);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Links first, by hand: a recursive delete may follow a junction.
  for (const linkPath of createdLinks.splice(0)) {
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) removeLink(linkPath);
  }
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// worktree-manager.ts
// ---------------------------------------------------------------------------

describe('a worktree base branch that could not be recorded', () => {
  /** A client whose every write of `kangentic.baseBranch` fails on a locked config file. */
  function gitRefusingBaseBranchWrite(): GitClient {
    return fakeGit(async (args) => {
      if (args.includes('kangentic.baseBranch')) {
        throw gitRefusal(`error: could not lock config file ${path.join(projectPath, USER_SLUG, '.git', 'config')}: File exists`, 255);
      }
      return '';
    });
  }

  it('is reported as base_branch_write when a new checkout is configured, and the creation goes on', async () => {
    const git = gitRefusingBaseBranchWrite();
    hoisted.makeGit = () => git;
    hoisted.baseRef = { kind: 'commit', sha: BASE_SHA };
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');

    const created = await new WorktreeManager(projectPath, git).createSpareCheckout('spare_0a1b2c3d', 'main');

    expect(created).toBe(worktreePathFor('spare_0a1b2c3d'));
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'base_branch_write', git_cause: 'other' });
    expectNoUserText();
  });

  it('is reported as base_branch_write when a task claims a spare, and the claim goes on', async () => {
    const git = gitRefusingBaseBranchWrite();
    hoisted.makeGit = () => git;
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');

    const claim = new WorktreeManager(projectPath, git).switchSpareToNewBranch(worktreePathFor('spare_0a1b2c3d'), TASK_BRANCH, BASE_SHA, 'main');

    await expect(claim).resolves.toBeNull();
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'base_branch_write' });
    expectNoUserText();
  });
});

describe('a branch rename after a title edit', () => {
  async function renameWith(stderr: string): Promise<string | null> {
    const git = fakeGit(async (args) => {
      if (args[0] === 'branch' && args[1] === '-m') throw gitRefusal(stderr);
      return '';
    });
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');
    return new WorktreeManager(projectPath, git).renameBranch(TASK_ID, 'old-title-1a2b3c4d', USER_TITLE);
  }

  it('is reported as branch_rename when git refuses it for a reason of its own', async () => {
    const renamed = await renameWith(`fatal: cannot lock ref 'refs/heads/${TASK_BRANCH}': Unable to create lock`);

    expect(renamed).toBeNull();
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'branch_rename', git_cause: 'ref_lock' });
    expectNoUserText();
  });

  it.each([
    ['the new name is taken', `fatal: a branch named '${TASK_BRANCH}' already exists`],
    ['the new name is taken, as an older git words it', `fatal: A branch named '${TASK_BRANCH}' already exists.`],
    ['the agent renamed its own branch', "fatal: no branch named 'old-title-1a2b3c4d'"],
    ['the agent renamed its own branch, as an older git words it', 'error: refname refs/heads/old-title-1a2b3c4d not found\nfatal: Branch rename failed'],
  ])('reports nothing when %s', async (_label, stderr) => {
    expect(await renameWith(stderr)).toBeNull();

    expect(reports()).toEqual([]);
  });
});

describe('a branch delete after a cleanup', () => {
  async function removeWith(exitCode: number, stderr: string): Promise<void> {
    hoisted.runGit = async (_cwd, args) => { throw gitExit(args, exitCode, stderr); };
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');
    await new WorktreeManager(projectPath, fakeGit(async () => '')).removeBranch(TASK_BRANCH);
  }

  it('is reported as branch_remove when git could not delete it', async () => {
    await removeWith(128, `fatal: Unable to create '${path.join(projectPath, USER_SLUG, '.git', 'packed-refs.lock')}': File exists.`);

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'branch_remove', exit_code: '128', timed_out: 'false' });
    expectNoUserText();
  });

  it.each([
    ['the branch is already gone', `error: branch '${TASK_BRANCH}' not found.`],
    ['a worktree still has it out', `error: Cannot delete branch '${TASK_BRANCH}' checked out at '${USER_SLUG}'`],
    ['a worktree still has it out, as a newer git words it', `error: cannot delete branch '${TASK_BRANCH}' used by worktree at '${USER_SLUG}'`],
  ])('reports nothing when %s', async (_label, stderr) => {
    await removeWith(1, stderr);

    expect(reports()).toEqual([]);
  });
});

describe('a listener of worktree removal that throws', () => {
  it('is reported as removed_listener, and the removal still answers true', async () => {
    const { WorktreeManager, setWorktreeRemovedListener } = await import('../../src/main/git/worktree-manager');
    setWorktreeRemovedListener(async () => { throw defect(); });

    const removed = await new WorktreeManager(projectPath, fakeGit(async () => '')).removeWorktree(worktreePathFor('12'));

    expect(removed).toBe(true);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'removed_listener', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('is reported as removing_listener, and the removal still goes ahead', async () => {
    const { WorktreeManager, setWorktreeRemovingListener } = await import('../../src/main/git/worktree-manager');
    setWorktreeRemovingListener(async () => { throw defect(); });

    const removed = await new WorktreeManager(projectPath, fakeGit(async () => '')).removeWorktree(worktreePathFor('12'));

    expect(removed).toBe(true);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'removing_listener', error_name: 'TypeError' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// worktree-links.ts
// ---------------------------------------------------------------------------

describe('a shared folder that could not be linked into a worktree', () => {
  /** A worktree folder with a git folder of its own, and a project that ignores every folder asked about. */
  function prepareWorktree(): string {
    const worktreePath = path.join(workspace, USER_SLUG);
    fs.mkdirSync(path.join(worktreePath, '.git'), { recursive: true });
    hoisted.makeGit = () => fakeGit(async (args) => (args[0] === 'check-ignore' ? `${args[args.length - 1]}\n` : ''));
    return worktreePath;
  }

  it('is reported as link_record when the record of the link cannot be written, and nothing is linked', async () => {
    const worktreePath = prepareWorktree();
    fs.mkdirSync(path.join(projectPath, 'shared-data'));
    hoisted.renameError = errnoError('EPERM', 'rename', path.join(worktreePath, '.git', 'kangentic-links.json'));
    const { linkWorktreeFolders } = await import('../../src/main/git/worktree-links');

    await linkWorktreeFolders(worktreePath, projectPath, ['shared-data']);

    expect(fs.existsSync(path.join(worktreePath, 'shared-data'))).toBe(false);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'link_record', errno: 'EPERM' });
    expectNoUserText();
  });

  it('is reported as link_create when the link itself cannot be made', async () => {
    const worktreePath = prepareWorktree();
    fs.mkdirSync(path.join(projectPath, 'shared', 'data'), { recursive: true });
    // A file where the link's parent folder has to go: the real mkdir fails on it.
    fs.writeFileSync(path.join(worktreePath, 'shared'), 'a file in the way');
    const { linkWorktreeFolders } = await import('../../src/main/git/worktree-links');

    await linkWorktreeFolders(worktreePath, projectPath, ['shared/data']);

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'link_create', errno: 'EEXIST' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// node-modules-link.ts, and what clearWorktreeLinks answers for it
// ---------------------------------------------------------------------------

describe('a node_modules link that will not come out', () => {
  let mainModules: string;
  let sentinel: string;
  let worktreePath: string;
  let linkPath: string;

  /** A worktree whose node_modules links to the main checkout's, and a filesystem that refuses to remove the link. */
  function prepareStuckLink(): void {
    mainModules = path.join(projectPath, 'node_modules');
    fs.mkdirSync(mainModules);
    sentinel = path.join(mainModules, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'the main checkout\'s packages');
    worktreePath = worktreePathFor(USER_SLUG);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'README.md'), 'a checked out file');
    linkPath = path.join(worktreePath, 'node_modules');
    makeLink(mainModules, linkPath);
    const realRmdirSync = fs.rmdirSync.bind(fs);
    const realRmSync = fs.rmSync.bind(fs);
    // Windows removes a junction with rmdir, POSIX a symlink with rm.
    vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
      if (String(target) === linkPath) throw errnoError('EPERM', 'rmdir', linkPath);
      realRmdirSync(target, options);
    });
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === linkPath) throw errnoError('EPERM', 'rm', linkPath);
      realRmSync(target, options);
    });
  }

  it('is reported as link_remove, and clearWorktreeLinks answers that a link is left', async () => {
    prepareStuckLink();
    const { clearWorktreeLinks } = await import('../../src/main/git/worktree-links');

    const cleared = await clearWorktreeLinks(worktreePath);

    expect(cleared).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'link_remove', errno: 'EPERM' });
    expectNoUserText();
  });

  it('refuses the worktree removal: no git worktree remove, no recursive delete, and the main checkout keeps its packages', async () => {
    prepareStuckLink();
    const gitRuns: string[][] = [];
    hoisted.runGit = async (_cwd, args) => {
      gitRuns.push([...args]);
      return { stdout: '', stderr: '' };
    };
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');

    const removed = await new WorktreeManager(projectPath, fakeGit(async () => '')).removeWorktree(worktreePath, { removalProfile: 'fast' });

    expect(removed).toBe(false);
    expect(gitRuns.filter((args) => args[0] === 'worktree' && args[1] === 'remove')).toEqual([]);
    expect(hoisted.removeTargets).toEqual([]);
    expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(stagesReported()).toEqual(['link_remove']);
    // The removal reports its own refusal, as it does for any link that stays.
    expect(reports().find((report) => report.tags.source === 'worktree_removal')?.tags).toMatchObject({ refused: 'true' });
    expectNoUserText();
  });

  it('reports nothing for a real node_modules directory that would not delete, and still answers cleared', async () => {
    worktreePath = worktreePathFor(USER_SLUG);
    fs.mkdirSync(path.join(worktreePath, 'node_modules', 'left-pad'), { recursive: true });
    hoisted.removeError = errnoError('EBUSY', 'unlink', path.join(worktreePath, 'node_modules', 'left-pad'));
    const { clearWorktreeLinks } = await import('../../src/main/git/worktree-links');

    const cleared = await clearWorktreeLinks(worktreePath);

    // Nothing leads out of a real directory, and the removal that follows reports itself.
    expect(cleared).toBe(true);
    expect(reports()).toEqual([]);
  });
});

describe('linking node_modules into a new worktree', () => {
  let worktreePath: string;

  beforeEach(() => {
    fs.mkdirSync(path.join(projectPath, 'node_modules'));
    worktreePath = path.join(workspace, USER_SLUG);
    fs.mkdirSync(worktreePath);
  });

  it('reports nothing when the worktree has no node_modules yet, and makes the link', async () => {
    const { linkNodeModules } = await import('../../src/main/git/node-modules-link');

    await linkNodeModules(worktreePath, projectPath);

    createdLinks.push(path.join(worktreePath, 'node_modules'));
    expect(fs.realpathSync(path.join(worktreePath, 'node_modules'))).toBe(fs.realpathSync(path.join(projectPath, 'node_modules')));
    expect(reports()).toEqual([]);
  });

  it('is reported as link_precheck when what is already there will not come out', async () => {
    const existing = path.join(worktreePath, 'node_modules');
    fs.mkdirSync(path.join(existing, 'left-pad'), { recursive: true });
    hoisted.removeError = errnoError('EBUSY', 'unlink', path.join(existing, 'left-pad'));
    const { linkNodeModules } = await import('../../src/main/git/node-modules-link');

    await linkNodeModules(worktreePath, projectPath);

    const precheck = gitWorktreeReports().find((report) => report.tags.stage === 'link_precheck');
    expect(precheck?.tags).toMatchObject({ source: 'git_worktree', stage: 'link_precheck', errno: 'EBUSY' });
    expectNoUserText();
  });

  it('is reported as link_create when the link cannot be made over a dangling one', async () => {
    const goneTarget = path.join(workspace, 'gone', 'node_modules');
    fs.mkdirSync(goneTarget, { recursive: true });
    makeLink(goneTarget, path.join(worktreePath, 'node_modules'));
    fs.rmSync(path.join(workspace, 'gone'), { recursive: true, force: true });
    const { linkNodeModules } = await import('../../src/main/git/node-modules-link');

    await linkNodeModules(worktreePath, projectPath);

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'link_create', errno: 'EEXIST' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// removed-worktrees.ts
// ---------------------------------------------------------------------------

describe('worktrees a Done move set aside', () => {
  function removedRoot(): string {
    return path.join(projectPath, '.kangentic', 'removed-worktrees');
  }

  /** A removed copy holding one file the filesystem refuses to delete. */
  function prepareStuckCopy(): string {
    const copy = path.join(removedRoot(), `${USER_SLUG}-mabc123-0a1b2c`);
    fs.mkdirSync(copy, { recursive: true });
    const stuck = path.join(copy, 'stuck.txt');
    fs.writeFileSync(stuck, 'held open');
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (target) => {
      if (String(target) === stuck) throw errnoError('EIO', 'unlink', stuck);
      await realUnlink(target);
    });
    return copy;
  }

  it('reports a deleter that stops on an error as removed_deleter', async () => {
    const { scheduleRemovedWorktreeDeletion, _whenRemovedWorktreeDeletionIdleForTests } = await import('../../src/main/git/removed-worktrees');
    hoisted.shutdownReadError = defect();

    scheduleRemovedWorktreeDeletion(projectPath);
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'removed_deleter', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('reports a copy a project delete could not remove as removed_delete, and answers that a link is still under it', async () => {
    const copy = prepareStuckCopy();
    const mainData = path.join(workspace, 'main-data');
    fs.mkdirSync(mainData);
    const sentinel = path.join(mainData, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'the main checkout\'s data');
    fs.mkdirSync(path.join(copy, 'nested'));
    makeLink(mainData, path.join(copy, 'nested', 'datasets'));
    const { deleteRemovedWorktreesNow } = await import('../../src/main/git/removed-worktrees');

    const linkLeft = await deleteRemovedWorktreesNow(projectPath);

    expect(linkLeft).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'removed_delete', errno: 'EIO' });
    expectNoUserText();
  });

  it('answers that no link is left when the copy that stayed holds none', async () => {
    prepareStuckCopy();
    const { deleteRemovedWorktreesNow } = await import('../../src/main/git/removed-worktrees');

    expect(await deleteRemovedWorktreesNow(projectPath)).toBe(false);
    expect(stagesReported()).toEqual(['removed_delete']);
  });

  it('reports nothing, and answers that no link is left, when every copy deletes', async () => {
    const copy = path.join(removedRoot(), `${USER_SLUG}-mabc123-0a1b2c`);
    fs.mkdirSync(path.join(copy, 'src'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'src', 'index.ts'), 'export {};');
    const { deleteRemovedWorktreesNow } = await import('../../src/main/git/removed-worktrees');

    expect(await deleteRemovedWorktreesNow(projectPath)).toBe(false);
    expect(fs.existsSync(copy)).toBe(false);
    expect(reports()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// spare-worktree.ts
// ---------------------------------------------------------------------------

describe('a spare worktree', () => {
  const SPARE_FOLDER = 'spare_0a1b2c3d';
  const inputs = { baseBranch: 'main', initScript: 'npm install', linkNodeModules: true, copyFiles: [], linkFolders: [] };

  async function loadPool() {
    const { SpareWorktreePool } = await import('../../src/main/git/spare-worktree');
    const { WorktreeManager, GIT_QUEUE_CLEARED_MESSAGE } = await import('../../src/main/git/worktree-manager');
    const { _whenRemovedWorktreeDeletionIdleForTests } = await import('../../src/main/git/removed-worktrees');
    return {
      pool: new SpareWorktreePool(),
      WorktreeManager,
      GIT_QUEUE_CLEARED_MESSAGE,
      deleterIdle: () => _whenRemovedWorktreeDeletionIdleForTests(projectPath),
    };
  }

  it('reports a discard the git queue rejected as spare_discard', async () => {
    const { pool, WorktreeManager } = await loadPool();
    vi.spyOn(WorktreeManager.prototype, 'withLock').mockRejectedValue(defect());

    await pool.discard(projectPath, worktreePathFor(SPARE_FOLDER));

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'spare_discard', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('reports nothing for a discard still waiting when its project closed', async () => {
    const { pool, WorktreeManager } = await loadPool();
    let releaseHolder: () => void = () => undefined;
    const holder = WorktreeManager.withGitLock(projectPath, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));

    const discarding = pool.discard(projectPath, worktreePathFor(SPARE_FOLDER));
    WorktreeManager.clearQueue(projectPath);
    await discarding;
    releaseHolder();
    await holder;

    expect(reports()).toEqual([]);
  });

  it('reports a move aside that throws as spare_discard, and still removes the spare in place', async () => {
    const { pool, WorktreeManager, deleterIdle } = await loadPool();
    vi.spyOn(WorktreeManager.prototype, 'moveWorktreeAside').mockRejectedValue(defect());
    const removeInPlace = vi.spyOn(WorktreeManager.prototype, 'removeWorktree').mockResolvedValue(true);

    await pool.discard(projectPath, worktreePathFor(SPARE_FOLDER));
    await deleterIdle();

    expect(removeInPlace).toHaveBeenCalledTimes(1);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'spare_discard', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('reports an in-place removal that throws as spare_discard', async () => {
    const { pool, WorktreeManager, deleterIdle } = await loadPool();
    vi.spyOn(WorktreeManager.prototype, 'moveWorktreeAside').mockResolvedValue(false);
    vi.spyOn(WorktreeManager.prototype, 'removeWorktree').mockRejectedValue(defect());

    await pool.discard(projectPath, worktreePathFor(SPARE_FOLDER));
    await deleterIdle();

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'spare_discard', error_name: 'TypeError' });
    expectNoUserText();
  });

  /** Fail a build's git step with its folder left on disk, then settle its discard with `discardError`. */
  async function buildWhoseDiscardRejects(discardError: (cleared: string) => Error): Promise<boolean> {
    const { pool, WorktreeManager, GIT_QUEUE_CLEARED_MESSAGE } = await loadPool();
    vi.spyOn(WorktreeManager.prototype, 'withLock')
      .mockImplementationOnce(async (_operation: () => Promise<unknown>, options?: { label?: string }) => {
        fs.mkdirSync(worktreePathFor(String(options?.label).replace('build-spare:', '')), { recursive: true });
        throw new Error('the checkout failed');
      })
      .mockImplementationOnce(async () => { throw discardError(GIT_QUEUE_CLEARED_MESSAGE); });
    return pool.build(projectPath, inputs, new AbortController().signal);
  }

  it('reports a failed build whose leftover could not be discarded as spare_discard', async () => {
    expect(await buildWhoseDiscardRejects(() => defect())).toBe(false);

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'spare_discard', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('reports nothing for a failed build whose discard was still waiting when its project closed', async () => {
    expect(await buildWhoseDiscardRejects((cleared) => new Error(cleared))).toBe(false);

    expect(reports()).toEqual([]);
  });

  /** Run the startup pass over one spare with no ready record, with the git queue rejecting its discard. */
  async function sweepWhoseDiscardRejects(discardError: (cleared: string) => Error): Promise<void> {
    fs.mkdirSync(worktreePathFor(SPARE_FOLDER), { recursive: true });
    const { pool, WorktreeManager, GIT_QUEUE_CLEARED_MESSAGE } = await loadPool();
    vi.spyOn(WorktreeManager.prototype, 'withLock').mockRejectedValue(discardError(GIT_QUEUE_CLEARED_MESSAGE));
    await pool.sweep(projectPath, null, () => new Set<string>());
  }

  it('reports a startup pass that could not discard a cut-off spare as spare_discard', async () => {
    await sweepWhoseDiscardRejects(() => defect());

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'spare_discard', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('reports nothing for a startup pass whose discard was still waiting when its project closed', async () => {
    await sweepWhoseDiscardRejects((cleared) => new Error(cleared));

    expect(reports()).toEqual([]);
  });

  it('reports a spare check that throws as spare_check, and builds nothing', async () => {
    const { pool } = await loadPool();
    const build = vi.spyOn(pool, 'build');

    pool.request(projectPath, { inputs: () => { throw defect(); }, referencedFolders: () => new Set<string>() });
    await pool.idle(projectPath);

    expect(build).not.toHaveBeenCalled();
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'spare_check', error_name: 'TypeError' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// zombie-reaper.ts
// ---------------------------------------------------------------------------

describe('a reap whose self-walk throws', () => {
  const rows = [{ pid: 4242, ppid: 1, commandLine: `node ${USER_SLUG}/server.js` }];

  it('is reported as reap_walk by the boot sweep when a reporter is handed in, and by nothing when none is', async () => {
    const reaper = await import('../../src/main/git/zombie-reaper');
    const { gitWorktreeReporter } = await import('../../src/main/git/git-worktree-report');
    vi.spyOn(reaper._internals, 'scanProcesses').mockResolvedValue(rows);
    vi.spyOn(reaper._internals, 'scanLivePids').mockResolvedValue(new Set([4242]));
    vi.spyOn(reaper._internals, 'buildSelfSkipSet').mockImplementation(() => { throw defect(); });

    expect(await reaper.reapWorktreeElectronZombies({ projectPath })).toEqual([]);
    expect(reports()).toEqual([]);

    expect(await reaper.reapWorktreeElectronZombies({ projectPath, failureReporter: gitWorktreeReporter })).toEqual([]);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'reap_walk', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('is reported as reap_walk when a failed worktree removal reaps, through the reporter the removal hands in', async () => {
    // The reap is skipped under NODE_ENV=test, so run as the app does.
    vi.stubEnv('NODE_ENV', 'production');
    const worktreePath = worktreePathFor(USER_SLUG);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'README.md'), 'a checked out file');
    hoisted.runGit = async (_cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw gitExit(args, 128, 'fatal: unable to remove worktree');
      return { stdout: '', stderr: '' };
    };
    hoisted.removeError = errnoError('EBUSY', 'rmdir', worktreePath);
    const reaper = await import('../../src/main/git/zombie-reaper');
    vi.spyOn(reaper._internals, 'scanAllProcessesCached').mockResolvedValue(rows);
    vi.spyOn(reaper._internals, 'buildSelfSkipSet').mockImplementation(() => { throw defect(); });
    const { WorktreeManager } = await import('../../src/main/git/worktree-manager');

    const removed = await new WorktreeManager(projectPath, fakeGit(async () => '')).removeWorktree(worktreePath, { removalProfile: 'fast' });

    expect(removed).toBe(false);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'reap_walk', error_name: 'TypeError' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// diff-watcher.ts
// ---------------------------------------------------------------------------

describe('a Changes panel watch that could not be armed', () => {
  type WatchSite = 'the working tree' | 'the git folder' | 'the git logs folder';

  /**
   * Subscribe to a checkout whose watch of `site` fails with `code`, and resolve
   * once that watch was attempted. Every other watch gets a handle that does nothing.
   */
  async function subscribeWithFailingWatch(site: WatchSite, code: string): Promise<void> {
    const worktreePath = path.join(workspace, USER_SLUG);
    const gitDirectory = path.join(workspace, `${USER_SLUG}.git`);
    const logsDirectory = path.join(gitDirectory, 'logs');
    fs.mkdirSync(worktreePath);
    fs.mkdirSync(logsDirectory, { recursive: true });
    const refused = site === 'the working tree' ? worktreePath : site === 'the git folder' ? gitDirectory : logsDirectory;
    hoisted.makeGit = () => fakeGit(async () => `${gitDirectory}\n`);
    const watch = vi.spyOn(fs, 'watch').mockImplementation(((target: fs.PathLike) => {
      if (String(target) === refused) throw errnoError(code, 'watch', refused);
      return { close: () => undefined };
    }) as unknown as typeof fs.watch);
    const { DiffWatcher } = await import('../../src/main/git/diff-watcher');
    const watcher = new DiffWatcher();

    watcher.subscribe(worktreePath, () => undefined);
    await vi.waitFor(() => expect(watch.mock.calls.map((call) => String(call[0]))).toContain(logsDirectory));
    watcher.closeAll();
  }

  it.each<WatchSite>(['the working tree', 'the git folder', 'the git logs folder'])('is reported as diff_watch for %s', async (site) => {
    await subscribeWithFailingWatch(site, 'EPERM');

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'diff_watch', errno: 'EPERM', syscall: 'watch' });
    expectNoUserText();
  });

  it.each<WatchSite>(['the working tree', 'the git folder', 'the git logs folder'])('reports nothing when %s is simply gone', async (site) => {
    await subscribeWithFailingWatch(site, 'ENOENT');

    expect(reports()).toEqual([]);
  });

  // Linux answers ENOSPC once the user's inotify watch limit is spent, which a
  // machine running a few dev servers reaches on its own. No release changes it.
  it.each(['ENOSPC', 'EMFILE', 'ENFILE'])('reports nothing when the OS is out of watches or handles (%s)', async (code) => {
    await subscribeWithFailingWatch('the working tree', code);

    expect(reports()).toEqual([]);
  });

  it('subscribes to a folder that is not there without throwing, and leaves nothing behind for the next subscribe', async () => {
    const missingPath = path.join(workspace, USER_SLUG, 'removed');
    const watch = vi.spyOn(fs, 'watch').mockImplementation((() => {
      throw errnoError('ENOENT', 'watch', missingPath);
    }) as unknown as typeof fs.watch);
    const { DiffWatcher } = await import('../../src/main/git/diff-watcher');
    const watcher = new DiffWatcher();

    // The real `gitAt` throws at once for a folder that is not there.
    const unsubscribe = watcher.subscribe(missingPath, () => undefined);
    expect(watch).toHaveBeenCalledTimes(1);
    unsubscribe();
    // An entry left behind would answer this from itself and never try the watch again.
    watcher.subscribe(missingPath, () => undefined);

    expect(watch).toHaveBeenCalledTimes(2);
    expect(reports()).toEqual([]);
    watcher.closeAll();
  });
});

// ---------------------------------------------------------------------------
// worktree-head.ts
// ---------------------------------------------------------------------------

describe('the PR ladder\'s git reads', () => {
  it('reports a containment read that fails outside git as head_read, and answers cannot tell', async () => {
    hoisted.makeGit = () => { throw defect(); };
    const { isShaContainedInRef } = await import('../../src/main/git/worktree-head');

    expect(await isShaContainedInRef(projectPath, 'main', HEAD_SHA)).toBeNull();

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'head_read', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('reports a ref listing git refused as refs_read, and answers with no branches', async () => {
    hoisted.makeGit = () => fakeGit(async () => {
      throw gitRefusal(`fatal: not a git repository (or any of the parent directories): ${USER_SLUG}/.git`);
    });
    const { readRefsPointingAtSha } = await import('../../src/main/git/worktree-head');

    expect(await readRefsPointingAtSha(projectPath, HEAD_SHA, 'main')).toEqual({ remoteBranches: [], pointsAtBaseTip: false });

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'refs_read', git_cause: 'not_a_repository' });
    expectNoUserText();
  });

  it('reports nothing from either read for a folder that is gone', async () => {
    const gonePath = path.join(workspace, USER_SLUG, 'reclaimed');
    const { isShaContainedInRef, readRefsPointingAtSha } = await import('../../src/main/git/worktree-head');

    // The real `gitAt` throws for a folder that is not there.
    expect(await isShaContainedInRef(gonePath, 'main', HEAD_SHA)).toBeNull();
    expect(await readRefsPointingAtSha(gonePath, HEAD_SHA, 'main')).toEqual({ remoteBranches: [], pointsAtBaseTip: false });

    expect(reports()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetch-throttle.ts and git-fetch-scheduler.ts
// ---------------------------------------------------------------------------

describe('a base fetch', () => {
  it('reports an outcome observer that throws as fetch_outcome_listener, and still answers a start point', async () => {
    hoisted.runGit = async (_cwd, args) => { throw gitExit(args, 128, "fatal: 'origin' does not appear to be a git repository"); };
    const { fetchIfStale } = await import('../../src/main/git/fetch-throttle');

    const startPoint = await fetchIfStale(fakeGit(async () => ''), projectPath, 'main', { onOutcome: () => { throw defect(); } });

    expect(startPoint).toBe('main');
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'fetch_outcome_listener', error_name: 'TypeError' });
    expectNoUserText();
  });

  it('reports an auto-fetch setting that cannot be read as auto_fetch_config, and the project still opens', async () => {
    const { gitFetchScheduler } = await import('../../src/main/git/git-fetch-scheduler');
    const context = {
      // Another project is focused, so the on-open sweep does not fetch.
      currentProjectId: 'another-project',
      configManager: { getEffectiveConfig: () => { throw defect(); } },
    };

    expect(() => gitFetchScheduler.startForProject(context as never, { id: 'project-1', name: USER_TITLE, path: projectPath } as never)).not.toThrow();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    gitFetchScheduler.stop();

    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'auto_fetch_config', error_name: 'TypeError' });
    expectNoUserText();
  });
});

// ---------------------------------------------------------------------------
// task-changes.ts
// ---------------------------------------------------------------------------

describe('a completed task\'s changes', () => {
  const unreadable = (): GitCommandError => gitRefusal(`fatal: unable to read tree of ${TASK_BRANCH}`);

  it('reports a failed read of the linked commits as changes_commits_in_clone', async () => {
    hoisted.makeGit = () => fakeGit(async (args) => {
      if (args[0] === 'log') throw unreadable();
      return '';
    });
    const { resolveTaskChanges } = await import('../../src/main/git/task-changes');

    const changes = await resolveTaskChanges({
      repoPath: projectPath, baseBranch: 'main', branchName: null, headSha: null, forkPointSha: null, linkedCommitShas: [HEAD_SHA],
    });

    expect(changes.emptyReason).toBe('not-in-clone');
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'changes_commits_in_clone', git_cause: 'other' });
    expectNoUserText();
  });

  it('reports a failed read of an unmerged branch as changes_branch_log', async () => {
    hoisted.makeGit = () => fakeGit(async (args) => {
      const command = args.join(' ');
      if (command.includes('refs/heads/main^{commit}')) return `${BASE_SHA}\n`;
      if (command.includes(`refs/heads/${TASK_BRANCH}^{commit}`)) return `${HEAD_SHA}\n`;
      if (args[0] === 'merge-base') return `${MERGE_BASE_SHA}\n`;
      if (args[0] === 'log') throw unreadable();
      return '';
    });
    const { resolveTaskChanges } = await import('../../src/main/git/task-changes');

    const changes = await resolveTaskChanges({
      repoPath: projectPath, baseBranch: 'main', branchName: TASK_BRANCH, headSha: null, forkPointSha: null, linkedCommitShas: null,
    });

    expect(changes.commits).toEqual([]);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'changes_branch_log', git_cause: 'other' });
    expectNoUserText();
  });

  it('reports a commit whose files could not be read as changes_commit_files, and lists the commit without them', async () => {
    const logLine = [HEAD_SHA, HEAD_SHA.slice(0, 7), PARENT_SHA, 'Dev', '2026-01-01T00:00:00Z', USER_TITLE].join('\x1f');
    hoisted.makeGit = () => fakeGit(
      async (args) => (args[0] === 'log' ? `${logLine}\n` : ''),
      { diffSummary: async () => { throw unreadable(); } },
    );
    const { resolveTaskChanges } = await import('../../src/main/git/task-changes');

    const changes = await resolveTaskChanges({
      repoPath: projectPath, baseBranch: 'main', branchName: null, headSha: null, forkPointSha: null, linkedCommitShas: [HEAD_SHA],
    });

    expect(changes.commits.map((commit) => commit.hash)).toEqual([HEAD_SHA]);
    expect(changes.files).toEqual([]);
    expect(onlyGitWorktreeTags()).toMatchObject({ source: 'git_worktree', stage: 'changes_commit_files', git_cause: 'other' });
    expectNoUserText();
  });
});
