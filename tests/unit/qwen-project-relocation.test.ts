/**
 * Unit tests for migrateQwenProjectData()
 * (src/main/agent/adapters/qwen-code/project-relocation.ts).
 *
 * Qwen keys per-project chats (~/.qwen/projects/<slug>/), shell history
 * (~/.qwen/tmp/<sha256>/), and trust (~/.qwen/trustedFolders.json) to the
 * absolute project path. Relocation must migrate all three.
 *
 * Generic fixture paths only - never personal or machine-specific ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateQwenProjectData } from '../../src/main/agent/adapters/qwen-code/project-relocation';
import { qwenProjectSlug } from '../../src/main/agent/adapters/qwen-code/session-history-parser';
import { resolveForwardSlash } from '../../src/shared/paths';

let tmpBase: string;
let OLD_PATH: string;
let NEW_PATH: string;

beforeEach(() => {
  // A developer's own shell may export either; the cases below assume ~/.qwen.
  delete process.env.QWEN_HOME;
  delete process.env.QWEN_RUNTIME_DIR;
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-relocate-'));
  tmpHome = path.join(tmpBase, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  OLD_PATH = path.join(tmpBase, 'projects', 'old-app');
  NEW_PATH = path.join(tmpBase, 'projects', 'new-app');
  fs.mkdirSync(NEW_PATH, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function projectsDir(projectPath: string): string {
  return path.join(tmpHome, '.qwen', 'projects', qwenProjectSlug(path.resolve(projectPath)));
}

function qwenTmpHash(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function tmpDir(projectPath: string): string {
  return path.join(tmpHome, '.qwen', 'tmp', qwenTmpHash(projectPath));
}

function trustedFoldersPath(): string {
  return path.join(tmpHome, '.qwen', 'trustedFolders.json');
}

function writeDir(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
}

function writeTrustedFolders(entries: Record<string, string>): void {
  fs.mkdirSync(path.join(tmpHome, '.qwen'), { recursive: true });
  fs.writeFileSync(trustedFoldersPath(), JSON.stringify(entries, null, 2), 'utf-8');
}

describe('migrateQwenProjectData - directories', () => {
  it('renames the project chats directory and preserves its files', async () => {
    writeDir(projectsDir(OLD_PATH), { 'chats.jsonl': 'history' });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(projectsDir(OLD_PATH))).toBe(false);
    expect(fs.readFileSync(path.join(projectsDir(NEW_PATH), 'chats.jsonl'), 'utf-8')).toBe('history');
  });

  it('renames the tmp hash directory', async () => {
    writeDir(tmpDir(OLD_PATH), { 'shell_history': 'cmd' });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(tmpDir(OLD_PATH))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir(NEW_PATH), 'shell_history'), 'utf-8')).toBe('cmd');
  });

  it('migrates a worktree project dir discovered from the relocated folder', async () => {
    const worktreeName = 'feat-x';
    fs.mkdirSync(path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName), { recursive: true });
    const oldWorktree = path.join(OLD_PATH, '.kangentic', 'worktrees', worktreeName);
    const newWorktree = path.join(NEW_PATH, '.kangentic', 'worktrees', worktreeName);
    writeDir(projectsDir(oldWorktree), { 'wt.jsonl': 'wt' });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(projectsDir(oldWorktree))).toBe(false);
    expect(fs.readFileSync(path.join(projectsDir(newWorktree), 'wt.jsonl'), 'utf-8')).toBe('wt');
  });

  it('merges into an existing target project dir, keeping target entries', async () => {
    writeDir(projectsDir(OLD_PATH), { 'a.jsonl': 'from-old' });
    writeDir(projectsDir(NEW_PATH), { 'b.jsonl': 'from-new' });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.readFileSync(path.join(projectsDir(NEW_PATH), 'a.jsonl'), 'utf-8')).toBe('from-old');
    expect(fs.readFileSync(path.join(projectsDir(NEW_PATH), 'b.jsonl'), 'utf-8')).toBe('from-new');
  });

  it('does not throw and creates no target when the source dir is missing', async () => {
    await expect(migrateQwenProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();
    expect(fs.existsSync(projectsDir(NEW_PATH))).toBe(false);
  });
});

describe('migrateQwenProjectData - QWEN_RUNTIME_DIR', () => {
  let savedRuntimeDir: string | undefined;
  let savedQwenHome: string | undefined;

  beforeEach(() => {
    savedRuntimeDir = process.env.QWEN_RUNTIME_DIR;
    savedQwenHome = process.env.QWEN_HOME;
    delete process.env.QWEN_HOME;
  });

  afterEach(() => {
    if (savedRuntimeDir === undefined) delete process.env.QWEN_RUNTIME_DIR;
    else process.env.QWEN_RUNTIME_DIR = savedRuntimeDir;
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
  });

  it('moves projects/<old slug> to projects/<new slug> under the runtime dir, not QWEN_HOME', async () => {
    const runtimeDir = path.join(tmpBase, 'runtime');
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    const runtimeProject = (projectPath: string): string =>
      path.join(runtimeDir, 'projects', qwenProjectSlug(path.resolve(projectPath)));
    writeDir(runtimeProject(OLD_PATH), { 'chats.jsonl': 'runtime-history' });
    // Chats of the same project under the home directory must stay where they are.
    writeDir(projectsDir(OLD_PATH), { 'home.jsonl': 'home-history' });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(runtimeProject(OLD_PATH))).toBe(false);
    expect(fs.readFileSync(path.join(runtimeProject(NEW_PATH), 'chats.jsonl'), 'utf-8')).toBe('runtime-history');
    expect(fs.existsSync(projectsDir(NEW_PATH))).toBe(false);
    expect(fs.readFileSync(path.join(projectsDir(OLD_PATH), 'home.jsonl'), 'utf-8')).toBe('home-history');
  });

  it('moves the tmp hash directory under the runtime dir as well', async () => {
    const runtimeDir = path.join(tmpBase, 'runtime');
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    const runtimeTmp = (projectPath: string): string => path.join(runtimeDir, 'tmp', qwenTmpHash(projectPath));
    writeDir(runtimeTmp(OLD_PATH), { shell_history: 'cmd' });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(runtimeTmp(OLD_PATH))).toBe(false);
    expect(fs.readFileSync(path.join(runtimeTmp(NEW_PATH), 'shell_history'), 'utf-8')).toBe('cmd');
  });
});

describe('migrateQwenProjectData - trustedFolders.json', () => {
  it('rewrites a matching key to the new forward-slash path and backs up the file', async () => {
    writeTrustedFolders({ [resolveForwardSlash(OLD_PATH)]: 'TRUST_FOLDER' });
    const before = fs.readFileSync(trustedFoldersPath(), 'utf-8');

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    const entries = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as Record<string, string>;
    expect(entries[resolveForwardSlash(OLD_PATH)]).toBeUndefined();
    expect(entries[resolveForwardSlash(NEW_PATH)]).toBe('TRUST_FOLDER');
    expect(fs.readFileSync(`${trustedFoldersPath()}.kangentic-backup`, 'utf-8')).toBe(before);
  });

  it('keeps the destination value and drops the old key when the destination already exists', async () => {
    writeTrustedFolders({
      [resolveForwardSlash(OLD_PATH)]: 'TRUST_FOLDER',
      [resolveForwardSlash(NEW_PATH)]: 'DO_NOT_TRUST',
    });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    const entries = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as Record<string, string>;
    expect(entries[resolveForwardSlash(OLD_PATH)]).toBeUndefined();
    expect(entries[resolveForwardSlash(NEW_PATH)]).toBe('DO_NOT_TRUST');
  });

  it('leaves an unparsable trustedFolders.json byte-identical', async () => {
    const garbage = '{ not json ';
    fs.mkdirSync(path.join(tmpHome, '.qwen'), { recursive: true });
    fs.writeFileSync(trustedFoldersPath(), garbage, 'utf-8');

    await expect(migrateQwenProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    expect(fs.readFileSync(trustedFoldersPath(), 'utf-8')).toBe(garbage);
  });

  it('writes no backup when no key matches', async () => {
    const otherKey = resolveForwardSlash(path.join(tmpBase, 'projects', 'other'));
    writeTrustedFolders({ [otherKey]: 'TRUST_FOLDER' });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(`${trustedFoldersPath()}.kangentic-backup`)).toBe(false);
  });

  it('does not migrate when trustedFolders.json is absent', async () => {
    await expect(migrateQwenProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();
    expect(fs.existsSync(`${trustedFoldersPath()}.kangentic-backup`)).toBe(false);
  });

  // Gap 5a: rewriteTrustedFolders has an early-return guard when the parsed JSON
  // is an array (Array.isArray check). A trustedFolders.json that parses to []
  // must be left byte-identical and generate no backup, distinct from the
  // unparsable-JSON case and the missing-file case already covered above.
  it('leaves trustedFolders.json untouched when it parses to an array', async () => {
    const arrayContent = '[]';
    fs.mkdirSync(path.join(tmpHome, '.qwen'), { recursive: true });
    fs.writeFileSync(trustedFoldersPath(), arrayContent, 'utf-8');

    await expect(migrateQwenProjectData(OLD_PATH, NEW_PATH)).resolves.toBeUndefined();

    expect(fs.readFileSync(trustedFoldersPath(), 'utf-8')).toBe(arrayContent);
    expect(fs.existsSync(`${trustedFoldersPath()}.kangentic-backup`)).toBe(false);
  });

  it('leaves a sibling key that merely shares a string prefix untouched', async () => {
    const sibling = `${OLD_PATH}2`;
    writeDir(projectsDir(sibling), { 's.jsonl': 'sibling' });
    writeTrustedFolders({
      [resolveForwardSlash(OLD_PATH)]: 'TRUST_FOLDER',
      [resolveForwardSlash(sibling)]: 'TRUST_FOLDER',
    });

    await migrateQwenProjectData(OLD_PATH, NEW_PATH);

    expect(fs.existsSync(projectsDir(sibling))).toBe(true);
    const entries = JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8')) as Record<string, string>;
    expect(entries[resolveForwardSlash(sibling)]).toBe('TRUST_FOLDER');
  });
});
