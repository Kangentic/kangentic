/**
 * Unit tests for migrateCopilotProjectData()
 * (src/main/agent/adapters/copilot/project-relocation.ts).
 *
 * Copilot records each session's working directory in
 * ~/.copilot/session-state/<uuid>/workspace.yaml. v1.0.52+ resumes a session in
 * its saved cwd, so the migration rewrites the cwd / git_root lines.
 *
 * Generic fixture paths only - never personal or machine-specific ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateCopilotProjectData } from '../../src/main/agent/adapters/copilot/project-relocation';

let tmpBase: string;
let OLD_PATH: string;
let NEW_PATH: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-relocate-'));
  tmpHome = path.join(tmpBase, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  OLD_PATH = path.join(tmpBase, 'projects', 'old-app');
  NEW_PATH = path.join(tmpBase, 'projects', 'new-app');
  fs.mkdirSync(NEW_PATH, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const sessionStateRoot = (): string => path.join(tmpHome, '.copilot', 'session-state');

function writeWorkspace(uuid: string, content: string): string {
  const dir = path.join(sessionStateRoot(), uuid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'workspace.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

describe('migrateCopilotProjectData', () => {
  it('rewrites cwd and git_root while leaving other lines byte-identical', async () => {
    const content = [
      'id: session-a',
      `cwd: ${OLD_PATH}`,
      `git_root: ${OLD_PATH}`,
      'repository: Owner/repo',
      'branch: main',
      '',
    ].join('\n');
    const file = writeWorkspace('session-a', content);

    await migrateCopilotProjectData(OLD_PATH, NEW_PATH);

    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe(
      [
        'id: session-a',
        `cwd: ${NEW_PATH}`,
        `git_root: ${NEW_PATH}`,
        'repository: Owner/repo',
        'branch: main',
        '',
      ].join('\n'),
    );
  });

  it('rewrites a worktree cwd discovered under the old prefix', async () => {
    const worktreeCwd = path.join(OLD_PATH, '.kangentic', 'worktrees', 'feat-x');
    const newWorktreeCwd = path.join(NEW_PATH, '.kangentic', 'worktrees', 'feat-x');
    const file = writeWorkspace('session-wt', [`cwd: ${worktreeCwd}`, ''].join('\n'));

    await migrateCopilotProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(file, 'utf-8')).toBe([`cwd: ${newWorktreeCwd}`, ''].join('\n'));
  });

  it('leaves an unrelated session untouched', async () => {
    const other = path.join(tmpBase, 'projects', 'other');
    const content = [`cwd: ${other}`, ''].join('\n');
    const file = writeWorkspace('session-other', content);

    await migrateCopilotProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  it('preserves a quoted value style', async () => {
    const file = writeWorkspace('session-q', [`cwd: "${OLD_PATH}"`, ''].join('\n'));

    await migrateCopilotProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(file, 'utf-8')).toBe([`cwd: "${NEW_PATH}"`, ''].join('\n'));
  });

  it('does not touch the session-store.db cache and writes no backup', async () => {
    writeWorkspace('session-a', [`cwd: ${OLD_PATH}`, ''].join('\n'));
    const dbPath = path.join(tmpHome, '.copilot', 'session-store.db');
    fs.writeFileSync(dbPath, 'binary-db-bytes', 'utf-8');

    await migrateCopilotProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('binary-db-bytes');
    expect(fs.existsSync(`${path.join(sessionStateRoot(), 'session-a', 'workspace.yaml')}.kangentic-backup`)).toBe(false);
  });

  it('leaves a sibling cwd that merely shares a string prefix untouched', async () => {
    const sibling = `${OLD_PATH}2`;
    const content = [`cwd: ${sibling}`, ''].join('\n');
    const file = writeWorkspace('session-sib', content);

    await migrateCopilotProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  // Kangentic passes each session its own config home, which holds that
  // session's state in place of ~/.copilot (GitHub's config dir reference).
  it('rewrites the sessions in the moved project\'s own Kangentic config homes', async () => {
    const dir = path.join(NEW_PATH, '.kangentic', 'sessions', 'record-1', 'copilot-config', 'session-state', 'session-k');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'workspace.yaml');
    fs.writeFileSync(file, [`cwd: ${OLD_PATH}`, ''].join('\n'), 'utf-8');

    await migrateCopilotProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(file, 'utf-8')).toBe([`cwd: ${NEW_PATH}`, ''].join('\n'));
  });

  it('finds the project\'s config homes from a renamed worktree too', async () => {
    const oldWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', 'old-slug');
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', 'new-slug');
    const dir = path.join(NEW_PATH, '.kangentic', 'sessions', 'record-1', 'copilot-config', 'session-state', 'session-w');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'workspace.yaml');
    fs.writeFileSync(file, [`cwd: ${oldWorktree}`, ''].join('\n'), 'utf-8');

    await migrateCopilotProjectData(oldWorktree, newWorktree);

    expect(fs.readFileSync(file, 'utf-8')).toBe([`cwd: ${newWorktree}`, ''].join('\n'));
  });

  it('does not throw when the session-state directory is absent', async () => {
    await expect(migrateCopilotProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();
  });
});
