/**
 * The Post-Worktree Script runs OUTSIDE the per-project git queue.
 *
 * `ensureTaskWorktree` used to run the whole creation, script included, inside
 * one `create-worktree` job on `WorktreeManager.withLock`. A slow script (an
 * `npm install`, a `pnpm install`) then held every other git operation in the
 * project: another task's creation, a Done move's removal, auto-fetch. N tasks
 * starting together ran N scripts back to back. The creation is now a git phase
 * in the queue and a setup phase after it, and a creation registry keeps
 * removals and a second creation off a directory whose script is still running.
 *
 * This drives the REAL `ensureTaskWorktree`, `WorktreeManager` and git against a
 * temp repo, with a real script that blocks until the test releases it. Only the
 * IPC context and the task repository are stubs. A regression that put the
 * setup back inside `withLock` (under any name) fails the queue assertions here,
 * because the queue would be held for as long as the script blocks.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  WorktreeManager,
  GitQueuePriority,
  prepareWorktreeForRemoval,
} from '../../src/main/git/worktree-manager';
import { isWorktreeCreationInFlight } from '../../src/main/git/worktree-creation-registry';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';
import { ensureTaskWorktree } from '../../src/main/ipc/helpers/task-git';
import { isAbortError } from '../../src/shared/abort-utils';
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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-setup-outside-queue-'));
  projectPath = path.join(workspace, 'project');
  releaseDirectory = path.join(workspace, 'release');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(releaseDirectory);
  run(projectPath, ['init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  run(projectPath, ['add', '-A']);
  // A developer's global `commit.gpgsign` would prompt or fail with no key here.
  run(projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  const scriptPath = path.join(workspace, 'blocking-install.js');
  fs.writeFileSync(scriptPath, BLOCKING_SCRIPT);
  initScript = `"${process.execPath}" "${scriptPath}" "${releaseDirectory}"`;
  clearFetchCache();
});

afterAll(async () => {
  // Let any script still waiting exit before the tree goes.
  for (const folder of ['1', '2', '3', '4', '5']) release(folder);
  await new Promise((resolve) => setTimeout(resolve, 200));
  clearFetchCache();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function worktreePathFor(folder: string): string {
  return path.join(projectPath, '.kangentic', 'worktrees', folder);
}

function release(folder: string): void {
  fs.writeFileSync(path.join(releaseDirectory, `${folder}.release`), '');
}

/** Resolve with the script's pid once the script in `folder` has started. */
async function scriptStarted(folder: string): Promise<number> {
  const startedFile = path.join(releaseDirectory, `${folder}.started`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(startedFile)) {
      const pid = Number(fs.readFileSync(startedFile, 'utf8'));
      if (pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the setup script in worktree ${folder} never started`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True once `pid` stops answering within a short grace. On POSIX the script is
 * a grandchild: dash 0.5.12 (CI's ubuntu-24.04 `/bin/sh`) does not exec the one
 * command of `sh -c`, so the script runs under the shell, and after the group
 * kill init reaps it asynchronously. A zombie still answers `kill(pid, 0)`
 * though it runs nothing. Measured in WSL Ubuntu on the same dash: the killed
 * grandchild was gone 4 ms after the group kill. The grace is far below the
 * script's own run, so a script still running fails this.
 */
async function goneWithin(pid: number, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** Track a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let isSettled = false;
  const tracked = promise.finally(() => { isSettled = true; });
  // The caller awaits `promise`; this only keeps a rejection off the unhandled path.
  tracked.catch(() => undefined);
  return { promise: tracked, settled: () => isSettled };
}

function makeTask(displayId: number): Task {
  return {
    id: `task-0000000${displayId}-setup`,
    title: `Setup task ${displayId}`,
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

/** The slice of TaskRepository `ensureTaskWorktree` touches, in memory. */
function makeTaskRepository(tasks: Task[]) {
  const rows = new Map(tasks.map((task) => [task.id, { ...task }]));
  return {
    getById: (taskId: string) => {
      const row = rows.get(taskId);
      return row ? { ...row } : undefined;
    },
    recordWorktree: vi.fn((taskId: string, worktreePath: string, branchName: string, worktreeFolder: string, baseBranch: string | null) => {
      const row = rows.get(taskId);
      if (row) Object.assign(row, { worktree_path: worktreePath, branch_name: branchName, worktree_folder: worktreeFolder, resolved_base_branch: baseBranch });
    }),
    setWorktreeSkipReason: vi.fn(),
    recoverLegacyWorktreeFolder: vi.fn(() => null),
  };
}

function makeContext(): IpcContext {
  const config = {
    agent: { execution: {} },
    git: {
      worktreesEnabled: true,
      defaultBaseBranch: 'main',
      copyFiles: [],
      linkNodeModules: false,
      initScript,
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

describe('the post-worktree script runs outside the per-project git queue', () => {
  it('while one task\'s script runs, a second task\'s creation, a Done removal and auto-fetch all start and finish', async () => {
    const context = makeContext();
    const taskA = makeTask(1);
    const taskB = makeTask(2);
    const repository = makeTaskRepository([taskA, taskB]);

    const creationA = track(ensureTaskWorktree(context, taskA, repository as never, projectPath));
    await scriptStarted('1');

    // Auto-fetch's shape: a BACKGROUND job on the project's queue.
    const autoFetchRan = await WorktreeManager.withGitLock(
      projectPath,
      async () => 'ran',
      { priority: GitQueuePriority.BACKGROUND, label: 'auto-fetch' },
    );
    expect(autoFetchRan).toBe('ran');

    // A Done move's removal of some other worktree, as `deleteTaskWorktree` runs it.
    const manager = new WorktreeManager(projectPath);
    const doneTask = makeTask(3);
    const doneWorktree = await manager.withLock(() => manager.createWorktree(doneTask, 'main'));
    await prepareWorktreeForRemoval(doneWorktree.worktreePath, 'moderate');
    const removed = await manager.withLock(
      () => manager.removeWorktree(doneWorktree.worktreePath, { removalProfile: 'moderate' }),
      { priority: GitQueuePriority.BACKGROUND, label: 'remove-worktree:done' },
    );
    expect(removed).toBe(true);

    // A second task's creation gets through its git phase and starts its own
    // script, all while the first script still blocks.
    const creationB = track(ensureTaskWorktree(context, taskB, repository as never, projectPath));
    await scriptStarted('2');
    expect(fs.existsSync(path.join(worktreePathFor('2'), '.git'))).toBe(true);

    // Everything above happened with the first script still running.
    expect(creationA.settled()).toBe(false);
    expect(repository.recordWorktree).not.toHaveBeenCalled();

    release('1');
    release('2');
    await creationA.promise;
    await creationB.promise;
    expect(repository.getById(taskA.id)?.worktree_path).toBe(worktreePathFor('1'));
    expect(repository.getById(taskB.id)?.worktree_path).toBe(worktreePathFor('2'));
  });

  it('a removal never deletes a worktree whose script is running: in the queue it refuses, outside it waits', async () => {
    const context = makeContext();
    const task = makeTask(4);
    const repository = makeTaskRepository([task]);
    const worktreePath = worktreePathFor('4');

    const creation = track(ensureTaskWorktree(context, task, repository as never, projectPath));
    await scriptStarted('4');
    expect(isWorktreeCreationInFlight(worktreePath)).toBe(true);

    // In the queue (a stale cleanup, an MCP or project delete): refuse at once.
    const manager = new WorktreeManager(projectPath);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const removed = await manager.withLock(() => manager.removeWorktree(worktreePath));
    expect(removed).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);

    // Outside the queue (a Done move, a To Do move, a delete): wait it out.
    const prepared = track(prepareWorktreeForRemoval(worktreePath, 'moderate'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(prepared.settled()).toBe(false);
    expect(creation.settled()).toBe(false);

    release('4');
    await creation.promise;
    await prepared.promise;
    expect(isWorktreeCreationInFlight(worktreePath)).toBe(false);
    vi.restoreAllMocks();
  });

  it('an abort mid-script kills the script, records nothing, and the next creation attaches to the leftover branch', async () => {
    const context = makeContext();
    const task = makeTask(5);
    const repository = makeTaskRepository([task]);
    const controller = new AbortController();

    const creation = track(ensureTaskWorktree(context, task, repository as never, projectPath, { signal: controller.signal }));
    const scriptPid = await scriptStarted('5');
    expect(isAlive(scriptPid)).toBe(true);

    controller.abort();
    const rejection = await creation.promise.catch((error: unknown) => error);

    expect(isAbortError(rejection)).toBe(true);
    // The creation settled only once the script's tree was gone, which is what
    // lets a removal or the next creation at this path go ahead. (The script
    // would otherwise keep polling for its release file indefinitely.)
    // 3 s of room for init's reap on a loaded runner; the script itself runs
    // until released, so one still running fails this.
    expect(await goneWithin(scriptPid, 3_000)).toBe(true);
    expect(isWorktreeCreationInFlight(worktreePathFor('5'))).toBe(false);
    expect(repository.recordWorktree).not.toHaveBeenCalled();

    // The next creation clears the half-made directory and attaches to the
    // branch the aborted one left, still reporting the base it was cut from.
    release('5');
    await ensureTaskWorktree(context, task, repository as never, projectPath);
    const row = repository.getById(task.id) as Task & { resolved_base_branch?: string | null };
    expect(row.worktree_path).toBe(worktreePathFor('5'));
    expect(row.resolved_base_branch).toBe('main');
    expect(run(projectPath, ['branch', '--list', row.branch_name ?? '']).trim()).not.toBe('');
  });
});
