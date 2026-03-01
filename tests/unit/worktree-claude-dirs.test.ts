/**
 * Integration tests for worktree `.claude/` directory handling.
 *
 * These tests create a real temp git repo with tracked `.claude/` files and
 * exercise WorktreeManager against real git operations (sparse-checkout,
 * status, staged changes, rebase). No mocks — validates that sparse-checkout
 * correctly excludes `.claude/commands/` and `.claude/skills/` from worktree disk
 * while keeping the rest of `.claude/` (settings.json, etc.) and survives git operations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { WorktreeManager } from '../../src/main/git/worktree-manager';

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

/** Run a git command in the temp repo. */
function git(args: string): string {
  return execSync(`git -C "${tmpDir}" ${args}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Run a git command in a worktree directory. */
function wtGit(worktreePath: string, args: string): string {
  return execSync(`git -C "${worktreePath}" ${args}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Create a file relative to tmpDir, creating parent dirs as needed. */
function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgnt-wt-claude-'));

  // Initialize a git repo with tracked .claude/ files
  git('init -b main');
  git('config user.email "test@test.com"');
  git('config user.name "Test"');

  writeFile('.claude/commands/review.md', '# Review command');
  writeFile('.claude/commands/merge-back.md', '# Merge-back command');
  writeFile('.claude/skills/deploy.md', '# Deploy skill');
  writeFile('.claude/settings.local.json', JSON.stringify({ userKey: 'userValue' }));

  git('add -A');
  git('commit -m "initial commit with .claude files"');
});

afterEach(() => {
  // Prune worktrees before deleting the repo dir
  try {
    git('worktree prune');
  } catch {
    // May fail if tmpDir is already gone
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Worktree .claude/ directory handling (sparse-checkout)', () => {
  const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const TASK_TITLE = 'Test Claude dirs';

  it('.claude/commands/ and .claude/skills/ excluded from worktree disk via sparse-checkout', async () => {
    const mgr = new WorktreeManager(tmpDir);
    const { worktreePath } = await mgr.createWorktree(
      TASK_ID, TASK_TITLE, 'main',
    );

    // .claude/ directory should exist (settings present from git)
    expect(fs.existsSync(path.join(worktreePath, '.claude'))).toBe(true);
    // .claude/commands/ should NOT exist — excluded by sparse-checkout
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'commands'))).toBe(false);
    // .claude/skills/ should NOT exist — excluded by sparse-checkout
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'skills'))).toBe(false);
    // Other .claude/ contents should exist
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'settings.local.json'))).toBe(true);
  });

  it('sparse-checkout keeps git status clean', async () => {
    const mgr = new WorktreeManager(tmpDir);
    const { worktreePath } = await mgr.createWorktree(
      TASK_ID, TASK_TITLE, 'main',
    );

    // git status should be completely clean — no deletions reported
    const status = wtGit(worktreePath, 'status --porcelain');
    expect(status).toBe('');
  });

  it('sparse-checkout survives simulated rebase', async () => {
    const mgr = new WorktreeManager(tmpDir);
    const { worktreePath } = await mgr.createWorktree(
      TASK_ID, TASK_TITLE, 'main',
    );

    // Create a commit in the worktree
    const featureFile = path.join(worktreePath, 'feature.ts');
    fs.writeFileSync(featureFile, 'export const x = 1;');
    wtGit(worktreePath, 'add feature.ts');
    wtGit(worktreePath, 'commit -m "add feature"');

    // Create a new commit on main (in the parent repo) to rebase onto
    writeFile('main-change.ts', 'export const y = 2;');
    git('add main-change.ts');
    git('commit -m "main: add change"');

    // Rebase the worktree branch onto main
    wtGit(worktreePath, 'rebase main');

    // .claude/commands/ and .claude/skills/ should STILL not exist on disk after rebase
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'commands'))).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'skills'))).toBe(false);
    // .claude/ itself should still exist (other files present)
    expect(fs.existsSync(path.join(worktreePath, '.claude'))).toBe(true);

    // git status should still be clean
    const status = wtGit(worktreePath, 'status --porcelain');
    expect(status).toBe('');
  });

  it('staged changes preserved across worktree creation', async () => {
    const mgr = new WorktreeManager(tmpDir);
    const { worktreePath } = await mgr.createWorktree(
      TASK_ID, TASK_TITLE, 'main',
    );

    // Create and stage a new file in the worktree
    const newFile = path.join(worktreePath, 'feature.ts');
    fs.writeFileSync(newFile, 'export const x = 1;');
    wtGit(worktreePath, 'add feature.ts');

    // The staged file should still be staged
    const staged = wtGit(worktreePath, 'diff --cached --name-only');
    expect(staged).toContain('feature.ts');
  });

  it('copyFiles for non-.claude paths still works', async () => {
    // Create a file to copy
    writeFile('config/env.example', 'DB_HOST=localhost');
    git('add -A');
    git('commit -m "add config"');

    const mgr = new WorktreeManager(tmpDir);
    const { worktreePath } = await mgr.createWorktree(
      TASK_ID, TASK_TITLE, 'main',
      ['config/env.example'],
    );

    // Non-.claude file should be copied
    const dest = path.join(worktreePath, 'config', 'env.example');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('DB_HOST=localhost');
  });

  it('.claude/ copyFiles entries are skipped by copy loop', async () => {
    const mgr = new WorktreeManager(tmpDir);
    const { worktreePath } = await mgr.createWorktree(
      TASK_ID, TASK_TITLE, 'main',
      ['.claude/settings.local.json'],
    );

    // .claude/settings.local.json exists from sparse-checkout (it's in git),
    // but the copyFiles loop should have skipped the .claude/ entry (no double-copy).
    // Verify it has the original git content, not a fresh copy.
    const content = fs.readFileSync(
      path.join(worktreePath, '.claude', 'settings.local.json'), 'utf-8',
    );
    expect(JSON.parse(content)).toEqual({ userKey: 'userValue' });
  });
});
