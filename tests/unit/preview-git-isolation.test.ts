/**
 * Devtools git calls against a preview clone must never reach the worktree the
 * preview runs from.
 *
 * Every clone sits under <worktree>/.kangentic/data/preview-projects/. A preview
 * relaunch overlapped the previous preview's exit cleanup, which deleted the new
 * clone's `.git`. fillPreviewClone's `git -C <clone> reset --hard HEAD` then
 * searched the parent folders, found the worktree, and wiped every uncommitted
 * change in it. These tests rebuild that shape with a real repo holding
 * uncommitted work and a clone folder with no `.git` inside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ephemeral-projects.ts pulls in electron's ipcMain and the project DB at import time;
// neither is exercised here.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import { checkoutTeamConfig, ensurePreviewClone, fillPreviewClone, runPreviewGit } from '../../src/devtools/main/ephemeral-projects';

const REPO_ROOT = path.resolve(__dirname, '../..');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf-8' }).trim();
}

describe('preview clone git isolation', () => {
  let tempDir: string;
  let outerRepo: string;
  let previewProjectsDir: string;
  let missingGitClone: string;

  beforeEach(() => {
    // Canonical, because git reports real paths: macOS's tmpdir is a symlink into
    // /private, and a Windows tmpdir can be an 8.3 short name.
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-git-isolation-')));
    outerRepo = path.join(tempDir, 'worktree');
    fs.mkdirSync(outerRepo);
    git(outerRepo, ['init', '-b', 'main']);
    git(outerRepo, ['config', 'user.email', 'dev@example.com']);
    git(outerRepo, ['config', 'user.name', 'Dev']);
    git(outerRepo, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(outerRepo, 'kangentic.json'), '{"version":1}\n');
    fs.writeFileSync(path.join(outerRepo, 'tracked.txt'), 'committed\n');
    git(outerRepo, ['add', '.']);
    git(outerRepo, ['commit', '-m', 'init']);

    // The developer's uncommitted work: a modified tracked file, a modified board
    // config, and a staged new file. `reset --hard` would destroy all three.
    fs.writeFileSync(path.join(outerRepo, 'tracked.txt'), 'uncommitted work\n');
    fs.writeFileSync(path.join(outerRepo, 'kangentic.json'), '{"version":1,"edited":true}\n');
    fs.writeFileSync(path.join(outerRepo, 'staged.txt'), 'staged work\n');
    git(outerRepo, ['add', 'staged.txt']);

    previewProjectsDir = path.join(outerRepo, '.kangentic', 'data', 'preview-projects');
    // What the overlapping cleanup left behind: the folder, recreated app state, no `.git`.
    missingGitClone = path.join(previewProjectsDir, 'project-1');
    fs.mkdirSync(path.join(missingGitClone, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(missingGitClone, '.kangentic'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function expectOuterWorkIntact(): void {
    expect(fs.readFileSync(path.join(outerRepo, 'tracked.txt'), 'utf-8')).toBe('uncommitted work\n');
    expect(fs.readFileSync(path.join(outerRepo, 'kangentic.json'), 'utf-8')).toBe('{"version":1,"edited":true}\n');
    expect(fs.existsSync(path.join(outerRepo, 'staged.txt'))).toBe(true);
    expect(git(outerRepo, ['diff', '--cached', '--name-only'])).toBe('staged.txt');
  }

  it('the control: a bare `git -C` from that folder really does resolve the enclosing repo', () => {
    // Without this, the cases below could pass because the fixture never reproduced the hazard.
    expect(path.resolve(git(missingGitClone, ['rev-parse', '--show-toplevel']))).toBe(path.resolve(outerRepo));
  });

  it('fillPreviewClone leaves the enclosing repo untouched when the clone has no .git', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fillPreviewClone(missingGitClone);
    expectOuterWorkIntact();
  });

  it('checkoutTeamConfig leaves the enclosing repo\'s kangentic.json untouched when the clone has no .git', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await checkoutTeamConfig(missingGitClone);
    expectOuterWorkIntact();
    expect(fs.existsSync(path.join(missingGitClone, 'kangentic.json'))).toBe(false);
  });

  it('runPreviewGit fails instead of resolving a repo above the folder', async () => {
    await expect(runPreviewGit(missingGitClone, ['rev-parse', '--show-toplevel'])).rejects.toThrow();
  });

  it('forwards the env a caller passes, which is how the seed backdates its commits', async () => {
    // seed-git-changes.ts hands GIT_AUTHOR_DATE and GIT_COMMITTER_DATE through the
    // helper's third argument. Every other case here calls it without one, so a
    // helper that dropped the argument would pass them all and the seeded history
    // would silently carry the current time. A fresh repo, because `outerRepo`
    // holds staged work and a `--no-checkout` clone has no index to commit from.
    const seededRepo = path.join(tempDir, 'seeded');
    fs.mkdirSync(seededRepo);
    git(seededRepo, ['init', '-b', 'main']);
    // The same shape the seed passes (Date.toISOString).
    const backdated = new Date('2020-01-02T03:04:05Z').toISOString();

    await runPreviewGit(
      seededRepo,
      ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'backdated'],
      { GIT_AUTHOR_DATE: backdated, GIT_COMMITTER_DATE: backdated },
    );

    // Epoch seconds, so the machine's timezone cannot change the comparison.
    expect(git(seededRepo, ['log', '-1', '--format=%at %ct'])).toBe('1577934245 1577934245');
  });

  it('applies its own ceiling after the caller\'s env, so a caller cannot lift it', async () => {
    await expect(
      runPreviewGit(missingGitClone, ['rev-parse', '--show-toplevel'], { GIT_CEILING_DIRECTORIES: '' }),
    ).rejects.toThrow();
  });

  it('fills a clone once, so an in-app restart does not reset an agent\'s work in it', async () => {
    // After an in-app restart the boot adopts the same clone and calls the fill
    // again, while the agent the restart resumed may have uncommitted edits there.
    const realClone = path.join(previewProjectsDir, 'project-3');
    git(tempDir, ['clone', '--no-checkout', '--local', outerRepo, realClone]);
    git(realClone, ['config', 'core.autocrlf', 'false']);

    await fillPreviewClone(realClone);
    expect(fs.readFileSync(path.join(realClone, 'tracked.txt'), 'utf-8')).toBe('committed\n');

    fs.writeFileSync(path.join(realClone, 'tracked.txt'), 'the resumed agent\'s edit\n');
    await fillPreviewClone(realClone);

    expect(fs.readFileSync(path.join(realClone, 'tracked.txt'), 'utf-8')).toBe('the resumed agent\'s edit\n');
    expectOuterWorkIntact();
  });

  it('still fills a real clone and resolves its task worktrees', async () => {
    const realClone = path.join(previewProjectsDir, 'project-2');
    git(tempDir, ['clone', '--no-checkout', '--local', outerRepo, realClone]);
    // A clone does not copy the source's local config, so pin line endings here too.
    git(realClone, ['config', 'core.autocrlf', 'false']);

    await fillPreviewClone(realClone);

    expect(fs.readFileSync(path.join(realClone, 'tracked.txt'), 'utf-8')).toBe('committed\n');
    expectOuterWorkIntact();

    // seed-git-changes passes task worktrees, whose `.git` is a file, through the same helper.
    const taskWorktree = path.join(realClone, '.kangentic', 'worktrees', '1');
    git(realClone, ['worktree', 'add', '-b', 'task-branch', taskWorktree]);
    const { stdout } = await runPreviewGit(taskWorktree, ['rev-parse', '--show-toplevel']);
    expect(path.resolve(stdout.trim())).toBe(path.resolve(taskWorktree));
  });
});

describe('ensurePreviewClone and the preview boot never fall back to the worktree', () => {
  let tempDir: string;
  let sourceRepo: string;
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-clone-leftover-'));
    sourceRepo = path.join(tempDir, 'worktree');
    fs.mkdirSync(sourceRepo);
    git(sourceRepo, ['init', '-b', 'main']);
    git(sourceRepo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'init']);
    dataDir = path.join(sourceRepo, '.kangentic', 'data');
    previousDataDir = process.env.KANGENTIC_DATA_DIR;
    process.env.KANGENTIC_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.KANGENTIC_DATA_DIR;
    else process.env.KANGENTIC_DATA_DIR = previousDataDir;
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('clears a leftover folder with no .git and clones into it', async () => {
    // A data-dir wipe that got the .git but not the rest. `git clone` refuses a
    // non-empty destination, which used to send the preview to the worktree itself.
    const cloneDir = path.join(dataDir, 'preview-projects', 'project-1');
    fs.mkdirSync(path.join(cloneDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cloneDir, '.claude', 'settings.json'), '{}');

    await ensurePreviewClone(cloneDir, sourceRepo);

    expect(fs.existsSync(path.join(cloneDir, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(cloneDir, '.claude'))).toBe(false);
  });

  it('adopts a clone already on disk without touching it', async () => {
    const cloneDir = path.join(dataDir, 'preview-projects', 'project-2');
    git(tempDir, ['clone', '--no-checkout', '--local', sourceRepo, cloneDir]);
    fs.writeFileSync(path.join(cloneDir, 'marker.txt'), 'kept');

    await ensurePreviewClone(cloneDir, sourceRepo);

    expect(fs.readFileSync(path.join(cloneDir, 'marker.txt'), 'utf-8')).toBe('kept');
  });

  it('refuses to clear a folder that is not directly under the preview-projects root', async () => {
    const elsewhere = path.join(tempDir, 'not-a-preview-clone');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'precious.txt'), 'keep me');

    await expect(ensurePreviewClone(elsewhere, sourceRepo)).rejects.toThrow(/Refusing to clear/);
    expect(fs.readFileSync(path.join(elsewhere, 'precious.txt'), 'utf-8')).toBe('keep me');
  });

  it('the ephemeral boot opens no project, never the worktree, when cloning fails', () => {
    const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf-8');
    const blockStart = indexSource.indexOf('if (__KANGENTIC_DEV__ && isEphemeral && cwd) {');
    expect(blockStart, 'expected the ephemeral preview branch in src/main/index.ts').toBeGreaterThan(-1);
    const normalOpen = indexSource.indexOf('if (!projectPath) return null;', blockStart);
    expect(normalOpen).toBeGreaterThan(blockStart);
    const ephemeralBranch = indexSource.slice(blockStart, normalOpen);
    const catchStart = ephemeralBranch.indexOf('catch (cloneError)');
    expect(catchStart, 'expected the clone failure to be caught').toBeGreaterThan(-1);
    // The catch returns, and so does the branch's end, so nothing reaches openProjectByPath(cwd).
    expect(ephemeralBranch.slice(catchStart)).toMatch(/catch \(cloneError\) \{[^}]*return null;/);
    expect(ephemeralBranch.trimEnd()).toMatch(/return null;\s*\}$/);
  });
});

describe('devtools git calls all go through runPreviewGit', () => {
  const DEVTOOLS_DIR = path.join(REPO_ROOT, 'src', 'devtools');

  function devtoolsSourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...devtoolsSourceFiles(fullPath));
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(fullPath);
    }
    return files;
  }

  function functionBody(source: string, functionName: string): string {
    const start = source.indexOf(`function ${functionName}(`);
    expect(start, `expected a function named ${functionName}`).toBeGreaterThan(-1);
    // The body opens with the brace that ends the signature line; a return type such
    // as `Promise<{ stdout: string }>` carries braces of its own earlier on that line.
    const signatureEnd = /\{\r?\n/.exec(source.slice(start));
    expect(signatureEnd, `expected a body for ${functionName}`).not.toBeNull();
    const open = start + signatureEnd!.index;
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(open, index + 1);
      }
    }
    throw new Error(`unbalanced braces in ${functionName}`);
  }

  it('starts git directly only to clone, or inside runPreviewGit itself', () => {
    const offenders: string[] = [];
    for (const file of devtoolsSourceFiles(DEVTOOLS_DIR)) {
      const source = fs.readFileSync(file, 'utf-8');
      const helperBody = file.endsWith('ephemeral-projects.ts') ? functionBody(source, 'runPreviewGit') : '';
      for (const match of source.matchAll(/\b(execFileAsync|execFile|execFileSync|spawn|spawnSync)\(\s*'git'\s*,\s*\[([^\]]*)/g)) {
        const inHelper = helperBody !== '' && helperBody.includes(match[0]);
        // A clone creates a new repo at a path it is given; it never searches upward.
        const isClone = /'clone'/.test(match[2]);
        if (!inHelper && !isClone) offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}`);
      }
    }
    expect(offenders, 'a devtools git call bypasses runPreviewGit, so a preview clone with no .git would run it against the worktree').toEqual([]);
  });

  it('routes the three known call sites through the helper (so the scan above cannot pass vacuously)', () => {
    const ephemeral = fs.readFileSync(path.join(DEVTOOLS_DIR, 'main', 'ephemeral-projects.ts'), 'utf-8');
    const seed = fs.readFileSync(path.join(DEVTOOLS_DIR, 'main', 'seed-git-changes.ts'), 'utf-8');
    expect(functionBody(ephemeral, 'checkoutTeamConfig')).toContain('runPreviewGit(');
    expect(functionBody(ephemeral, 'fillPreviewClone')).toContain('runPreviewGit(');
    expect(functionBody(seed, 'runGit')).toContain('runPreviewGit(');
    expect(functionBody(ephemeral, 'runPreviewGit')).toContain('GIT_CEILING_DIRECTORIES');
  });
});
