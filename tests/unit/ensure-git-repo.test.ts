/**
 * Unit coverage for ensureGitRepo(), which makes a picked folder git-backed as part of
 * adding a project - without asking.
 *
 * Two reasons this matters more than a normal helper:
 *
 *  - It closes the credential path. `ensureGitignore` early-returns when there is no repo,
 *    so a project added to a non-repo leaves `.kangentic/mcp-config.json` - carrying an MCP
 *    auth token - in a directory nothing ignores, waiting for a later `git init` to start
 *    tracking it.
 *  - It now runs with no confirmation step in front of it. That makes the NESTED-REPO case
 *    the sharp edge: `isGitRepo` only looks for `.git` in that exact folder, so a
 *    subdirectory of someone's real repository reads as "not a repo". Initialising there
 *    would silently shadow their history for everything beneath that point.
 *
 * Runs the real `git` binary against a temp directory rather than mocking child_process:
 * the behaviour worth pinning is what git actually does, and the function is a thin wrapper
 * whose value is entirely in the guards around that call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureGitRepo, isGitRepo, isInsideGitRepo, hasCommits } from '../../src/main/git/git-checks';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-ensure-git-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('ensureGitRepo', () => {
  it('initialises a plain folder', async () => {
    const folder = path.join(workspace, 'plain-folder');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'readme.txt'), 'no git here');
    expect(isGitRepo(folder)).toBe(false);

    const result = await ensureGitRepo(folder);

    expect(result).toEqual({ ok: true, created: true, error: null });
    expect(isGitRepo(folder)).toBe(true);
  });

  it('leaves existing files untouched', async () => {
    const folder = path.join(workspace, 'has-content');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'keep-me.txt'), 'original contents');

    await ensureGitRepo(folder);

    expect(fs.readFileSync(path.join(folder, 'keep-me.txt'), 'utf8')).toBe('original contents');
  });

  it('is a no-op success on a folder that is already a repository', async () => {
    // Success with created:false, not an error: the caller only warns when git could not
    // be set up, and "it already was" is not something to warn about.
    const folder = path.join(workspace, 'already-a-repo');
    fs.mkdirSync(folder);
    await ensureGitRepo(folder);

    const second = await ensureGitRepo(folder);

    expect(second).toEqual({ ok: true, created: false, error: null });
  });

  it('does NOT nest a repository inside an existing one', async () => {
    // The sharp edge now that this runs unprompted. `isGitRepo` on the subdirectory is
    // false, so without the inside-a-repo check this would create a nested repo that
    // shadows the parent's history for everything beneath it.
    const parent = path.join(workspace, 'real-repo');
    fs.mkdirSync(parent);
    await ensureGitRepo(parent);
    const nested = path.join(parent, 'packages', 'sub-project');
    fs.mkdirSync(nested, { recursive: true });
    expect(isGitRepo(nested)).toBe(false);

    const result = await ensureGitRepo(nested);

    expect(result).toEqual({ ok: true, created: false, error: null });
    expect(fs.existsSync(path.join(nested, '.git'))).toBe(false);
  });

  it('leaves the repository it creates with NO commits', async () => {
    // The state that broke the first move after adding a folder: `git init` gives an unborn
    // HEAD, so `git worktree add ... main` fails with `fatal: invalid reference: main`. Pinned
    // deliberately rather than papered over - committing on the user's behalf would either
    // produce empty worktrees (an empty first commit) or commit their whole folder. The
    // callers check `hasCommits` and run in the project directory until there is one.
    const folder = path.join(workspace, 'brand-new');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'file.txt'), 'uncommitted');

    await ensureGitRepo(folder);

    expect(await hasCommits(folder)).toBe(false);
  });

  it('reports commits once the folder has one', async () => {
    const folder = path.join(workspace, 'committed');
    fs.mkdirSync(folder);
    await ensureGitRepo(folder);
    fs.writeFileSync(path.join(folder, 'file.txt'), 'content');
    const run = (args: string[]) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' });
    run(['config', 'user.email', 'dev@example.com']);
    run(['config', 'user.name', 'Dev']);
    run(['add', '-A']);
    run(['commit', '-m', 'Initial commit']);

    expect(await hasCommits(folder)).toBe(true);
  });

  it('refuses a path that does not exist', async () => {
    const result = await ensureGitRepo(path.join(workspace, 'no-such-folder'));

    expect(result.ok).toBe(false);
    expect(result.created).toBe(false);
    expect(result.error).toMatch(/no longer exists/i);
  });

  it('refuses a path that is a file rather than a directory', async () => {
    const file = path.join(workspace, 'a-file.txt');
    fs.writeFileSync(file, 'not a directory');

    const result = await ensureGitRepo(file);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(file, '.git'))).toBe(false);
  });

  it('reports failure as a value rather than throwing, so the caller can warn inline', async () => {
    // The caller opens the project regardless and raises a toast; an exception would
    // surface as an unhandled rejection and the open would just appear to do nothing.
    await expect(ensureGitRepo(path.join(workspace, 'definitely', 'not', 'here')))
      .resolves.toMatchObject({ ok: false });
  });

  it('creates the initial branch as "main" regardless of the machine\'s init.defaultBranch', async () => {
    // The bug this pins: `git init` alone honors init.defaultBranch, and an unset config
    // (still the default on plenty of installs) gives "master" while
    // DEFAULT_CONFIG.git.defaultBaseBranch is the hardcoded string 'main' - breaking the
    // first `git worktree add ... main` with `fatal: invalid reference: main`.
    //
    // A LOCAL repo config can't carry init.defaultBranch (there is no repo yet to hold
    // one), so this forges a throwaway GLOBAL config with defaultBranch=master, plus an
    // empty SYSTEM config so a real system-level setting on this machine can't mask the
    // point being made. Both are scoped to this one call and restored in `finally`.
    const globalConfigPath = path.join(workspace, 'forged-global-gitconfig');
    fs.writeFileSync(globalConfigPath, '[init]\n\tdefaultBranch = master\n');
    const systemConfigPath = path.join(workspace, 'forged-system-gitconfig');
    fs.writeFileSync(systemConfigPath, '');

    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    process.env.GIT_CONFIG_SYSTEM = systemConfigPath;

    try {
      const folder = path.join(workspace, 'branch-name-check');
      fs.mkdirSync(folder);

      const result = await ensureGitRepo(folder);

      expect(result).toEqual({ ok: true, created: true, error: null });
      // symbolic-ref, not rev-parse --abbrev-ref: HEAD is unborn (no commits yet), and
      // rev-parse --abbrev-ref does not resolve an unborn HEAD the same way.
      const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: folder })
        .toString()
        .trim();
      expect(branch).toBe('main');
    } finally {
      if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
      if (previousGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previousGitConfigSystem;
    }
  });

  it('returns ok:false instead of throwing when the folder exists but cannot be stat\'ed', async () => {
    // existsSync alone can't reach this: a folder that exists but throws on statSync
    // (Windows EPERM on a reparse point, EBUSY on a locked folder, a TOCTOU delete
    // between the two calls) is a distinct failure mode from "does not exist" and needs
    // its own try/catch around the guard, not just the existsSync short-circuit above.
    const folder = path.join(workspace, 'unreadable');
    fs.mkdirSync(folder);

    const statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, stat'), { code: 'EPERM' });
    });

    try {
      await expect(ensureGitRepo(folder)).resolves.toEqual({
        ok: false,
        created: false,
        error: 'That folder could not be read.',
      });
    } finally {
      statSyncSpy.mockRestore();
    }

    // Confirms the guard's try/catch is what caught this, not some other failure path:
    // git never ran, so the folder is untouched.
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
  });
});

describe('isInsideGitRepo', () => {
  it('is true for a repo root and for any folder beneath it', async () => {
    const repo = path.join(workspace, 'repo');
    fs.mkdirSync(repo);
    await ensureGitRepo(repo);
    const deep = path.join(repo, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });

    expect(await isInsideGitRepo(repo)).toBe(true);
    expect(await isInsideGitRepo(deep)).toBe(true);
  });

  it('is false for a standalone folder outside any repository', async () => {
    // The temp workspace lives under os.tmpdir(), which is not inside a repo - that is
    // what makes this assertion meaningful. Run from inside the Kangentic checkout, every
    // path would report true and the guard above would look like it worked when it did not.
    const orphan = path.join(workspace, 'orphan');
    fs.mkdirSync(orphan);

    expect(await isInsideGitRepo(orphan)).toBe(false);
  });
});
