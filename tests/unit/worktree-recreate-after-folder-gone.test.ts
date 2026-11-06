/**
 * A task's card outlives its worktree folder, so Resume has to be able to make
 * the folder again. Git refuses to add a path it still has registered ("missing
 * but already registered worktree"), and the branch reads as checked out there,
 * so without a prune first the card's only way back fails.
 *
 * Real git and a real temp repo: this pins what git itself does, which no mock
 * could. Red without the prune in `createWorktree`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../../src/main/git/worktree-manager';
import { clearFetchCache } from '../../src/main/git/fetch-throttle';

vi.setConfig({ testTimeout: 60_000 });

let workspace: string;
let projectPath: string;

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true }).toString();
}

beforeAll(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-recreate-')));
  projectPath = path.join(workspace, 'project');
  fs.mkdirSync(projectPath);
  run(projectPath, ['init', '-b', 'main']);
  run(projectPath, ['config', 'user.email', 'dev@example.com']);
  run(projectPath, ['config', 'user.name', 'Dev']);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), '.kangentic/\n');
  fs.writeFileSync(path.join(projectPath, 'README.md'), 'project\n');
  run(projectPath, ['add', '-A']);
  run(projectPath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  clearFetchCache();
});

afterAll(async () => {
  clearFetchCache();
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a worktree folder deleted behind git\'s back', () => {
  it('comes back at the same path, on the same branch, with its commits', async () => {
    const task = {
      id: 'aaaa1111-0000-0000-0000-000000000000',
      title: 'Recreate me',
      display_id: 42,
      worktree_path: null as string | null,
      worktree_folder: null as string | null,
      branch_name: null as string | null,
    };
    const manager = new WorktreeManager(projectPath);
    const first = await manager.withLock(() => manager.createWorktree(task, 'main'));
    fs.writeFileSync(path.join(first.worktreePath, 'work.txt'), 'committed work\n');
    run(first.worktreePath, ['add', '-A']);
    run(first.worktreePath, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'work']);
    const tip = run(first.worktreePath, ['rev-parse', 'HEAD']).trim();

    // What the sweep did: the folder goes, and git still has it registered.
    fs.rmSync(first.worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    expect(run(projectPath, ['worktree', 'list', '--porcelain'])).toContain('prunable');

    const recreated = await manager.withLock(() => manager.createWorktree(
      { ...task, worktree_path: first.worktreePath, worktree_folder: first.worktreeFolder, branch_name: first.branchName },
      'main',
      first.branchName,
    ));

    expect(recreated.worktreePath).toBe(first.worktreePath);
    expect(run(recreated.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(tip);
    expect(fs.readFileSync(path.join(recreated.worktreePath, 'work.txt'), 'utf-8')).toContain('committed work');
  });

  it('a first creation runs no prune, so it adds no git process to every task\'s start', async () => {
    const manager = new WorktreeManager(projectPath);
    const task = {
      id: 'bbbb2222-0000-0000-0000-000000000000',
      title: 'First creation',
      display_id: 43,
      worktree_path: null as string | null,
      worktree_folder: null as string | null,
      branch_name: null as string | null,
    };
    const other = await manager.withLock(() => manager.createWorktree(
      { ...task, id: 'cccc3333-0000-0000-0000-000000000000', title: 'Other', display_id: 44 },
      'main',
    ));
    fs.rmSync(other.worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

    await manager.withLock(() => manager.createWorktree(task, 'main'));

    // Pruned, it would have dropped the other task's stale registration too.
    expect(run(projectPath, ['worktree', 'list', '--porcelain'])).toContain('prunable');
  });
});
