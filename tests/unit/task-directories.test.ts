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

describe('isUsableReapRoot with a long-path prefix', () => {
  // A literal home, so the cases below are the same on every OS. `isUsableReapRoot`
  // only compares home as text, never reading it from the filesystem.
  const HOME = 'C:/Users/dev';

  it('refuses a share root or a drive root written with the prefix, in its forward-slash form', () => {
    // `//?/UNC/server/share` is `\\server\share`, the same share root a bare UNC path names.
    expect(isUsableReapRoot('//?/UNC/server/share', HOME)).toBe(false);
    expect(isUsableReapRoot('//?/UNC/server/share/', HOME)).toBe(false);
    expect(isUsableReapRoot('//?/unc/server/share', HOME)).toBe(false);
    expect(isUsableReapRoot('//?/C:/', HOME)).toBe(false);
    // Positive controls: something inside the share, and a project on the drive, is still a root.
    expect(isUsableReapRoot('//?/UNC/server/share/project', HOME)).toBe(true);
    expect(isUsableReapRoot('//?/C:/work/project', HOME)).toBe(true);
  });

  it('refuses a share root or a drive root behind the other device prefix, `\\\\.\\`, in its forward-slash form', () => {
    // `//./UNC/server/share` is the same share root; process-label.ts reads it as a share too.
    expect(isUsableReapRoot('//./UNC/server/share', HOME)).toBe(false);
    expect(isUsableReapRoot('//./unc/server/share/', HOME)).toBe(false);
    expect(isUsableReapRoot('//./C:/', HOME)).toBe(false);
    // Positive controls: something inside the share, and a project on the drive, is still a root.
    expect(isUsableReapRoot('//./UNC/server/share/project', HOME)).toBe(true);
    expect(isUsableReapRoot('//./C:/work/project', HOME)).toBe(true);
  });

  it('refuses the home directory written with the prefix', () => {
    expect(isUsableReapRoot('//?/C:/Users/dev', HOME)).toBe(false);
    expect(isUsableReapRoot('//?/C:/Users/dev/', HOME)).toBe(false);
    // Positive control: a project inside home, written the same way, is still a root.
    expect(isUsableReapRoot('//?/C:/Users/dev/project', HOME)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('refuses the same roots in their backslash form, and keeps a project under the prefix usable', () => {
    expect(isUsableReapRoot('\\\\?\\UNC\\server\\share', HOME)).toBe(false);
    expect(isUsableReapRoot('\\\\?\\C:\\', HOME)).toBe(false);
    expect(isUsableReapRoot('\\\\?\\C:\\Users\\dev', HOME)).toBe(false);
    expect(isUsableReapRoot('\\\\?\\UNC\\server\\share\\project', HOME)).toBe(true);
    expect(isUsableReapRoot('\\\\?\\C:\\work\\project', HOME)).toBe(true);
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

  it('refuses a home directory reached through a link, in either direction', async () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-home-'));
    temporaryRoots.push(realHome);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-home-link-'));
    temporaryRoots.push(linkParent);
    const linkedHome = path.join(linkParent, 'dev');
    // A junction needs no privilege on Windows; elsewhere a plain directory link.
    fs.symlinkSync(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
    // A project opened through the link while home is reported by its real path...
    expect(await resolveTaskDirectories(linkedHome, null, realHome)).toEqual([]);
    // ...and opened at the real path while home is reported through the link.
    expect(await resolveTaskDirectories(realHome, null, linkedHome)).toEqual([]);
    // A project inside that home is still a root.
    const project = path.join(realHome, 'project');
    fs.mkdirSync(project);
    expect(await resolveTaskDirectories(project, null, linkedHome)).toContain(project);
  });
});
