/**
 * Unit tests for the shared `.git/info/exclude` seeding mechanism
 * (`src/main/agent/shared/git-exclude.ts`): worktree commondir resolution,
 * idempotent marker-block appends, and legacy-marker compatibility. The
 * per-adapter seeding POLICIES (which patterns, carve-outs, gating) are
 * pinned in each adapter's own test file. All filesystem writes are
 * sandboxed under os.tmpdir().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureLocalGitExcludes,
  resolveGitCommonDir,
  resolveGitDir,
  settingsBaseDirectory,
} from '../../src/main/agent/shared/git-exclude';

let tmpRoot: string;
let workspace: string;

function excludePath(): string {
  return path.join(workspace, '.git', 'info', 'exclude');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-exclude-'));
  workspace = path.join(tmpRoot, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// The worktree's own git folder is where the link record lives (`worktree-links.ts`), so a wrong
// answer here reads or writes another worktree's record, or none.
describe('resolveGitDir', () => {
  it('is .git itself for a checkout, and the folder a worktree .git file names, not the common one', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    expect(resolveGitDir(workspace)).toBe(path.join(workspace, '.git'));

    const worktreeGitDir = path.join(tmpRoot, 'repo', '.git', 'worktrees', 'task-1');
    const worktreeCheckout = path.join(tmpRoot, 'checkout');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeCheckout, { recursive: true });
    fs.writeFileSync(path.join(worktreeCheckout, '.git'), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    expect(resolveGitDir(worktreeCheckout)).toBe(worktreeGitDir);
  });

  it('resolves a relative gitdir against the checkout', () => {
    const worktreeCheckout = path.join(tmpRoot, 'checkout');
    fs.mkdirSync(worktreeCheckout, { recursive: true });
    fs.writeFileSync(path.join(worktreeCheckout, '.git'), 'gitdir: ../repo/.git/worktrees/task-1\n');
    expect(resolveGitDir(worktreeCheckout)).toBe(path.join(tmpRoot, 'repo', '.git', 'worktrees', 'task-1'));
  });

  it('is null for a .git file that is not a pointer, and outside a checkout', () => {
    expect(resolveGitDir(workspace)).toBeNull();
    fs.writeFileSync(path.join(workspace, '.git'), 'not a gitdir pointer\n');
    expect(resolveGitDir(workspace)).toBeNull();
  });
});

describe('resolveGitCommonDir', () => {
  it('resolves a plain .git directory and a worktree .git file with commondir', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    expect(resolveGitCommonDir(workspace)).toBe(path.join(workspace, '.git'));

    // Worktree layout: <repo>/.git/worktrees/<name> gitdir, commondir -> ../..
    const repo = path.join(tmpRoot, 'repo');
    const worktreeGitDir = path.join(repo, '.git', 'worktrees', 'task-1');
    const worktreeCheckout = path.join(tmpRoot, 'checkout');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeCheckout, { recursive: true });
    fs.writeFileSync(path.join(worktreeCheckout, '.git'), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    expect(resolveGitCommonDir(worktreeCheckout)).toBe(path.join(repo, '.git'));
  });

  it('returns null for a .git FILE whose content does not match the gitdir pointer format', () => {
    fs.writeFileSync(path.join(workspace, '.git'), 'not a gitdir pointer\n');
    expect(resolveGitCommonDir(workspace)).toBeNull();
  });

  it('returns null outside a git checkout (seeding is a silent no-op)', () => {
    expect(resolveGitCommonDir(workspace)).toBeNull();
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/']);
    expect(fs.existsSync(excludePath())).toBe(false);
  });
});

// The exit-status classification behind a worktree session's settings base. Real git, because the
// classification is git's own exit statuses. Each case starts git processes, which can pass
// vitest's 5 s default under load.
describe('settingsBaseDirectory', { timeout: 30_000 }, () => {
  const SETTINGS_FOLDER = '.gemini';

  function git(directory: string, ...commandArguments: string[]): void {
    execFileSync('git', [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.test',
      '-c', 'commit.gpgsign=false',
      ...commandArguments,
    ], { cwd: directory, stdio: 'ignore' });
  }

  function writeSettings(directory: string): void {
    fs.mkdirSync(path.join(directory, SETTINGS_FOLDER), { recursive: true });
    fs.writeFileSync(path.join(directory, SETTINGS_FOLDER, 'settings.json'), '{}');
  }

  /** A repository with one commit and a worktree on its own branch. */
  function createRepositoryAndWorktree(): { projectRoot: string; worktree: string } {
    const projectRoot = path.join(tmpRoot, 'repo');
    fs.mkdirSync(projectRoot, { recursive: true });
    git(projectRoot, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'readme\n');
    git(projectRoot, 'add', 'README.md');
    git(projectRoot, 'commit', '-m', 'first');
    const worktree = path.join(tmpRoot, 'worktree');
    git(projectRoot, 'worktree', 'add', '-b', 'task', worktree);
    return { projectRoot, worktree };
  }

  it('starts from the worktree when git tracks its settings file', () => {
    const { projectRoot, worktree } = createRepositoryAndWorktree();
    writeSettings(worktree);
    git(worktree, 'add', `${SETTINGS_FOLDER}/settings.json`);
    git(worktree, 'commit', '-m', 'settings');

    expect(settingsBaseDirectory(worktree, projectRoot, SETTINGS_FOLDER)).toBe(worktree);
  });

  it('starts from the project root when git does not track the worktree file (exit 1)', () => {
    const { projectRoot, worktree } = createRepositoryAndWorktree();
    writeSettings(worktree);

    expect(settingsBaseDirectory(worktree, projectRoot, SETTINGS_FOLDER)).toBe(projectRoot);
  });

  it('starts from the project root when the worktree has no settings file', () => {
    const { projectRoot, worktree } = createRepositoryAndWorktree();

    expect(settingsBaseDirectory(worktree, projectRoot, SETTINGS_FOLDER)).toBe(projectRoot);
  });

  it('starts from the project root when the folder is no git checkout (exit 128 with no .git)', () => {
    const { projectRoot } = createRepositoryAndWorktree();
    const plainFolder = path.join(tmpRoot, 'plain');
    writeSettings(plainFolder);
    // Keep git from finding a repository in a parent of the temp folder.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', tmpRoot);

    try {
      expect(settingsBaseDirectory(plainFolder, projectRoot, SETTINGS_FOLDER)).toBe(projectRoot);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the worktree when its .git points at a git dir that is gone (exit 128 from a checkout)', () => {
    // A pruned or moved worktree: git refuses it. That is no answer about the file, so the
    // root's content must not replace the branch's.
    const { projectRoot } = createRepositoryAndWorktree();
    const brokenWorktree = path.join(tmpRoot, 'broken');
    writeSettings(brokenWorktree);
    fs.writeFileSync(path.join(brokenWorktree, '.git'), `gitdir: ${path.join(tmpRoot, 'no-such-gitdir')}\n`);

    expect(settingsBaseDirectory(brokenWorktree, projectRoot, SETTINGS_FOLDER)).toBe(brokenWorktree);
  });
});

describe('ensureLocalGitExcludes', () => {
  it('appends missing patterns under the marker, idempotently', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/', '.kangentic/']);
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/', '.kangentic/']);
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content.split('\n').filter((line) => line === '.kangentic/')).toHaveLength(1);
    expect(content).toContain('# kangentic:');
  });

  it('preserves an existing exclude file and appends with a separating newline', () => {
    fs.mkdirSync(path.join(workspace, '.git', 'info'), { recursive: true });
    fs.writeFileSync(excludePath(), '*.log'); // no trailing newline
    ensureLocalGitExcludes(workspace, ['.agents/plugins/kangentic/']);
    const lines = fs.readFileSync(excludePath(), 'utf-8').split('\n');
    expect(lines[0]).toBe('*.log');
    expect(lines).toContain('.agents/plugins/kangentic/');
  });

  it('seeds the generic marker on a fresh exclude file', () => {
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    ensureLocalGitExcludes(workspace, ['.kangentic/']);
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content).toContain('# kangentic: agent runtime files (local ignore, safe to remove)');
  });

  it('dedupes when the pattern is already the last line, with no trailing newline', () => {
    // Regression coverage carried over from the pre-move opencode-specific
    // suite: a file whose final byte IS the pattern (no trailing \n) must
    // still be recognized as "already present" so re-seeding never appends
    // a duplicate occurrence.
    fs.mkdirSync(path.join(workspace, '.git', 'info'), { recursive: true });
    fs.writeFileSync(
      excludePath(),
      '# kangentic: agent runtime files (local ignore, safe to remove)\n.kangentic/',
    );
    ensureLocalGitExcludes(workspace, ['.kangentic/']);
    const lines = fs.readFileSync(excludePath(), 'utf-8').split('\n');
    expect(lines.filter((line) => line === '.kangentic/')).toHaveLength(1);
  });

  it('never stacks a second marker over the legacy antigravity marker', () => {
    // Repos seeded before the module moved to shared/ carry the
    // adapter-branded marker; re-seeding with a NEW pattern must append the
    // pattern under that existing marker, not add a second marker block.
    fs.mkdirSync(path.join(workspace, '.git', 'info'), { recursive: true });
    fs.writeFileSync(
      excludePath(),
      '# kangentic: antigravity adapter runtime files (local ignore, safe to remove)\n.agents/plugins/kangentic/\n',
    );
    ensureLocalGitExcludes(workspace, ['.gemini/settings.json']);
    const lines = fs.readFileSync(excludePath(), 'utf-8').split('\n');
    expect(lines.filter((line) => line.startsWith('# kangentic:'))).toHaveLength(1);
    expect(lines).toContain('.gemini/settings.json');
    expect(lines).toContain('.agents/plugins/kangentic/');
  });
});
