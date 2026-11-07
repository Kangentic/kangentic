/**
 * `link-check.ts` decides whether a path may be a link before a copy enters it
 * or a removal recurses into it. A user loses the main checkout's folders when
 * it answers "not a link" for a junction, so the direction it errs in is the
 * contract: anything it cannot examine reads as a link. The files that use it
 * test their own flows; these pin its answers on real paths, and on the errors
 * a real path cannot be made to give.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasLinkOnPath, isLinkEntry, mayBeLink } from '../../src/main/git/link-check';

let workspace: string;
let realFolder: string;
let linkPath: string;
let realFile: string;

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
}

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-link-check-')));
  realFolder = path.join(workspace, 'real');
  linkPath = path.join(workspace, 'linked');
  realFile = path.join(workspace, 'file.txt');
  fs.mkdirSync(realFolder);
  fs.writeFileSync(realFile, 'file');
  // A junction on Windows, which needs no privilege.
  fs.symlinkSync(realFolder, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', platformDescriptor);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('isLinkEntry', () => {
  it('is true for a link, and false for a real folder and a file', async () => {
    expect(await isLinkEntry(linkPath, fs.lstatSync(linkPath))).toBe(true);
    expect(await isLinkEntry(realFolder, fs.lstatSync(realFolder))).toBe(false);
    expect(await isLinkEntry(realFile, fs.lstatSync(realFile))).toBe(false);
  });

  it('never probes readlink off Windows, where lstat already tells a link from a folder', async () => {
    setPlatform('linux');
    const readlink = vi.spyOn(fs.promises, 'readlink');

    expect(await isLinkEntry(realFolder, fs.lstatSync(realFolder))).toBe(false);

    expect(readlink).not.toHaveBeenCalled();
  });

  describe('on Windows, where lstat can call a junction a directory', () => {
    beforeEach(() => setPlatform('win32'));

    it('reads a folder as a folder when readlink says EINVAL, which is what a real folder answers', async () => {
      // A real folder, so the EINVAL is the platform's own and not a stand-in.
      expect(await isLinkEntry(realFolder, fs.lstatSync(realFolder))).toBe(false);
    });

    it('reads a folder as a link when readlink succeeds', async () => {
      vi.spyOn(fs.promises, 'readlink').mockResolvedValue(workspace);
      expect(await isLinkEntry(realFolder, fs.lstatSync(realFolder))).toBe(true);
    });

    it('throws on any other readlink error, because entering what cannot be told apart reaches the link target', async () => {
      vi.spyOn(fs.promises, 'readlink').mockRejectedValue(errorWithCode('EACCES'));
      await expect(isLinkEntry(realFolder, fs.lstatSync(realFolder))).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('does not probe a file', async () => {
      const readlink = vi.spyOn(fs.promises, 'readlink');
      expect(await isLinkEntry(realFile, fs.lstatSync(realFile))).toBe(false);
      expect(readlink).not.toHaveBeenCalled();
    });
  });
});

describe('mayBeLink', () => {
  it('is false for a path that is gone and for a real folder, true for a link', async () => {
    expect(await mayBeLink(path.join(workspace, 'missing'))).toBe(false);
    expect(await mayBeLink(realFolder)).toBe(false);
    expect(await mayBeLink(linkPath)).toBe(true);
  });

  it('is true for a path it cannot examine, and never throws', async () => {
    vi.spyOn(fs.promises, 'lstat').mockRejectedValue(errorWithCode('EACCES'));
    expect(await mayBeLink(realFolder)).toBe(true);
  });

  it('is true when Windows cannot say whether a folder is a link', async () => {
    setPlatform('win32');
    vi.spyOn(fs.promises, 'readlink').mockRejectedValue(errorWithCode('EPERM'));
    expect(await mayBeLink(realFolder)).toBe(true);
  });
});

describe('hasLinkOnPath', () => {
  it('finds a link at any segment, the last included', async () => {
    fs.mkdirSync(path.join(realFolder, 'inner'));
    expect(await hasLinkOnPath(workspace, 'linked')).toBe(true);
    expect(await hasLinkOnPath(workspace, 'linked/inner')).toBe(true);
    expect(await hasLinkOnPath(workspace, 'linked/inner/not-there-yet')).toBe(true);
  });

  it('is false for real folders, for a path that is gone, and for the root itself', async () => {
    fs.mkdirSync(path.join(realFolder, 'inner'));
    expect(await hasLinkOnPath(workspace, 'real/inner')).toBe(false);
    expect(await hasLinkOnPath(workspace, 'real/missing/deeper')).toBe(false);
    expect(await hasLinkOnPath(workspace, '')).toBe(false);
    expect(await hasLinkOnPath(workspace, '.')).toBe(false);
  });

  it('reads a segment it cannot examine as a link', async () => {
    vi.spyOn(fs.promises, 'lstat').mockRejectedValue(errorWithCode('EACCES'));
    expect(await hasLinkOnPath(workspace, 'real/inner')).toBe(true);
  });
});
