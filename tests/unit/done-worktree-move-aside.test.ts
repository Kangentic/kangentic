/**
 * A Done move's worktree removal stays off the disk while an init script runs.
 *
 * A Done move used to delete its worktree's node_modules in place while the
 * next task's install ran, and the install slowed. Now the Done move renames the worktree into `.kangentic/removed-worktrees/`
 * at once, and a deleter empties it in batches, waiting before each batch
 * while any Post-Worktree Script runs.
 *
 * Drives the REAL `deleteTaskWorktree`, `ensureTaskWorktree`, `WorktreeManager`,
 * deleter and git against a temp repo, with a real script that blocks until the
 * test releases it (the fixture of `worktree-setup-outside-queue.test.ts`).
 * Whether the deleter progresses is read from its own state, never from a
 * timed wait.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';
import { isAnyInitScriptRunning } from '../../src/main/git/run-init-script';
import {
  assertRemovedWorktreeEntry,
  deleteRemovedWorktreesNow,
  deleteTreeWithoutFollowingLinks,
  moveIntoRemovedWorktrees,
  removedWorktreesRootFor,
  scheduleRemovedWorktreeDeletion,
  stopRemovedWorktreeDeletion,
  _removedWorktreeDeletionStateForTests,
  _resetRemovedWorktreeDeletionForTests,
  _setRemovedWorktreeBatchHookForTests,
  _whenRemovedWorktreeDeletionIdleForTests,
} from '../../src/main/git/removed-worktrees';
import { removeNodeModulesLinkOnly } from '../../src/main/git/node-modules-link';
import { ensureTaskWorktree } from '../../src/main/ipc/helpers/task-git';
import { deleteTaskWorktree } from '../../src/main/ipc/helpers/task-cleanup';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Task } from '../../src/shared/types';

// Real git and real child processes: give the file room under a loaded run.
vi.setConfig({ testTimeout: 60_000 });

let workspace: string;
let projectPath: string;
let releaseDirectory: string;
let initScript: string;

/**
 * The fake install: records its pid on start, then waits until the test drops
 * a release file named after its worktree folder.
 */
const BLOCKING_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const releaseDirectory = process.argv[2];
const name = path.basename(process.cwd());
fs.writeFileSync(path.join(releaseDirectory, name + '.started'), String(process.pid));
const releaseFile = path.join(releaseDirectory, name + '.release');
const timer = setInterval(() => {
  if (fs.existsSync(releaseFile)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 25);
`;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

beforeAll(() => {
  // The real path: git records one, and os.tmpdir() can be an alias of it (a
  // /var symlink on macOS, an 8.3 short name on Windows), which would make
  // every worktree-list comparison below miss.
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-done-move-aside-')));
  projectPath = path.join(workspace, 'project');
  releaseDirectory = path.join(workspace, 'release');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(releaseDirectory);
  run(projectPath, ['init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\nnode_modules/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  run(projectPath, ['add', '-A']);
  // A developer's global `commit.gpgsign` would prompt or fail with no key here.
  run(projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  const scriptPath = path.join(workspace, 'blocking-install.js');
  fs.writeFileSync(scriptPath, BLOCKING_SCRIPT);
  initScript = `"${process.execPath}" "${scriptPath}" "${releaseDirectory}"`;
  clearFetchCache();
});

afterEach(async () => {
  _setRemovedWorktreeBatchHookForTests(null);
  await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
});

afterAll(async () => {
  // Let any script still waiting exit before the tree goes: one still running
  // holds its worktree as its cwd.
  const folders = ['1', '2', '3', '4', '5', '6'];
  for (const folder of folders) release(folder);
  for (const folder of folders) {
    const startedFile = path.join(releaseDirectory, `${folder}.started`);
    if (!fs.existsSync(startedFile)) continue;
    const scriptPid = Number(fs.readFileSync(startedFile, 'utf8'));
    await until(() => !isProcessAlive(scriptPid), `the setup script in worktree ${folder} to exit`);
  }
  _resetRemovedWorktreeDeletionForTests();
  clearFetchCache();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function worktreePathFor(folder: string): string {
  return path.join(projectPath, '.kangentic', 'worktrees', folder);
}

function release(folder: string): void {
  fs.writeFileSync(path.join(releaseDirectory, `${folder}.release`), '');
}

/** Resolve once the script in `folder` has started. */
async function scriptStarted(folder: string): Promise<void> {
  const startedFile = path.join(releaseDirectory, `${folder}.started`);
  await until(() => fs.existsSync(startedFile), `the setup script in worktree ${folder} to start`);
}

/** Poll a condition, failing after 30 s. For waits only, never as the assertion. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Signal 0 checks that the process exists and sends it nothing. */
function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, so it is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A few turns of the event loop, for anything that could still run to run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Track a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let isSettled = false;
  const tracked = promise.finally(() => { isSettled = true; });
  tracked.catch(() => undefined);
  return { promise: tracked, settled: () => isSettled };
}

function deleterState(): ReturnType<typeof _removedWorktreeDeletionStateForTests> {
  return _removedWorktreeDeletionStateForTests(projectPath);
}

/**
 * Wait until the deleter has either parked for the script or finished. A
 * deleter that ignored the script finishes, so the assertion after this fails
 * at once instead of at a timeout.
 */
async function deleterParkedOrDone(): Promise<void> {
  await until(
    () => deleterState().phase === 'waiting-for-init-script' || deleterState().phase === 'idle',
    'the deleter to wait for the script or finish',
  );
}

function removedCopies(): string[] {
  try {
    return fs.readdirSync(removedWorktreesRootFor(projectPath));
  } catch {
    return [];
  }
}

function gitWorktreePaths(): string[] {
  return run(projectPath, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

/**
 * Hold the deleter just before its `batchNumber`th batch, the way a real
 * delete is somewhere in the middle of the tree when an install starts.
 */
function holdDeleterAtBatch(batchNumber: number): { reached: Promise<void>; release: () => void } {
  let batchesSeen = 0;
  let markReached: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  let releaseHold: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { releaseHold = resolve; });
  _setRemovedWorktreeBatchHookForTests(async () => {
    batchesSeen += 1;
    if (batchesSeen === batchNumber) {
      markReached();
      await held;
    }
  });
  return { reached, release: releaseHold };
}

function makeTask(displayId: number): Task {
  return {
    id: `task-0000000${displayId}-moveaside`,
    title: `Move aside task ${displayId}`,
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
  } as unknown as Task;
}

/** The slice of TaskRepository the creation and the Done removal touch, in memory. */
function makeTaskRepository(tasks: Task[]) {
  const rows = new Map(tasks.map((task) => [task.id, { ...task }]));
  return {
    getById: (taskId: string) => {
      const row = rows.get(taskId);
      return row ? { ...row } : undefined;
    },
    update: (patch: Partial<Task> & { id: string }) => {
      const row = rows.get(patch.id);
      if (row) Object.assign(row, patch);
    },
    recordWorktree: (taskId: string, worktreePath: string, branchName: string, worktreeFolder: string) => {
      const row = rows.get(taskId);
      if (row) Object.assign(row, { worktree_path: worktreePath, branch_name: branchName, worktree_folder: worktreeFolder });
    },
    setWorktreeSkipReason: vi.fn(),
    recoverLegacyWorktreeFolder: vi.fn(() => null),
  };
}

function makeContext(gitOverrides: { linkNodeModules?: boolean; initScript?: string | null } = {}): IpcContext {
  const config = {
    agent: { execution: {} },
    git: {
      worktreesEnabled: true,
      defaultBaseBranch: 'main',
      copyFiles: [],
      // A worktree that installs its own dependencies, as the measured pnpm
      // project does, so its node_modules is a real directory to delete.
      linkNodeModules: false,
      initScript,
      ...gitOverrides,
    },
  };
  return {
    currentProjectPath: projectPath,
    configManager: { getEffectiveConfig: () => config },
    boardConfigManager: { getDefaultBaseBranchForPath: () => undefined },
    projectRepo: { list: () => [] },
    mainWindow: null,
  } as unknown as IpcContext;
}

/**
 * A task that reached Done: its worktree made directly (no script), with a
 * node_modules of real files, as an install leaves it.
 */
async function makeDoneTask(displayId: number): Promise<Task> {
  const manager = new WorktreeManager(projectPath);
  const task = makeTask(displayId);
  const created = await manager.withLock(() => manager.createWorktree(task, 'main'));
  for (const packageName of ['pkg-a', 'pkg-b', 'pkg-c']) {
    const packageDirectory = path.join(created.worktreePath, 'node_modules', packageName, 'lib');
    fs.mkdirSync(packageDirectory, { recursive: true });
    for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
      fs.writeFileSync(path.join(packageDirectory, `file-${fileIndex}.js`), `module.exports = ${fileIndex};\n`);
    }
  }
  return { ...task, worktree_path: created.worktreePath, branch_name: created.branchName, worktree_folder: created.worktreeFolder } as Task;
}

describe('a Done move\'s worktree removal and running init scripts', () => {
  it('moves the worktree aside at once; a script that starts mid-delete stops the deleter until it ends', async () => {
    const context = makeContext();
    const doneTask = await makeDoneTask(1);
    const dependent = makeTask(2);
    const repository = makeTaskRepository([doneTask, dependent]);
    // Batch 1 and 2 are the worktree root and node_modules; batch 3 is inside a package.
    const hold = holdDeleterAtBatch(3);

    expect(await deleteTaskWorktree(context, doneTask, repository as never, projectPath)).toBe(true);

    // git and the board see the worktree gone at once.
    expect(fs.existsSync(worktreePathFor('1'))).toBe(false);
    expect(repository.getById(doneTask.id)?.worktree_path).toBeNull();
    expect(gitWorktreePaths()).not.toContain(path.resolve(worktreePathFor('1')));
    const copies = removedCopies();
    expect(copies).toHaveLength(1);
    expect(copies[0].startsWith('1-')).toBe(true);
    // The copy is no longer a worktree.
    expect(fs.existsSync(path.join(removedWorktreesRootFor(projectPath), copies[0], '.git'))).toBe(false);

    // The deleter is part way through when the next task's install starts.
    await hold.reached;
    const removedBeforeScript = deleterState().removedEntries;
    expect(removedBeforeScript).toBeGreaterThan(0);
    const creation = track(ensureTaskWorktree(context, dependent, repository as never, projectPath));
    await scriptStarted('2');
    expect(isAnyInitScriptRunning()).toBe(true);
    hold.release();

    await deleterParkedOrDone();
    expect(deleterState().phase).toBe('waiting-for-init-script');
    expect(deleterState().removedEntries).toBe(removedBeforeScript);
    await settle();
    expect(deleterState().phase).toBe('waiting-for-init-script');
    expect(deleterState().removedEntries).toBe(removedBeforeScript);
    expect(fs.existsSync(path.join(removedWorktreesRootFor(projectPath), copies[0], 'node_modules', 'pkg-c'))).toBe(true);
    expect(creation.settled()).toBe(false);

    release('2');
    await creation.promise;
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
    expect(removedCopies()).toEqual([]);
    expect(repository.getById(dependent.id)?.worktree_path).toBe(worktreePathFor('2'));
  });

  it('a Done during a running script returns at once and deletes nothing until the script ends', async () => {
    const context = makeContext();
    const dependent = makeTask(3);
    const repository = makeTaskRepository([dependent]);
    const creation = track(ensureTaskWorktree(context, dependent, repository as never, projectPath));
    await scriptStarted('3');

    const doneTask = await makeDoneTask(4);
    const doneRepository = makeTaskRepository([doneTask]);
    expect(await deleteTaskWorktree(context, doneTask, doneRepository as never, projectPath)).toBe(true);
    expect(fs.existsSync(worktreePathFor('4'))).toBe(false);
    expect(doneRepository.getById(doneTask.id)?.worktree_path).toBeNull();

    await deleterParkedOrDone();
    expect(deleterState().phase).toBe('waiting-for-init-script');
    expect(deleterState().removedEntries).toBe(0);
    await settle();
    expect(deleterState().removedEntries).toBe(0);
    const [copy] = removedCopies();
    expect(fs.readdirSync(path.join(removedWorktreesRootFor(projectPath), copy, 'node_modules')).sort()).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);

    release('3');
    await creation.promise;
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
    expect(removedCopies()).toEqual([]);
  });

  it('a task moved back out of Done gets its worktree at the same path while the old copy waits, and the copy\'s links never reach into it', async () => {
    const context = makeContext();
    const doneTask = await makeDoneTask(5);
    const worktreePath = worktreePathFor('5');
    // pnpm's layout: node_modules/<name> is a link with an ABSOLUTE target
    // inside the worktree's own node_modules/.pnpm (a junction on Windows).
    const pnpmTarget = path.join(worktreePath, 'node_modules', '.pnpm', 'pkg-d', 'node_modules', 'pkg-d');
    fs.mkdirSync(pnpmTarget, { recursive: true });
    fs.writeFileSync(path.join(pnpmTarget, 'index.js'), 'old\n');
    fs.symlinkSync(pnpmTarget, path.join(worktreePath, 'node_modules', 'pkg-d'), process.platform === 'win32' ? 'junction' : 'dir');
    const repository = makeTaskRepository([doneTask]);
    const hold = holdDeleterAtBatch(1);

    expect(await deleteTaskWorktree(context, doneTask, repository as never, projectPath)).toBe(true);
    await hold.reached;

    // Out of Done: the same task, the same path, the same branch. git accepts
    // it only because the move pruned the old registration.
    const restoring = track(ensureTaskWorktree(context, repository.getById(doneTask.id) as Task, repository as never, projectPath));
    await scriptStarted('5');
    release('5');
    await restoring.promise;
    expect(repository.getById(doneTask.id)?.worktree_path).toBe(worktreePath);
    expect(repository.getById(doneTask.id)?.branch_name).toBe(doneTask.branch_name);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);
    // The restored worktree's own install puts files where the old copy's link points.
    fs.mkdirSync(pnpmTarget, { recursive: true });
    fs.writeFileSync(path.join(pnpmTarget, 'index.js'), 'live\n');

    hold.release();
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
    expect(removedCopies()).toEqual([]);
    expect(fs.readFileSync(path.join(pnpmTarget, 'index.js'), 'utf8')).toBe('live\n');
    // git's checkout may write CRLF here, so compare the text without line endings.
    expect(fs.readFileSync(path.join(worktreePath, 'README.md'), 'utf8').trim()).toBe('project');
    expect(gitWorktreePaths()).toContain(path.resolve(worktreePath));
  });
});

describe('a Done move in the default setup, where node_modules links to the project root\'s', () => {
  it('removes the link from the copy as soon as it moves, and every file of the root\'s node_modules survives', async () => {
    const rootModules = path.join(projectPath, 'node_modules');
    const sentinel = path.join(rootModules, 'shared-pkg', 'sentinel.txt');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'root\n');
    const context = makeContext({ linkNodeModules: true, initScript: null });
    const task = makeTask(7);
    const repository = makeTaskRepository([task]);
    await ensureTaskWorktree(context, task, repository as never, projectPath);
    const recorded = repository.getById(task.id) as Task;
    const linkedModules = path.join(recorded.worktree_path as string, 'node_modules');
    // The creation linked it: reading through the link reaches the root's files.
    expect(fs.realpathSync(linkedModules)).toBe(fs.realpathSync(rootModules));

    const hold = holdDeleterAtBatch(1);
    expect(await deleteTaskWorktree(context, recorded, repository as never, projectPath)).toBe(true);
    await hold.reached;
    const [copy] = removedCopies();
    const copiedModules = path.join(removedWorktreesRootFor(projectPath), copy, 'node_modules');
    // lstat, so a link that is still there throws nothing and fails this.
    expect(() => fs.lstatSync(copiedModules)).toThrow();

    hold.release();
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
    expect(removedCopies()).toEqual([]);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('root\n');
  });
});

describe('removeNodeModulesLinkOnly', () => {
  let scratch: string;

  afterEach(async () => {
    if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('removes a link and keeps what it points at, leaves a real directory alone, and answers false for nothing there', () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-link-only-'));
    const target = path.join(scratch, 'root-modules');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
    const link = path.join(scratch, 'linked', 'node_modules');
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    expect(removeNodeModulesLinkOnly(link)).toBe(true);
    expect(() => fs.lstatSync(link)).toThrow();
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep\n');

    const realDirectory = path.join(scratch, 'installed', 'node_modules');
    fs.mkdirSync(path.join(realDirectory, 'pkg'), { recursive: true });
    expect(removeNodeModulesLinkOnly(realDirectory)).toBe(false);
    expect(fs.existsSync(path.join(realDirectory, 'pkg'))).toBe(true);

    expect(removeNodeModulesLinkOnly(path.join(scratch, 'missing', 'node_modules'))).toBe(false);
  });
});

describe('the removed-worktrees deleter', () => {
  let scratch: string;

  afterEach(async () => {
    if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('deletes files, directories and a read-only file, removes a link as a link, and keeps what the link points at', async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-removed-tree-'));
    const live = path.join(scratch, 'live');
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, 'keep.txt'), 'keep\n');
    const tree = path.join(scratch, 'tree');
    fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'a', 'b', 'leaf.txt'), 'leaf\n');
    const readOnlyFile = path.join(tree, 'a', 'read-only.txt');
    fs.writeFileSync(readOnlyFile, 'locked\n');
    fs.chmodSync(readOnlyFile, 0o444);
    fs.symlinkSync(live, path.join(tree, 'a', 'link-to-live'), process.platform === 'win32' ? 'junction' : 'dir');

    let removed = 0;
    const outcome = await deleteTreeWithoutFollowingLinks(tree, { beforeBatch: async () => true, onRemoved: () => { removed += 1; } });

    expect(outcome).toBe('deleted');
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readFileSync(path.join(live, 'keep.txt'), 'utf8')).toBe('keep\n');
    // a, b, leaf.txt, read-only.txt and the link.
    expect(removed).toBe(5);
  });

  it('stops when told to and leaves the rest on disk', async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-removed-tree-'));
    const tree = path.join(scratch, 'tree');
    fs.mkdirSync(tree);
    for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
      fs.writeFileSync(path.join(tree, `file-${fileIndex}.txt`), '\n');
    }
    let batches = 0;
    const outcome = await deleteTreeWithoutFollowingLinks(tree, {
      beforeBatch: async () => { batches += 1; return batches === 1; },
      onRemoved: () => undefined,
    });

    expect(outcome).toBe('stopped');
    // One batch of 8 ran, the other 12 files are still there.
    expect(fs.readdirSync(tree)).toHaveLength(12);
  });

  it('stops after the batch in flight when told to, for a project folder about to move, and leaves the copy for the next open', async () => {
    const worktreesRoot = path.join(projectPath, '.kangentic', 'worktrees');
    const leftover = path.join(worktreesRoot, 'stop-me');
    fs.mkdirSync(path.join(leftover, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(leftover, 'node_modules', 'pkg', 'index.js'), '\n');
    const copy = await moveIntoRemovedWorktrees(projectPath, leftover);
    expect(copy).not.toBeNull();
    const hold = holdDeleterAtBatch(1);
    scheduleRemovedWorktreeDeletion(projectPath);
    await hold.reached;

    const stopping = track(stopRemovedWorktreeDeletion(projectPath));
    await settle();
    // Not yet: the batch it was told to stop in has not run its check.
    expect(stopping.settled()).toBe(false);
    hold.release();
    await stopping.promise;
    expect(deleterState().phase).toBe('idle');
    expect(fs.existsSync(path.join(copy as string, 'node_modules', 'pkg', 'index.js'))).toBe(true);

    // The next open's sweep finishes it.
    _setRemovedWorktreeBatchHookForTests(null);
    scheduleRemovedWorktreeDeletion(projectPath);
    await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
    expect(removedCopies()).toEqual([]);
  });

  it('a project delete deletes the copies at once, without waiting for a running script', async () => {
    const context = makeContext();
    const installing = makeTask(6);
    const repository = makeTaskRepository([installing]);
    const creation = track(ensureTaskWorktree(context, installing, repository as never, projectPath));
    await scriptStarted('6');
    const leftover = path.join(projectPath, '.kangentic', 'worktrees', 'deleted-project');
    fs.mkdirSync(path.join(leftover, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(leftover, 'node_modules', 'pkg', 'index.js'), '\n');
    expect(await moveIntoRemovedWorktrees(projectPath, leftover)).not.toBeNull();

    await deleteRemovedWorktreesNow(projectPath);
    expect(removedCopies()).toEqual([]);
    expect(isAnyInitScriptRunning()).toBe(true);

    release('6');
    await creation.promise;
  });

  it('refuses any path that is not a direct child of the removed-worktrees folder', () => {
    const root = removedWorktreesRootFor(projectPath);
    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '7-abc'))).not.toThrow();
    expect(() => assertRemovedWorktreeEntry(projectPath, root)).toThrow(/not a direct child/);
    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '7-abc', 'node_modules'))).toThrow(/not a direct child/);
    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(projectPath, '.kangentic', 'worktrees', '7'))).toThrow(/not a direct child/);
    expect(() => assertRemovedWorktreeEntry(projectPath, path.join(root, '..', '..'))).toThrow(/not a direct child/);
  });

  it('gives every move its own name, so a task that reaches Done twice keeps both copies apart', async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-removed-move-'));
    const scratchProject = path.join(scratch, 'project');
    const worktreesRoot = path.join(scratchProject, '.kangentic', 'worktrees');
    fs.mkdirSync(path.join(worktreesRoot, '9'), { recursive: true });
    const first = await moveIntoRemovedWorktrees(scratchProject, path.join(worktreesRoot, '9'));
    fs.mkdirSync(path.join(worktreesRoot, '9'));
    const second = await moveIntoRemovedWorktrees(scratchProject, path.join(worktreesRoot, '9'));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(fs.readdirSync(removedWorktreesRootFor(scratchProject))).toHaveLength(2);

    // Nothing to move: null, and nothing changed.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await moveIntoRemovedWorktrees(scratchProject, path.join(worktreesRoot, 'missing'))).toBeNull();
    vi.restoreAllMocks();
  });
});
