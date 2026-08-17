/**
 * Unit tests for the shared `.git/info/exclude` seeding mechanism
 * (`src/main/agent/shared/git-exclude.ts`): worktree commondir resolution,
 * idempotent marker-block appends, and legacy-marker compatibility. The
 * per-adapter seeding POLICIES (which patterns, carve-outs, gating) are
 * pinned in each adapter's own test file. All filesystem writes are
 * sandboxed under os.tmpdir().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureLocalGitExcludes,
  resolveGitCommonDir,
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
