/**
 * The worktree enumeration starts its git processes in the pty host, not on
 * main, and never many at once.
 *
 * On Windows a spawn is CreateProcess on the calling thread. Run on main, one
 * enumeration of every project cost 9 to 47 s and held main for up to 4.6 s, and
 * a tool call in another terminal failed with ECONNRESET inside it. In the host
 * every start lands on one spawn worker thread, so an unbounded enumeration
 * would queue hundreds of starts ahead of a task's git and agent CLI runs: the
 * cap is what keeps those moving.
 *
 * How it sees every spawn: every child process in this test process goes through
 * `ChildProcess.prototype.spawn`, simple-git's own `child_process` import
 * included, so a spy there sees all of them. A spawn made while `runHostExec` is
 * starting a child is the host's (`git-lifecycle-off-main.test.ts` does the same).
 *
 * Tier: Unit. Real git against a real worktree: the records prove `gitAt`'s
 * status and raw reads give the answers simple-git gave.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, execFileSync } from 'node:child_process';

const { projectsFixture } = vi.hoisted(() => ({
  projectsFixture: [] as Array<{ id: string; name: string; path: string }>,
}));

vi.mock('../../src/main/db/repositories/project-repository', () => ({
  ProjectRepository: class {
    list() { return projectsFixture; }
    getById(id: string) { return projectsFixture.find((project) => project.id === id); }
  },
}));

import { enumerateWorktrees, WORKTREE_READ_CONCURRENCY } from '../../src/main/git/worktree-list';
import { setOffMainExecutor } from '../../src/main/utility-process/off-main-exec';
import { runHostExec } from '../../src/main/pty/host/host-exec';
import { isSamePath } from '../../src/shared/paths';

interface SpawnOptionsSeen {
  file?: string;
  args?: string[];
}

type PrototypeSpawn = (this: ChildProcess, options: SpawnOptionsSeen) => unknown;
const childProcessPrototype = ChildProcess.prototype as unknown as { spawn: PrototypeSpawn };
const originalPrototypeSpawn = childProcessPrototype.spawn;

const recordedSpawns: Array<{ where: 'main' | 'host'; command: string }> = [];
let hostDepth = 0;

/** Run `start` as the host: a spawn it makes synchronously is the host's. */
function inHost<T>(start: () => T): T {
  hostDepth += 1;
  try {
    return start();
  } finally {
    hostDepth -= 1;
  }
}

const EXTRA_WORKTREES = 6;

let workspace: string;
let projectPath: string;
let dirtyWorktreePath: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

beforeAll(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-worktree-list-')));
  projectPath = path.join(workspace, 'project');
  fs.mkdirSync(projectPath);
  run(projectPath, ['init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  run(projectPath, ['add', '-A']);
  run(projectPath, ['commit', '-q', '-m', 'initial']);
  for (let index = 0; index < EXTRA_WORKTREES; index += 1) {
    run(projectPath, ['worktree', 'add', '-q', '-b', `task-${index}`, path.join(workspace, `worktree-${index}`)]);
  }
  dirtyWorktreePath = path.join(workspace, 'worktree-0');
  fs.writeFileSync(path.join(dirtyWorktreePath, 'feature.ts'), 'export const feature = 1;\n');
  run(dirtyWorktreePath, ['add', 'feature.ts']);
  run(dirtyWorktreePath, ['commit', '-q', '-m', 'feature']);
  fs.writeFileSync(path.join(dirtyWorktreePath, 'notes.txt'), 'untracked\n');
  projectsFixture.push({ id: 'project-1', name: 'Project', path: projectPath });

  childProcessPrototype.spawn = function recordSpawn(this: ChildProcess, options: SpawnOptionsSeen) {
    recordedSpawns.push({
      where: hostDepth > 0 ? 'host' : 'main',
      command: `${path.basename(options.file ?? '?')} ${(options.args ?? []).slice(1).join(' ')}`,
    });
    return originalPrototypeSpawn.call(this, options);
  };
});

afterAll(async () => {
  childProcessPrototype.spawn = originalPrototypeSpawn;
  setOffMainExecutor(null);
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('enumerateWorktrees', () => {
  it('starts every git process in the pty host, none on main', async () => {
    recordedSpawns.length = 0;
    setOffMainExecutor((request) => inHost(() => runHostExec(request)));

    const [project] = await enumerateWorktrees({ resolveBaseRef: () => 'main' });

    const gitSpawns = recordedSpawns.filter((spawn) => spawn.command.startsWith('git'));
    expect(gitSpawns.filter((spawn) => spawn.where === 'main').map((spawn) => spawn.command)).toEqual([]);
    // Not vacuous: the list, a status and a count each ran, in the host.
    for (const expected of ['worktree list --porcelain', 'status --porcelain', 'rev-list --left-right --count']) {
      expect(gitSpawns.some((spawn) => spawn.command.includes(expected)), expected).toBe(true);
    }
    expect(project.worktrees).toHaveLength(EXTRA_WORKTREES + 1);
  }, 60_000);

  it('reads the same answers through the host: branch, dirty, counts and commit time', async () => {
    setOffMainExecutor((request) => inHost(() => runHostExec(request)));

    const [project] = await enumerateWorktrees({ resolveBaseRef: () => 'main' });

    const dirty = project.worktrees.find((worktree) => isSamePath(worktree.path, dirtyWorktreePath));
    expect(dirty).toMatchObject({ branch: 'task-0', baseRef: 'main', dirty: true, commitsAhead: 1, commitsBehind: 0, isMainCheckout: false });
    expect(dirty?.lastCommitTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const mainCheckout = project.worktrees.find((worktree) => worktree.isMainCheckout);
    expect(mainCheckout).toMatchObject({ branch: 'main', dirty: false, commitsAhead: 0, commitsBehind: 0 });
  }, 60_000);

  it('never runs more git processes at once than the cap', async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    setOffMainExecutor(async (request) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        return await inHost(() => runHostExec(request));
      } finally {
        inFlight -= 1;
      }
    });

    await enumerateWorktrees({ resolveBaseRef: () => 'main' });

    expect(EXTRA_WORKTREES + 1).toBeGreaterThan(WORKTREE_READ_CONCURRENCY);
    expect(mostInFlight).toBeLessThanOrEqual(WORKTREE_READ_CONCURRENCY);
    // Not vacuous: the worktrees did overlap, so the cap is what held it down.
    expect(mostInFlight).toBeGreaterThan(1);
  }, 60_000);
});
