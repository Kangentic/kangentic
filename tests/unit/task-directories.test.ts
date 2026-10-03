/**
 * The directories a task's processes may be reaped in
 * (src/main/pty/process-tag/task-directories.ts): never a root that would
 * admit unrelated processes, and the real path alongside the stored one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUsableReapRoot, resolveTaskDirectories } from '../../src/main/pty/process-tag/task-directories';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('isUsableReapRoot', () => {
  it('refuses a filesystem root, a drive root, a bare UNC share, a relative path, and the home directory', () => {
    const home = path.join(path.parse(os.tmpdir()).root, 'Users', 'dev');
    expect(isUsableReapRoot(path.parse(os.tmpdir()).root, home)).toBe(false);
    expect(isUsableReapRoot('relative/project', home)).toBe(false);
    expect(isUsableReapRoot(home, home)).toBe(false);
    expect(isUsableReapRoot(`${home}${path.sep}`, home)).toBe(false);
    expect(isUsableReapRoot(path.join(home, 'project'), home)).toBe(true);
    if (process.platform === 'win32') {
      expect(isUsableReapRoot('D:\\', home)).toBe(false);
      expect(isUsableReapRoot('\\\\server\\share', home)).toBe(false);
      expect(isUsableReapRoot('\\\\server\\share\\project', home)).toBe(true);
    }
  });
});

describe('resolveTaskDirectories', () => {
  it('keeps the stored and the real form of the project and worktree, and drops what is missing', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-dirs-'));
    temporaryRoots.push(project);
    const worktree = path.join(project, '.kangentic', 'worktrees', 'task-1');
    fs.mkdirSync(worktree, { recursive: true });
    const directories = await resolveTaskDirectories(project, worktree);
    expect(directories).toContain(project);
    expect(directories).toContain(worktree);
    expect(directories).toContain(await fs.promises.realpath(project));
    expect(await resolveTaskDirectories(null, null)).toEqual([]);
    // A worktree already deleted still contributes its stored path.
    expect(await resolveTaskDirectories(null, path.join(project, 'gone'))).toEqual([path.join(project, 'gone')]);
  });
});
