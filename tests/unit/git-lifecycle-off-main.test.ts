/**
 * A task lifecycle's git processes start in the pty host, not on main.
 *
 * On Windows a spawn is CreateProcess on the calling thread, 15 to 30 ms each.
 * A 20-task workflow stalled main 19 times over 75 ms, every one a git spawn
 * from simple-git or `runGitWithTimeout`. This test runs the git work of one
 * lifecycle (start, a move that respawns the agent, Done) in the order
 * `handleTaskMove` runs it, against a real repository with a local origin, and
 * fails on any git process that starts on main.
 *
 * How it sees every spawn: every child process in this test process goes
 * through `ChildProcess.prototype.spawn`, simple-git's own `child_process`
 * import included (which `vi.mock` cannot reach), so a spy there sees all of
 * them. The host's two entry points are registered with the real host code
 * (`runHostExec`, and `HostCliProcesses` behind a `PtyHostClient`), and a
 * spawn made while one of them is starting a child is the host's.
 *
 * Measured with this harness before the change: 49 git processes, 45 on main.
 *
 * Tier: Unit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, execFileSync } from 'node:child_process';
import { WorktreeManager, GitQueuePriority, prepareWorktreeForRemoval, type WorktreeCreateResult } from '../../src/main/git/worktree-manager';
import { clearFetchCache, fetchIfStale, forgetRecentFetches } from '../../src/main/git/fetch-throttle';
import { refResolvesLocally } from '../../src/main/git/base-branch';
import { runGitWithTimeout } from '../../src/main/git/git-spawn';
import { gitAt } from '../../src/main/git/git-client';
import { readWorktreeHead, hasCommitsAheadOfBase, readRefsPointingAtSha } from '../../src/main/git/worktree-head';
import { readRemoteUrls, invalidateRemoteUrlsCache } from '../../src/main/git/git-remotes';
import { captureGitChurn } from '../../src/main/ipc/handlers/git-stats-capture';
import { setOffMainExecutor } from '../../src/main/utility-process/off-main-exec';
import { setOffMainCliSpawner } from '../../src/main/utility-process/off-main-cli';
import { runHostExec } from '../../src/main/pty/host/host-exec';
import { HostCliProcesses } from '../../src/main/pty/host/host-cli-processes';
import { PtyHostClient, type PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostEvent } from '../../src/main/pty/host/protocol';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { UsageHistoryRepository } from '../../src/main/db/repositories/usage-history-repository';
import type { Task } from '../../src/shared/types';

interface RecordedSpawn {
  phase: string;
  where: 'main' | 'host';
  command: string;
}

interface SpawnOptionsSeen {
  file?: string;
  args?: string[];
}

const recordedSpawns: RecordedSpawn[] = [];
let measuringPhase: string | null = null;
let hostDepth = 0;

type PrototypeSpawn = (this: ChildProcess, options: SpawnOptionsSeen) => unknown;
const childProcessPrototype = ChildProcess.prototype as unknown as { spawn: PrototypeSpawn };
const originalPrototypeSpawn = childProcessPrototype.spawn;

/** Run `start` as the host: a spawn it makes synchronously is the host's. */
function inHost<T>(start: () => T): T {
  hostDepth += 1;
  try {
    return start();
  } finally {
    hostDepth -= 1;
  }
}

let workspace: string;
let projectPath: string;
let hostProcesses: HostCliProcesses;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

const lifecycleTask = {
  id: 'abcd1234-5678-4000-8000-000000000001',
  title: 'Lifecycle task',
  display_id: 1,
  worktree_path: null as string | null,
  worktree_folder: null as string | null,
  branch_name: null as string | null,
  base_branch: null as string | null,
  use_worktree: null as number | null,
};

const gitConfig = { worktreesEnabled: true, defaultBaseBranch: 'main', copyFiles: [], initScript: null, linkNodeModules: true };

/** A suspend's two churn captures (the move's or Done's, and the exit handler's), awaited through both writes. */
async function captureChurnAtSuspend(gitDirectory: string): Promise<void> {
  let writes = 0;
  let resolveWrites: () => void = () => undefined;
  const bothWritten = new Promise<void>((resolve) => { resolveWrites = resolve; });
  const sessionRepo = {
    listForTaskNewestFirst: () => [],
    setTaskGitStats: () => undefined,
  } as unknown as SessionRepository;
  const usageHistoryRepo = {
    setTaskGitStats: () => {
      writes += 1;
      if (writes === 2) resolveWrites();
    },
  } as unknown as UsageHistoryRepository;
  const task = { id: lifecycleTask.id, worktree_path: gitDirectory, base_branch: null } as unknown as Task;
  captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-exit', projectPath, 'main');
  captureGitChurn(task, sessionRepo, usageHistoryRepo, 'record-move', projectPath, 'main');
  await Promise.race([
    bothWritten,
    new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('churn captures did not both write')), 15_000)),
  ]);
}

/** The git reads one PR resolve makes for a task with no PR yet (`linkPRForTask`'s ladder). */
async function resolvePullRequestReads(taskWorktreePath: string | null, headSha: string): Promise<void> {
  if (taskWorktreePath) {
    await readWorktreeHead(taskWorktreePath);
    await readRemoteUrls(taskWorktreePath);
  }
  await hasCommitsAheadOfBase(projectPath, 'main', headSha);
  await readRemoteUrls(projectPath);
  await readRefsPointingAtSha(projectPath, headSha, 'main');
}

/** The reuse path's drift probe (`surfaceWorktreeBaseDrift` in task-git.ts). */
async function driftProbe(taskWorktreePath: string): Promise<void> {
  await WorktreeManager.withGitLock(projectPath, async () => {
    await fetchIfStale(gitAt(projectPath), projectPath, 'main', {});
    if (!(await refResolvesLocally(projectPath, 'origin/main'))) return;
    await runGitWithTimeout(taskWorktreePath, ['rev-list', '--left-right', '--count', 'origin/main...HEAD'], { timeoutMs: 5_000 });
  }, { priority: GitQueuePriority.BACKGROUND, label: 'drift-probe' });
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-git-lifecycle-'));
  const originPath = path.join(workspace, 'origin.git');
  projectPath = path.join(workspace, 'project');
  fs.mkdirSync(projectPath);
  run(workspace, ['init', '--bare', '-b', 'main', originPath]);
  run(projectPath, ['init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  run(projectPath, ['add', '-A']);
  run(projectPath, ['commit', '-q', '-m', 'initial']);
  run(projectPath, ['remote', 'add', 'origin', originPath]);
  run(projectPath, ['push', '-q', 'origin', 'main']);
  clearFetchCache();
  invalidateRemoteUrlsCache();

  childProcessPrototype.spawn = function recordSpawn(this: ChildProcess, options: SpawnOptionsSeen) {
    if (measuringPhase) {
      const commandArgs = (options.args ?? []).slice(1);
      recordedSpawns.push({
        phase: measuringPhase,
        where: hostDepth > 0 ? 'host' : 'main',
        command: `${path.basename(options.file ?? '?')} ${commandArgs.join(' ')}`,
      });
    }
    return originalPrototypeSpawn.call(this, options);
  };

  setOffMainExecutor((request) => inHost(() => runHostExec(request)));
  let deliverToMain: (event: PtyHostEvent) => void = () => undefined;
  hostProcesses = new HostCliProcesses((event) => deliverToMain(event), undefined, '/nonexistent/kangentic-host-binary');
  const transport: PtyHostTransport = {
    post: (command) => {
      if (command.type === 'cliSpawn') inHost(() => hostProcesses.start(command.params));
      else if (command.type === 'cliWrite') hostProcesses.write(command.processId, command.data);
      else if (command.type === 'cliEndInput') hostProcesses.endInput(command.processId, command.data);
      else if (command.type === 'cliStop') hostProcesses.stop(command.processId);
    },
    request: () => Promise.reject(new Error('no requests here')),
    setEventListener: (listener) => { deliverToMain = listener; },
    hostPid: null,
    shutdown: () => hostProcesses.stopAll(),
  };
  const client = new PtyHostClient(transport);
  setOffMainCliSpawner((command, args, options) => client.spawnCli(command, args, options));
});

afterAll(async () => {
  childProcessPrototype.spawn = originalPrototypeSpawn;
  setOffMainExecutor(null);
  setOffMainCliSpawner(null);
  hostProcesses.stopAll();
  clearFetchCache();
  invalidateRemoteUrlsCache();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a task lifecycle\'s git processes', () => {
  it('start in the pty host, none on main, through start, a respawning move and Done', async () => {
    // Start: the workflow engine forgets recent fetches, the move creates the
    // worktree (ensureTaskWorktree), and the post-move PR resolve reads.
    measuringPhase = 'start';
    forgetRecentFetches(projectPath);
    const manager = new WorktreeManager(projectPath);
    const created = await manager.withLock(() => manager.ensureWorktree(lifecycleTask, gitConfig, {}));
    measuringPhase = null;
    expect('worktreePath' in created).toBe(true);
    const worktreePath = (created as WorktreeCreateResult).worktreePath;
    const startHead = run(worktreePath, ['rev-parse', 'HEAD']).trim();
    measuringPhase = 'start-pr-resolve';
    await resolvePullRequestReads(worktreePath, startHead);

    // The agent works: a commit and an untracked file.
    measuringPhase = null;
    fs.writeFileSync(path.join(worktreePath, 'feature.ts'), 'export const feature = 1;\n');
    run(worktreePath, ['add', 'feature.ts']);
    run(worktreePath, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-q', '-m', 'feature']);
    fs.writeFileSync(path.join(worktreePath, 'notes.txt'), 'one\ntwo\n');
    const workHead = run(worktreePath, ['rev-parse', 'HEAD']).trim();

    // A move that respawns the agent: the suspend's churn captures, then Phase 2
    // reuses the worktree and probes base drift.
    measuringPhase = 'move-respawn';
    await captureChurnAtSuspend(worktreePath);
    await driftProbe(worktreePath);

    // Done: the churn captures, then deleteTaskWorktree (HEAD read, removal) and
    // the background prune, then the post-move PR resolve once its coalesce passed.
    measuringPhase = 'done';
    await captureChurnAtSuspend(worktreePath);
    await readWorktreeHead(worktreePath);
    await prepareWorktreeForRemoval(worktreePath, 'moderate');
    const removed = await manager.withLock(
      () => manager.removeWorktree(worktreePath, { removalProfile: 'moderate' }),
      { priority: GitQueuePriority.BACKGROUND },
    );
    expect(removed).toBe(true);
    WorktreeManager.scheduleBackgroundPrune(projectPath);
    await WorktreeManager.withGitLock(projectPath, async () => undefined, { priority: GitQueuePriority.BACKGROUND });
    await resolvePullRequestReads(null, workHead);
    measuringPhase = null;

    const gitSpawns = recordedSpawns.filter((spawn) => spawn.command.startsWith('git '));
    const onMain = gitSpawns.filter((spawn) => spawn.where === 'main');
    console.log([
      '',
      ...gitSpawns.map((spawn) => `${spawn.phase.padEnd(17)} ${spawn.where.padEnd(5)} ${spawn.command}`),
      `git processes: ${gitSpawns.length} (main ${onMain.length}, host ${gitSpawns.length - onMain.length})`,
    ].join('\n'));

    expect(onMain.map((spawn) => `${spawn.phase}: ${spawn.command}`)).toEqual([]);
    // Not vacuous: the lifecycle's mutations and reads all ran, in the host.
    const commands = gitSpawns.map((spawn) => spawn.command);
    for (const expected of ['git fetch --no-auto-gc origin main', 'worktree add -b lifecycle-task-abcd1234', 'git sparse-checkout set', 'git worktree remove', 'git worktree prune', 'git rev-parse --abbrev-ref HEAD', 'git status --porcelain']) {
      expect(commands.some((command) => command.includes(expected)), expected).toBe(true);
    }
    // A suspend's two captures share one churn read: one `diff --stat` per suspend.
    expect(gitSpawns.filter((spawn) => spawn.command.startsWith('git diff --stat=4096')).map((spawn) => spawn.phase))
      .toEqual(['move-respawn', 'done']);
  }, 60_000);
});
