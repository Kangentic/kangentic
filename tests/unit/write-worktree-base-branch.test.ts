/**
 * Real-git coverage for `writeWorktreeBaseBranch` (src/main/git/worktree-manager.ts).
 *
 * `kangentic.baseBranch` is what /pull-request, /merge-pull-request, /merge-back
 * and local-only-commits read to pick a task's target branch. A plain
 * `git config` from a LINKED worktree writes the repo's SHARED `.git/config`, so
 * every worktree used to read whichever base was written last. The helper writes
 * the worktree's OWN `config.worktree` with `--worktree`, and falls back to the
 * shared write when git refuses `--worktree` (no `extensions.worktreeConfig`).
 *
 * Real git on purpose, mirroring worktree-base-branch.test.ts: what matters is
 * which config FILE the value lands in, which only git decides. Two details make
 * the fixture non-obvious:
 *
 *   - `--worktree` only refuses without the extension when the repo has MORE than
 *     one working tree. With a lone main checkout git treats it as `--local`, so
 *     the fallback branch would never run. Both cases therefore need a linked
 *     worktree from `git worktree add`, and the helper is called from that one.
 *   - Sparse-checkout is what turns the extension on in production
 *     (createWorktree runs it before this write), so the "extension on" case sets
 *     it directly instead of running sparse-checkout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { writeWorktreeBaseBranch } from '../../src/main/git/worktree-manager';

const CONFIG_KEY = 'kangentic.baseBranch';

let workspace: string;

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-base-branch-config-')));
});

afterEach(async () => {
  // Retry: these trees hold real linked-worktree checkouts, and on Windows a handle held a
  // beat longer (AV, indexer, the just-exited git process) surfaces as EBUSY/EPERM.
  await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();
}

/** The value `git config --get` prints, or null when git exits 1 because the key is unset. */
function readConfig(cwd: string, scopeArgs: string[]): string | null {
  try {
    return git(cwd, ['config', ...scopeArgs, '--get', CONFIG_KEY]).trim();
  } catch {
    return null;
  }
}

function createRepoWithLinkedWorktrees(options: { worktreeConfigExtension: boolean }): {
  repo: string;
  firstWorktree: string;
  secondWorktree: string;
} {
  const repo = path.join(workspace, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'dev@example.com']);
  git(repo, ['config', 'user.name', 'Dev']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.excludesFile', path.join(workspace, 'no-such-excludes-file')]);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);

  const firstWorktree = path.join(workspace, 'worktree-one');
  const secondWorktree = path.join(workspace, 'worktree-two');
  git(repo, ['worktree', 'add', '-b', 'task-one', firstWorktree]);
  git(repo, ['worktree', 'add', '-b', 'task-two', secondWorktree]);

  if (options.worktreeConfigExtension) {
    git(repo, ['config', 'extensions.worktreeConfig', 'true']);
  }
  return { repo, firstWorktree, secondWorktree };
}

describe('writeWorktreeBaseBranch (real git)', () => {
  it('writes the linked worktree\'s own config and leaves the shared repo config and sibling worktrees alone', async () => {
    const { repo, firstWorktree, secondWorktree } = createRepoWithLinkedWorktrees({ worktreeConfigExtension: true });

    await writeWorktreeBaseBranch(simpleGit(firstWorktree), 'develop');
    await writeWorktreeBaseBranch(simpleGit(secondWorktree), 'release/2.0');

    // Each worktree holds its own value in config.worktree.
    expect(readConfig(firstWorktree, ['--worktree'])).toBe('develop');
    expect(readConfig(secondWorktree, ['--worktree'])).toBe('release/2.0');
    // Nothing reached the shared .git/config, so no worktree can read another's base.
    expect(readConfig(repo, ['--local'])).toBeNull();
    // Readers keep calling a plain `git config kangentic.baseBranch` and get their own worktree's value.
    expect(readConfig(firstWorktree, [])).toBe('develop');
    expect(readConfig(secondWorktree, [])).toBe('release/2.0');
    // The main checkout reads neither worktree's base.
    expect(readConfig(repo, [])).toBeNull();
  }, 20000);

  it('overwrites the same worktree\'s earlier value on a base-branch switch', async () => {
    const { repo, firstWorktree, secondWorktree } = createRepoWithLinkedWorktrees({ worktreeConfigExtension: true });

    await writeWorktreeBaseBranch(simpleGit(firstWorktree), 'develop');
    await writeWorktreeBaseBranch(simpleGit(secondWorktree), 'release/2.0');
    await writeWorktreeBaseBranch(simpleGit(firstWorktree), 'main');

    expect(readConfig(firstWorktree, ['--worktree'])).toBe('main');
    // The sibling keeps its base: a switch in one task cannot change another task's base.
    expect(readConfig(secondWorktree, ['--worktree'])).toBe('release/2.0');
    expect(readConfig(repo, ['--local'])).toBeNull();
  }, 20000);

  it('falls back to the shared repo config when the worktree-config extension is off', async () => {
    const { repo, firstWorktree } = createRepoWithLinkedWorktrees({ worktreeConfigExtension: false });

    // Premise of the fallback: with several working trees and no extension git refuses
    // `--worktree` and writes nothing. If a future git stops refusing, this test says so
    // here instead of passing for the wrong reason below.
    expect(() => git(firstWorktree, ['config', '--worktree', CONFIG_KEY, 'probe'])).toThrow();

    await writeWorktreeBaseBranch(simpleGit(firstWorktree), 'develop');

    // The value still lands, in the shared config, and a plain read finds it from anywhere.
    expect(readConfig(repo, ['--local'])).toBe('develop');
    expect(readConfig(firstWorktree, [])).toBe('develop');
  }, 20000);
});
