/**
 * Spare worktrees (#958): a project with a Post-Worktree Script keeps one
 * worktree with the script already run, and the next eligible task adopts it
 * in place instead of creating and installing its own.
 *
 * Drives the REAL `ensureTaskWorktree`, `SpareWorktreePool`, `WorktreeManager`
 * and git against a temp repo with a bare origin, and a real init script that
 * records each run and can be told to fail or block inside a spare. Only the
 * IPC context and the task repository are stubs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SpareWorktreePool,
  isSpareWorktreeFolder,
  readSpareRecord,
  spareRecordsRootFor,
  type SpareInputs,
} from '../../src/main/git/spare-worktree';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';
import { resolveWorktreeBase } from '../../src/main/git/base-branch';
import { isWorktreeCreationInFlight, tryHoldWorktreeCreation, waitForWorktreeCreation } from '../../src/main/git/worktree-creation-registry';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { computeAutoBranchName, slugify } from '../../src/shared/slugify';
import { ensureTaskWorktree } from '../../src/main/ipc/helpers/task-git';
import { spareInputsFor, spareHooksFor } from '../../src/main/ipc/helpers/spare-worktrees';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task } from '../../src/shared/types';
import type { EarlyAgentHandle } from '../../src/main/transition-engine/early-agent';

// Real git and real child processes: give the file room under a loaded run.
vi.setConfig({ testTimeout: 90_000 });

let workspace: string;
let projectPath: string;
let otherClonePath: string;
let controlDirectory: string;
let initScript: string;

/**
 * The fake install. Records the run in the worktree and in the control
 * directory, writes a node_modules marker, and inside a spare folder can fail
 * (`fail-spare`) or block until the file is removed (`block-spare`). Like a
 * real incremental install, a cold run (no marker yet) is slow and a warm one
 * is fast, unless `same-time` makes every run slow, as `npm ci` is.
 */
const INSTALL_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const control = process.argv[2];
const cwd = process.cwd();
const name = path.basename(cwd);
const cold = !fs.existsSync(path.join(cwd, 'node_modules', 'installed.txt'));
fs.appendFileSync(path.join(cwd, '.install-runs'), 'run\\n');
fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'node_modules', 'installed.txt'), name);
fs.appendFileSync(path.join(control, 'runs.log'), name + '\\n');
const isSpare = name.startsWith('spare_');
if (isSpare && fs.existsSync(path.join(control, 'fail-spare'))) {
  process.stderr.write('spare install failed');
  process.exit(1);
}
if (isSpare && fs.existsSync(path.join(control, 'block-spare'))) {
  fs.writeFileSync(path.join(control, name + '.started'), '');
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(control, 'block-spare'))) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 25);
} else {
  const slow = cold || fs.existsSync(path.join(control, 'same-time'));
  setTimeout(() => process.exit(0), slow ? 1000 : 0);
}
`;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString().trim();
}

function commit(cwd: string, message: string): void {
  // A developer's global `commit.gpgsign` would prompt or fail with no key here.
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

beforeAll(() => {
  // The real path: git prints a worktree's real path (macOS's `/var` is
  // `/private/var`, and a Windows temp dir can be an 8.3 short name), and
  // `registeredWorktrees()` compares against it.
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-spare-claim-')));
  const originPath = path.join(workspace, 'origin.git');
  projectPath = path.join(workspace, 'project');
  otherClonePath = path.join(workspace, 'other');
  controlDirectory = path.join(workspace, 'control');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(controlDirectory);
  git(workspace, ['init', '-q', '--bare', '-b', 'main', originPath]);
  git(projectPath, ['init', '-q', '-b', 'main']);
  git(projectPath, ['config', 'user.email', 'dev@example.com']);
  git(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\n.install-runs\nnode_modules/\nlocal.env\nshared-data/\ngained-data/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  git(projectPath, ['add', '-A']);
  commit(projectPath, 'initial');
  git(projectPath, ['remote', 'add', 'origin', originPath]);
  git(projectPath, ['push', '-q', '-u', 'origin', 'main']);
  git(workspace, ['clone', '-q', originPath, otherClonePath]);
  git(otherClonePath, ['config', 'user.email', 'dev@example.com']);
  git(otherClonePath, ['config', 'user.name', 'Dev']);
  const scriptPath = path.join(workspace, 'install.js');
  fs.writeFileSync(scriptPath, INSTALL_SCRIPT);
  initScript = `"${process.execPath}" "${scriptPath}" "${controlDirectory}"`;
});

afterAll(async () => {
  fs.rmSync(path.join(controlDirectory, 'block-spare'), { force: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  clearFetchCache();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

beforeEach(() => {
  clearFetchCache();
  fs.rmSync(path.join(controlDirectory, 'fail-spare'), { force: true });
  fs.rmSync(path.join(controlDirectory, 'block-spare'), { force: true });
  fs.rmSync(path.join(controlDirectory, 'same-time'), { force: true });
  fs.rmSync(path.join(spareRecordsRootFor(projectPath), 'no-saving.json'), { force: true });
  fs.writeFileSync(path.join(projectPath, 'local.env'), 'VALUE=1\n');
});

const worktreesRoot = () => path.join(projectPath, '.kangentic', 'worktrees');

function spareFolders(): string[] {
  if (!fs.existsSync(worktreesRoot())) return [];
  return fs.readdirSync(worktreesRoot()).filter((name) => isSpareWorktreeFolder(name));
}

function readySpareFolders(): string[] {
  return spareFolders().filter((folder) => fs.existsSync(path.join(spareRecordsRootFor(projectPath), `${folder}.json`)));
}

function registeredWorktrees(): string[] {
  return git(projectPath, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

function installRuns(worktreePath: string): number {
  const file = path.join(worktreePath, '.install-runs');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

/** Every install run so far, in every worktree and spare, by folder name, oldest first. */
function installRunLog(): string[] {
  const file = path.join(controlDirectory, 'runs.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

/** Push a new commit to origin from another clone, so the project's local main stays behind. */
function advanceOrigin(message: string): string {
  fs.appendFileSync(path.join(otherClonePath, 'README.md'), `${message}\n`);
  git(otherClonePath, ['add', '-A']);
  commit(otherClonePath, message);
  git(otherClonePath, ['push', '-q', 'origin', 'main']);
  return git(otherClonePath, ['rev-parse', 'HEAD']);
}

let nextDisplayId = 1;

function makeTask(title: string, overrides: Partial<Task> = {}): Task {
  const displayId = nextDisplayId++;
  return {
    id: `${String(displayId).padStart(8, '0')}-0000-4000-8000-000000000000`,
    title,
    description: '',
    swimlane_id: 'lane-1',
    position: 0,
    display_id: displayId,
    worktree_path: null,
    worktree_folder: null,
    branch_name: null,
    base_branch: null,
    use_worktree: null,
    agent_override: 'claude',
    session_id: null,
    ...overrides,
  } as unknown as Task;
}

/** The slice of TaskRepository `ensureTaskWorktree` and the pool touch, in memory. */
function makeTaskRepository(tasks: Task[], onRecordWorktree?: (worktreePath: string) => void) {
  const rows = new Map(tasks.map((task) => [task.id, { ...task }]));
  return {
    getById: (taskId: string) => {
      const row = rows.get(taskId);
      return row ? { ...row } : undefined;
    },
    list: () => [...rows.values()].map((row) => ({ ...row })),
    listArchived: () => [] as Task[],
    recordWorktree: vi.fn((taskId: string, worktreePath: string, branchName: string, worktreeFolder: string, baseBranch: string | null) => {
      // Called before the row changes, so a test sees the disk as it was at the record.
      onRecordWorktree?.(worktreePath);
      const row = rows.get(taskId);
      if (row) Object.assign(row, { worktree_path: worktreePath, branch_name: branchName, worktree_folder: worktreeFolder, resolved_base_branch: baseBranch });
    }),
    setWorktreeSkipReason: vi.fn(),
    recoverLegacyWorktreeFolder: vi.fn(() => null),
  };
}

function makeContext(
  pool: SpareWorktreePool,
  projectInitScript: string = initScript,
  gitOverrides: { copyFiles?: string[]; linkFolders?: string[]; defaultBaseBranch?: string } = {},
): IpcContext {
  const config = {
    agent: { execution: {} },
    git: {
      worktreesEnabled: true,
      defaultBaseBranch: gitOverrides.defaultBaseBranch ?? 'main',
      copyFiles: gitOverrides.copyFiles ?? ['local.env'],
      linkFolders: gitOverrides.linkFolders ?? [],
      linkNodeModules: false,
      initScript: projectInitScript,
    },
  };
  return {
    currentProjectPath: projectPath,
    configManager: { getEffectiveConfig: () => config },
    boardConfigManager: { getDefaultBaseBranchForPath: () => undefined },
    projectRepo: { list: () => [] },
    mainWindow: null,
    spareWorktrees: pool,
  } as unknown as IpcContext;
}

/** Build one ready spare directly, the way the pool's loop does. */
async function buildSpare(pool: SpareWorktreePool, context: IpcContext): Promise<string> {
  const before = new Set(readySpareFolders());
  const inputs = spareInputsFor(context, projectPath);
  if (!inputs) throw new Error('the fixture project should have spare inputs');
  expect(await pool.build(projectPath, inputs, new AbortController().signal)).toBe(true);
  const built = readySpareFolders().filter((folder) => !before.has(folder));
  expect(built).toHaveLength(1);
  return built[0];
}

/** Discard every spare left by a test, so the next starts from none. */
async function discardAllSpares(pool: SpareWorktreePool): Promise<void> {
  await pool.stop(projectPath);
  await pool.sweep(projectPath, null, () => new Set());
}

function makeHandle(cwd: string): EarlyAgentHandle & { discard: ReturnType<typeof vi.fn> } {
  let settled = false;
  return {
    sessionId: `early-${path.basename(cwd)}`, taskId: 'task', agentName: 'claude', agentSessionId: 'agent-session',
    command: 'claude', cwd, launchKey: 'key',
    isSettled: () => settled,
    markAdopted: () => { const wasOpen = !settled; settled = true; return wasOpen; },
    discard: vi.fn(async () => { settled = true; }),
  };
}

describe('spare worktrees', () => {
  it('an eligible task adopts the spare at its folder, on its own auto branch, at the current base, and a new spare is built after', async () => {
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    expect(installRuns(sparePath)).toBe(1);

    // The base moves on and a copied file changes after the spare was built.
    const originTip = advanceOrigin('base moved on');
    fs.writeFileSync(path.join(projectPath, 'local.env'), 'VALUE=2\n');
    clearFetchCache();

    const task = makeTask('Adopt the spare');
    const repository = makeTaskRepository([task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);

    const row = repository.getById(task.id) as Task & { resolved_base_branch?: string | null };
    expect(row.worktree_path).toBe(sparePath);
    expect(row.worktree_folder).toBe(spareFolder);
    expect(row.branch_name).toMatch(/^adopt-the-spare-/);
    expect(row.resolved_base_branch).toBe('main');
    expect(git(sparePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(row.branch_name);
    expect(git(sparePath, ['rev-parse', 'HEAD'])).toBe(originTip);
    expect(git(sparePath, ['config', '--get', 'kangentic.baseBranch'])).toBe('main');
    // The copied file again, the script again, and no ready record left.
    expect(fs.readFileSync(path.join(sparePath, 'local.env'), 'utf8')).toBe('VALUE=2\n');
    expect(installRuns(sparePath)).toBe(2);
    expect(fs.existsSync(path.join(spareRecordsRootFor(projectPath), `${spareFolder}.json`))).toBe(false);
    // The install was adopted in place: never moved, never reinstalled from scratch.
    expect(fs.readFileSync(path.join(sparePath, 'node_modules', 'installed.txt'), 'utf8')).toBe(spareFolder);

    // The claim asked for the next spare, built once no script ran.
    await pool.idle(projectPath);
    const refilled = readySpareFolders();
    expect(refilled).toHaveLength(1);
    expect(refilled[0]).not.toBe(spareFolder);

    await discardAllSpares(pool);
  });

  it('a claim re-checks a copied folder, copying only what changed, and a discard leaves a linked folder alone', async () => {
    const copiedFolder = path.join(projectPath, 'local-data');
    const linkedFolder = path.join(projectPath, 'shared-data');
    const sentinel = path.join(linkedFolder, 'sentinel.txt');
    const unchangedFile = path.join(copiedFolder, 'unchanged.txt');
    const changedFile = path.join(copiedFolder, 'changed.txt');
    fs.mkdirSync(copiedFolder);
    fs.mkdirSync(linkedFolder);
    fs.writeFileSync(unchangedFile, 'same');
    fs.writeFileSync(changedFile, 'first');
    fs.writeFileSync(sentinel, 'the main checkout');
    const pool = new SpareWorktreePool();
    const gitOverrides = { copyFiles: ['local-data'], linkFolders: ['shared-data'] };
    const context = makeContext(pool, initScript, gitOverrides);
    try {
      const spareFolder = await buildSpare(pool, context);
      const sparePath = path.join(worktreesRoot(), spareFolder);
      expect(fs.readFileSync(path.join(sparePath, 'local-data', 'changed.txt'), 'utf8')).toBe('first');
      expect(fs.readlinkSync(path.join(sparePath, 'shared-data'))).toBeTruthy();

      fs.writeFileSync(changedFile, 'second, longer');
      const copyFile = vi.spyOn(fs.promises, 'copyFile');
      const task = makeTask('Adopt with a folder');
      const repository = makeTaskRepository([task]);
      await ensureTaskWorktree(context, task, repository as never, projectPath);

      expect(repository.getById(task.id)?.worktree_folder).toBe(spareFolder);
      expect(fs.readFileSync(path.join(sparePath, 'local-data', 'changed.txt'), 'utf8')).toBe('second, longer');
      expect(copyFile.mock.calls.map(([source]) => path.basename(String(source)))).toEqual(['changed.txt']);
      copyFile.mockRestore();

      await pool.idle(projectPath);
      await discardAllSpares(pool);
      await pool.discard(projectPath, sparePath);
      expect(fs.existsSync(sparePath)).toBe(false);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('the main checkout');
    } finally {
      fs.rmSync(copiedFolder, { recursive: true, force: true });
      fs.rmSync(linkedFolder, { recursive: true, force: true });
    }
  });

  it('a claim links a folder the project gained after the spare was built, and stops the build loop before it copies', async () => {
    const gainedFolder = path.join(projectPath, 'gained-data');
    const sentinel = path.join(gainedFolder, 'sentinel.txt');
    const pool = new SpareWorktreePool();
    // In the setting from the start: a changed setting would mismatch the spare.
    const context = makeContext(pool, initScript, { linkFolders: ['gained-data'] });
    try {
      const spareFolder = await buildSpare(pool, context);
      const sparePath = path.join(worktreesRoot(), spareFolder);
      expect(fs.existsSync(path.join(sparePath, 'gained-data'))).toBe(false);

      fs.mkdirSync(gainedFolder);
      fs.writeFileSync(sentinel, 'the main checkout');
      const yieldBuilds = vi.spyOn(pool, 'yieldBuilds');
      const copyWorktreeFiles = vi.spyOn(WorktreeManager.prototype, 'copyWorktreeFiles');
      const task = makeTask('Adopt and link');
      const repository = makeTaskRepository([task]);
      await ensureTaskWorktree(context, task, repository as never, projectPath);

      expect(repository.getById(task.id)?.worktree_folder).toBe(spareFolder);
      expect(fs.readlinkSync(path.join(sparePath, 'gained-data'))).toBeTruthy();
      expect(fs.readFileSync(path.join(sparePath, 'gained-data', 'sentinel.txt'), 'utf8')).toBe('the main checkout');
      expect(yieldBuilds).toHaveBeenCalled();
      expect(copyWorktreeFiles).toHaveBeenCalledTimes(1);
      // A large folder should not share the disk with a build.
      expect(yieldBuilds.mock.invocationCallOrder[0]).toBeLessThan(copyWorktreeFiles.mock.invocationCallOrder[0]);

      await pool.idle(projectPath);
      await discardAllSpares(pool);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('the main checkout');
    } finally {
      fs.rmSync(gainedFolder, { recursive: true, force: true });
    }
  });

  it('a task with a base branch of its own, or a custom branch, gets a fresh worktree and leaves the spare', async () => {
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    const spareFolder = await buildSpare(pool, context);

    const withBase = makeTask('Has its own base', { base_branch: 'main' });
    const withBranch = makeTask('Has a custom branch', { branch_name: 'feature/custom-spare-test' });
    const repository = makeTaskRepository([withBase, withBranch]);
    await ensureTaskWorktree(context, withBase, repository as never, projectPath);
    await ensureTaskWorktree(context, withBranch, repository as never, projectPath);

    expect(repository.getById(withBase.id)?.worktree_path).toBe(path.join(worktreesRoot(), String(withBase.display_id)));
    expect(repository.getById(withBranch.id)?.worktree_path).toBe(path.join(worktreesRoot(), String(withBranch.display_id)));
    expect(repository.getById(withBranch.id)?.branch_name).toBe('feature/custom-spare-test');
    // The spare is untouched and still ready.
    expect(readySpareFolders()).toEqual([spareFolder]);
    expect(installRuns(path.join(worktreesRoot(), spareFolder))).toBe(1);

    await discardAllSpares(pool);
  });

  it('a claim whose catch-up script fails discards the spare and creates a fresh worktree', async () => {
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    fs.writeFileSync(path.join(controlDirectory, 'fail-spare'), '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const task = makeTask('Claim fails over');
    const repository = makeTaskRepository([task]);
    const runsBefore = installRunLog().length;
    await ensureTaskWorktree(context, task, repository as never, projectPath);

    const freshPath = path.join(worktreesRoot(), String(task.display_id));
    const row = repository.getById(task.id);
    expect(row?.worktree_path).toBe(freshPath);
    expect(row?.worktree_folder).toBe(String(task.display_id));
    // The branch the claim made is the fresh worktree's now, not the spare's.
    expect(git(freshPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(row?.branch_name);
    expect(fs.existsSync(sparePath)).toBe(false);
    expect(registeredWorktrees()).not.toContain(path.resolve(sparePath));
    expect(installRuns(freshPath)).toBe(1);

    // The start asked for a spare, whose build failed the same way, and the
    // loop stopped rather than retrying on its own: exactly one new spare ran
    // its script, once.
    await pool.idle(projectPath);
    expect(readySpareFolders()).toEqual([]);
    const refillRuns = installRunLog().slice(runsBefore).filter((folder) => isSpareWorktreeFolder(folder) && folder !== spareFolder);
    expect(refillRuns).toHaveLength(1);
    vi.restoreAllMocks();
    await discardAllSpares(pool);
  });

  it('a failed claim whose spare cannot be removed still frees its branch for the fresh worktree', async () => {
    // On Windows a removal can fail (a held file, antivirus) and leave git's
    // record of the spare behind, with the task's auto branch still checked out
    // there after `switch -c`. The fresh creation adds that branch to a new
    // worktree, which git refuses while any worktree has it out, so the
    // discard detaches the spare's HEAD first.
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    fs.writeFileSync(path.join(controlDirectory, 'fail-spare'), '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const moveAside = vi.spyOn(WorktreeManager.prototype, 'moveWorktreeAside').mockResolvedValue(false);
    const remove = vi.spyOn(WorktreeManager.prototype, 'removeWorktree').mockResolvedValue(false);

    const task = makeTask('Spare stays stuck');
    const repository = makeTaskRepository([task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);

    const freshPath = path.join(worktreesRoot(), String(task.display_id));
    const row = repository.getById(task.id);
    expect(moveAside).toHaveBeenCalledWith(sparePath, expect.objectContaining({ ownCreation: true }));
    expect(row?.worktree_path).toBe(freshPath);
    expect(git(freshPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(row?.branch_name);
    // The spare is still on disk and registered, but holds no branch.
    expect(registeredWorktrees()).toContain(path.resolve(sparePath));
    expect(git(sparePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');

    await pool.idle(projectPath);
    moveAside.mockRestore();
    remove.mockRestore();
    vi.restoreAllMocks();
    await discardAllSpares(pool);
  });

  it('hold-prompt: the agent starts at the spare, and a failed claim discards it before the fresh worktree starts another', async () => {
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    fs.writeFileSync(path.join(controlDirectory, 'fail-spare'), '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handles: Array<ReturnType<typeof makeHandle>> = [];
    const launchAgent = vi.fn(async (worktreePath: string) => {
      const handle = makeHandle(worktreePath);
      handles.push(handle);
      return handle;
    });
    const task = makeTask('Early agent on a spare');
    const repository = makeTaskRepository([task]);
    const earlyAgent = await ensureTaskWorktree(context, task, repository as never, projectPath, {
      initScript: { mode: 'hold-prompt', launchAgent },
    });

    const freshPath = path.join(worktreesRoot(), String(task.display_id));
    expect(launchAgent.mock.calls.map((call) => call[0])).toEqual([sparePath, freshPath]);
    expect(handles[0].discard).toHaveBeenCalledTimes(1);
    expect(handles[0].discard.mock.invocationCallOrder[0]).toBeLessThan(launchAgent.mock.invocationCallOrder[1]);
    expect(handles[1].discard).not.toHaveBeenCalled();
    expect(earlyAgent).toBe(handles[1]);
    expect(repository.getById(task.id)?.worktree_path).toBe(freshPath);

    await pool.idle(projectPath);
    vi.restoreAllMocks();
    await discardAllSpares(pool);
  });

  it('the startup pass removes a half-built spare and one with stale settings, and keeps a ready one', async () => {
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    const halfBuilt = await buildSpare(pool, context);
    fs.rmSync(path.join(spareRecordsRootFor(projectPath), `${halfBuilt}.json`));
    const ready = await buildSpare(pool, context);

    const inputs = spareInputsFor(context, projectPath);
    await pool.sweep(projectPath, inputs, () => new Set());
    expect(spareFolders()).toEqual([ready]);
    expect(registeredWorktrees()).not.toContain(path.resolve(path.join(worktreesRoot(), halfBuilt)));

    // The script changed since the spare was built: stale, so it goes too.
    await pool.sweep(projectPath, inputs ? { ...inputs, initScript: 'pnpm install' } : null, () => new Set());
    expect(spareFolders()).toEqual([]);
    expect(fs.existsSync(spareRecordsRootFor(projectPath)) ? fs.readdirSync(spareRecordsRootFor(projectPath)) : []).toEqual([]);
  });

  it('the startup pass keeps a spare folder a task adopted', async () => {
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    const spareFolder = await buildSpare(pool, context);
    const task = makeTask('Adopted then swept');
    const repository = makeTaskRepository([task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);
    await pool.idle(projectPath);
    expect(repository.getById(task.id)?.worktree_folder).toBe(spareFolder);

    // The adopted folder has no ready record now, but a task names it.
    const hooks = spareHooksFor(context, projectPath, repository);
    await pool.sweep(projectPath, null, hooks.referencedFolders);
    expect(spareFolders()).toEqual([spareFolder]);
  });

  it('a task\'s setup stops a spare build, which builds again once no script runs', async () => {
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    // Clear spares and task worktrees the earlier tests left, so the loop has
    // no usable spare and builds one.
    await discardAllSpares(pool);
    fs.writeFileSync(path.join(controlDirectory, 'block-spare'), '');
    const repository = makeTaskRepository([]);
    pool.request(projectPath, spareHooksFor(context, projectPath, repository));

    const firstStarted = await waitForStartedSpare(new Set());
    pool.yieldBuilds();
    const secondStarted = await waitForStartedSpare(new Set([firstStarted]));
    expect(secondStarted).not.toBe(firstStarted);
    fs.rmSync(path.join(controlDirectory, 'block-spare'));
    await pool.idle(projectPath);

    expect(readySpareFolders()).toEqual([secondStarted]);
    expect(fs.existsSync(path.join(worktreesRoot(), firstStarted))).toBe(false);
    await discardAllSpares(pool);
  });

  it('a spare whose catch-up is as slow as its own install is not refilled, until the init script changes', async () => {
    // `npm ci` deletes node_modules and installs it all again, so a claim's
    // catch-up costs a whole install and a spare saves nothing but idle disk.
    // The adopted spare still serves its task; only the refill stops.
    const pool = new SpareWorktreePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    fs.writeFileSync(path.join(controlDirectory, 'same-time'), '');
    const spareFolder = await buildSpare(pool, context);

    const task = makeTask('Install every time');
    const repository = makeTaskRepository([task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);
    await pool.idle(projectPath);

    expect(repository.getById(task.id)?.worktree_folder).toBe(spareFolder);
    const verdictPath = path.join(spareRecordsRootFor(projectPath), 'no-saving.json');
    const verdict = JSON.parse(fs.readFileSync(verdictPath, 'utf8')) as { initScript: string; catchUpMs: number; buildInstallMs: number };
    expect(verdict.initScript).toBe(spareInputsFor(context, projectPath)?.initScript);
    expect(verdict.catchUpMs).toBeGreaterThanOrEqual(verdict.buildInstallMs * 0.5);
    expect(readySpareFolders()).toEqual([]);
    // The startup pass leaves the finding in place.
    await pool.sweep(projectPath, spareInputsFor(context, projectPath), () => new Set());
    expect(fs.existsSync(verdictPath)).toBe(true);

    // A changed script is a new question: the pool builds a spare again.
    const changedContext = makeContext(pool, `${initScript} changed`);
    pool.request(projectPath, spareHooksFor(changedContext, projectPath, repository));
    await pool.idle(projectPath);
    expect(readySpareFolders()).toHaveLength(1);
    await discardAllSpares(pool);
  });

  it('building a spare never touches an agent adapter, so no trust entry is written for its path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/main/git/spare-worktree.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\.\/agent\//);
    expect(source).not.toMatch(/ensureTrust\(/);
  });
});

/**
 * A pool the afterEach below stops and sweeps, so a test that fails halfway
 * cannot leave a refill build or a spare for the next test to trip over.
 */
const poolsInUse: SpareWorktreePool[] = [];

function makePool(): SpareWorktreePool {
  const pool = new SpareWorktreePool();
  poolsInUse.push(pool);
  return pool;
}

afterEach(async () => {
  // Unblock first: a stopped build waits on its script, and a script held by
  // `block-spare` would otherwise outlive the failed test.
  fs.rmSync(path.join(controlDirectory, 'block-spare'), { force: true });
  fs.rmSync(path.join(controlDirectory, 'fail-spare'), { force: true });
  vi.restoreAllMocks();
  for (const pool of poolsInUse.splice(0)) await discardAllSpares(pool);
});

/** What the pool builds a spare from under `context`. */
function inputsOf(context: IpcContext): SpareInputs {
  const inputs = spareInputsFor(context, projectPath);
  if (!inputs) throw new Error('the fixture project should have spare inputs');
  return inputs;
}

/** The auto branch a task gets, as the claim and a fresh creation both name it. */
function autoBranchFor(task: Task): string {
  return computeAutoBranchName(slugify(task.title) || 'task', task.id.slice(0, 8));
}

/** Rewrite one ready record's build time, so a test controls which spare is the newest. */
function setBuiltAt(folder: string, builtAt: string): void {
  const recordFile = path.join(spareRecordsRootFor(projectPath), `${folder}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, builtAt }, null, 2));
}

/**
 * Build two ready spares and set their build times. Folder names are random
 * and a listing comes back sorted by name, so the newest is the one that sorts
 * LAST: a claim that took the first one listed would take the older spare.
 */
async function buildSparesByAge(pool: SpareWorktreePool, context: IpcContext): Promise<{ older: string; newer: string }> {
  const first = await buildSpare(pool, context);
  const second = await buildSpare(pool, context);
  const [older, newer] = [first, second].sort();
  setBuiltAt(older, '2026-01-01T00:00:00.000Z');
  setBuiltAt(newer, '2026-01-02T00:00:00.000Z');
  const olderRecord = await readSpareRecord(projectPath, older);
  const newerRecord = await readSpareRecord(projectPath, newer);
  expect(olderRecord?.builtAt).toBe('2026-01-01T00:00:00.000Z');
  expect(newerRecord?.builtAt).toBe('2026-01-02T00:00:00.000Z');
  return { older, newer };
}

/** Resolves once the script blocked inside `folder` has started (`block-spare` writes `<folder>.started` first). */
async function waitForBlockedScript(folder: string): Promise<void> {
  const startedFile = path.join(controlDirectory, `${folder}.started`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(startedFile)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the script in ${folder} never started`);
}

describe('spare worktrees: background mode, aborts and claim guards', () => {
  it('background mode: the claim\'s catch-up script runs before the worktree is recorded, and the task is recorded at the spare', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    expect(installRuns(sparePath)).toBe(1);

    const task = makeTask('Background claim');
    const installRunsWhenRecorded: number[] = [];
    const repository = makeTaskRepository([task], (worktreePath) => installRunsWhenRecorded.push(installRuns(worktreePath)));
    const earlyAgent = await ensureTaskWorktree(context, task, repository as never, projectPath, {
      initScript: { mode: 'background' },
    });

    // The fresh path of this mode records first and runs the script after. A
    // claim waits out its few-second catch-up instead, so a failure lands
    // before anything is recorded: the record sees the script's second run.
    expect(earlyAgent).toBeNull();
    expect(installRunsWhenRecorded).toEqual([2]);
    expect(repository.recordWorktree).toHaveBeenCalledTimes(1);
    const row = repository.getById(task.id);
    expect(row?.worktree_path).toBe(sparePath);
    expect(row?.worktree_folder).toBe(spareFolder);
    expect(installRuns(sparePath)).toBe(2);

    await pool.idle(projectPath);
    await discardAllSpares(pool);
  });

  it('background mode: a failing catch-up discards the spare and the task gets a fresh numeric worktree', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    fs.writeFileSync(path.join(controlDirectory, 'fail-spare'), '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const task = makeTask('Background claim fails over');
    const freshPath = path.join(worktreesRoot(), String(task.display_id));
    const recordedPaths: string[] = [];
    const repository = makeTaskRepository([task], (worktreePath) => recordedPaths.push(worktreePath));
    try {
      const earlyAgent = await ensureTaskWorktree(context, task, repository as never, projectPath, {
        initScript: { mode: 'background' },
      });
      expect(earlyAgent).toBeNull();

      // The fresh worktree's script runs on past the return, under the
      // creation's hold, and the refill the start asked for follows it.
      await waitForWorktreeCreation(freshPath);
      await new Promise((resolve) => setImmediate(resolve));
      await pool.idle(projectPath);

      // The spare was never recorded: the only record is the fresh worktree's.
      expect(recordedPaths).toEqual([freshPath]);
      const row = repository.getById(task.id);
      expect(row?.worktree_path).toBe(freshPath);
      expect(row?.worktree_folder).toBe(String(task.display_id));
      expect(git(freshPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(row?.branch_name);
      expect(installRuns(freshPath)).toBe(1);
      expect(fs.existsSync(sparePath)).toBe(false);
      expect(registeredWorktrees()).not.toContain(path.resolve(sparePath));
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(path.join(controlDirectory, 'fail-spare'), { force: true });
    }
    await discardAllSpares(pool);
  });

  it('aborting a task during its claim\'s catch-up script discards the spare and leaves the task no worktree', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    const task = makeTask('Abort during the claim');
    const numericPath = path.join(worktreesRoot(), String(task.display_id));
    const repository = makeTaskRepository([task]);
    const controller = new AbortController();
    // Blocks the catch-up script inside the spare. Removed only after the
    // rejection is seen: a script that exited 0 first would not be aborted.
    fs.writeFileSync(path.join(controlDirectory, 'block-spare'), '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let rejection: unknown;
    try {
      const settled = ensureTaskWorktree(context, task, repository as never, projectPath, { signal: controller.signal })
        .then(() => null, (error: unknown) => error);
      await waitForBlockedScript(spareFolder);
      expect(isWorktreeCreationInFlight(sparePath)).toBe(true);
      controller.abort();
      rejection = await settled;
    } finally {
      fs.rmSync(path.join(controlDirectory, 'block-spare'), { force: true });
      vi.restoreAllMocks();
    }

    expect(rejection).toMatchObject({ name: 'AbortError' });
    // No fresh worktree was started in its place, and nothing was recorded.
    expect(fs.existsSync(numericPath)).toBe(false);
    expect(registeredWorktrees()).not.toContain(path.resolve(numericPath));
    expect(repository.recordWorktree).not.toHaveBeenCalled();
    expect(repository.getById(task.id)?.worktree_path).toBeNull();
    // The spare is gone, and neither path stays held.
    expect(fs.existsSync(sparePath)).toBe(false);
    expect(registeredWorktrees()).not.toContain(path.resolve(sparePath));
    expect(readySpareFolders()).not.toContain(spareFolder);
    expect(isWorktreeCreationInFlight(sparePath)).toBe(false);
    expect(isWorktreeCreationInFlight(numericPath)).toBe(false);

    await discardAllSpares(pool);
  });

  it('a signal already aborted before the call rejects and leaves the spare ready and untouched', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);
    const controller = new AbortController();
    controller.abort();

    const task = makeTask('Aborted before it began');
    const repository = makeTaskRepository([task]);
    await expect(ensureTaskWorktree(context, task, repository as never, projectPath, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    // The pool alone refuses too, whatever the caller checked first.
    const claimTask = makeTask('Aborted before its claim');
    await expect(pool.claim({
      projectPath,
      task: claimTask,
      inputs: inputsOf(context),
      referencedFolders: () => new Set(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(readySpareFolders()).toEqual([spareFolder]);
    expect(installRuns(sparePath)).toBe(1);
    expect(git(sparePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(registeredWorktrees()).toContain(path.resolve(sparePath));
    expect(isWorktreeCreationInFlight(sparePath)).toBe(false);
    expect(repository.recordWorktree).not.toHaveBeenCalled();
    expect(repository.getById(task.id)?.worktree_path).toBeNull();
    expect(fs.existsSync(path.join(worktreesRoot(), String(task.display_id)))).toBe(false);
    for (const claimed of [task, claimTask]) {
      expect(git(projectPath, ['branch', '--list', autoBranchFor(claimed)])).toBe('');
    }

    await discardAllSpares(pool);
  });

  it('a spare built from other settings than the project has now is discarded by the claim, and the task gets a fresh worktree', async () => {
    const pool = makePool();
    await discardAllSpares(pool);
    const spareFolder = await buildSpare(pool, makeContext(pool));
    const sparePath = path.join(worktreesRoot(), spareFolder);

    // The project's copy list changed after the spare was built.
    const context = makeContext(pool, initScript, { copyFiles: [] });
    const task = makeTask('Settings moved on');
    const repository = makeTaskRepository([task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);

    const freshPath = path.join(worktreesRoot(), String(task.display_id));
    const row = repository.getById(task.id);
    expect(row?.worktree_path).toBe(freshPath);
    expect(row?.worktree_folder).toBe(String(task.display_id));
    expect(git(freshPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(row?.branch_name);
    // The stale spare was taken off its path, not adopted or left to be claimed later.
    expect(fs.existsSync(sparePath)).toBe(false);
    expect(registeredWorktrees()).not.toContain(path.resolve(sparePath));
    expect(readySpareFolders()).not.toContain(spareFolder);

    await discardAllSpares(pool);
  });

  it('a task whose auto branch already exists leaves the spare ready and gets a fresh worktree on that branch', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);

    // An earlier, aborted creation for this task left its branch.
    const task = makeTask('Branch left behind');
    const branchName = autoBranchFor(task);
    git(projectPath, ['branch', branchName, 'main']);
    const repository = makeTaskRepository([task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);

    const freshPath = path.join(worktreesRoot(), String(task.display_id));
    const row = repository.getById(task.id);
    expect(row?.worktree_path).toBe(freshPath);
    expect(row?.branch_name).toBe(branchName);
    expect(git(freshPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branchName);
    // The spare was neither switched onto the branch nor discarded.
    await pool.idle(projectPath);
    expect(readySpareFolders()).toEqual([spareFolder]);
    expect(installRuns(sparePath)).toBe(1);
    expect(git(sparePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(registeredWorktrees()).toContain(path.resolve(sparePath));

    await discardAllSpares(pool);
  });

  it('a claim whose base no longer resolves returns null and leaves the spare ready', async () => {
    // Its own repository: the fixture project always keeps `main`, which the
    // base resolver falls back to when a configured base goes missing. This one
    // has no remote and no `main` or `master`, so renaming its only branch
    // leaves the spare's base resolving nowhere.
    const pool = makePool();
    await discardAllSpares(pool);
    const soloPath = fs.mkdtempSync(path.join(workspace, 'solo-'));
    git(soloPath, ['init', '-q', '-b', 'trunk']);
    git(soloPath, ['config', 'user.email', 'dev@example.com']);
    git(soloPath, ['config', 'user.name', 'Dev']);
    fs.writeFileSync(path.join(soloPath, '.gitignore'), '.kangentic/\n.install-runs\nnode_modules/\n');
    fs.writeFileSync(path.join(soloPath, 'README.md'), 'solo\n');
    git(soloPath, ['add', '-A']);
    commit(soloPath, 'initial');
    const inputs: SpareInputs = { baseBranch: 'trunk', initScript, linkNodeModules: false, copyFiles: [], linkFolders: [] };

    expect(await pool.build(soloPath, inputs, new AbortController().signal)).toBe(true);
    const soloWorktrees = path.join(soloPath, '.kangentic', 'worktrees');
    const [spareFolder] = fs.readdirSync(soloWorktrees).filter((name) => isSpareWorktreeFolder(name));
    const sparePath = path.join(soloWorktrees, spareFolder);
    expect(await readSpareRecord(soloPath, spareFolder)).not.toBeNull();
    expect((await resolveWorktreeBase(soloPath, null, 'trunk')).kind).toBe('resolved');

    git(soloPath, ['branch', '-m', 'trunk', 'renamed']);
    clearFetchCache();
    expect((await resolveWorktreeBase(soloPath, null, 'trunk')).kind).toBe('unresolvable');

    const task = makeTask('Base went missing');
    const claimed = await pool.claim({ projectPath: soloPath, task, inputs, referencedFolders: () => new Set() });
    try {
      expect(claimed).toBeNull();
      expect(await readSpareRecord(soloPath, spareFolder)).not.toBeNull();
      expect(git(sparePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
      expect(installRuns(sparePath)).toBe(1);
      expect(git(soloPath, ['branch', '--list', autoBranchFor(task)])).toBe('');
    } finally {
      claimed?.release();
      await pool.stop(soloPath);
      await pool.sweep(soloPath, null, () => new Set());
    }
    expect(fs.existsSync(sparePath)).toBe(false);
    await discardAllSpares(pool);
  });

  it('with two ready spares the claim takes the newest by build time', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const { older, newer } = await buildSparesByAge(pool, context);

    const task = makeTask('Takes the newest');
    const claimed = await pool.claim({ projectPath, task, inputs: inputsOf(context), referencedFolders: () => new Set() });
    try {
      expect(claimed?.result.worktreeFolder).toBe(newer);
      expect(readySpareFolders()).toEqual([older]);
    } finally {
      claimed?.release();
    }

    await discardAllSpares(pool);
  });

  it('a spare something holds is skipped, and the claim takes the older one', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const { older, newer } = await buildSparesByAge(pool, context);
    const releaseHold = tryHoldWorktreeCreation(path.join(worktreesRoot(), newer));
    expect(releaseHold).not.toBeNull();

    const task = makeTask('Newest is busy');
    const laterTask = makeTask('Newest is free again');
    let claimed: Awaited<ReturnType<SpareWorktreePool['claim']>> = null;
    let laterClaimed: Awaited<ReturnType<SpareWorktreePool['claim']>> = null;
    try {
      claimed = await pool.claim({ projectPath, task, inputs: inputsOf(context), referencedFolders: () => new Set() });
      expect(claimed?.result.worktreeFolder).toBe(older);
      expect(readySpareFolders()).toEqual([newer]);

      // Skipped, not spent: once the hold ends the newest is claimable.
      releaseHold?.();
      laterClaimed = await pool.claim({ projectPath, task: laterTask, inputs: inputsOf(context), referencedFolders: () => new Set() });
      expect(laterClaimed?.result.worktreeFolder).toBe(newer);
    } finally {
      releaseHold?.();
      claimed?.release();
      laterClaimed?.release();
    }

    await discardAllSpares(pool);
  });

  it('a spare a task row names, by folder or by path, is never taken', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const { older, newer } = await buildSparesByAge(pool, context);

    const namesFolder = makeTask('Names a folder', { worktree_folder: newer });
    const namesPath = makeTask('Names a path', { worktree_path: path.join(worktreesRoot(), older) });
    const task = makeTask('Wants a spare');
    const repository = makeTaskRepository([namesFolder, namesPath, task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);

    const row = repository.getById(task.id);
    expect(row?.worktree_path).toBe(path.join(worktreesRoot(), String(task.display_id)));
    expect(row?.worktree_folder).toBe(String(task.display_id));
    // Both stay ready and unchanged; a refill may add a third.
    expect(readySpareFolders()).toEqual(expect.arrayContaining([older, newer]));
    expect(installRuns(path.join(worktreesRoot(), older))).toBe(1);
    expect(installRuns(path.join(worktreesRoot(), newer))).toBe(1);

    await discardAllSpares(pool);
  });

  it('two tasks started together never take the same spare', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const spareFolder = await buildSpare(pool, context);
    const sparePath = path.join(worktreesRoot(), spareFolder);

    const first = makeTask('Races for the spare');
    const second = makeTask('Races for it too');
    const repository = makeTaskRepository([first, second]);
    await Promise.all([
      ensureTaskWorktree(context, first, repository as never, projectPath),
      ensureTaskWorktree(context, second, repository as never, projectPath),
    ]);

    const rows = [first, second].map((task) => repository.getById(task.id));
    expect(rows.filter((row) => row?.worktree_folder === spareFolder)).toHaveLength(1);
    const loser = rows.find((row) => row?.worktree_folder !== spareFolder);
    expect(loser?.worktree_path).toBe(path.join(worktreesRoot(), String(loser?.display_id)));
    // One build and one catch-up in the spare, not two.
    expect(installRuns(sparePath)).toBe(2);

    await discardAllSpares(pool);
  });

  it('two tasks started together each take a different spare when there are two', async () => {
    const pool = makePool();
    const context = makeContext(pool);
    await discardAllSpares(pool);
    const { older, newer } = await buildSparesByAge(pool, context);

    const first = makeTask('Races for a spare');
    const second = makeTask('Races for another');
    const repository = makeTaskRepository([first, second]);
    await Promise.all([
      ensureTaskWorktree(context, first, repository as never, projectPath),
      ensureTaskWorktree(context, second, repository as never, projectPath),
    ]);

    const folders = [first, second].map((task) => repository.getById(task.id)?.worktree_folder);
    expect([...folders].sort()).toEqual([older, newer]);
    expect(installRuns(path.join(worktreesRoot(), older))).toBe(2);
    expect(installRuns(path.join(worktreesRoot(), newer))).toBe(2);

    await discardAllSpares(pool);
  });
});

/** The folder of the first spare build whose script has started and is not in `seen`. */
async function waitForStartedSpare(seen: Set<string>): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const started = fs.readdirSync(controlDirectory)
      .filter((name) => name.endsWith('.started'))
      .map((name) => name.slice(0, -'.started'.length))
      .find((folder) => !seen.has(folder));
    if (started) return started;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no spare build started its script');
}
