/**
 * Unit tests for removeNodeModulesPath in src/main/git/node-modules-link.ts.
 *
 * Covers all four removal branches (Windows junction, POSIX symlink, real
 * directory, regular file) plus the missing-path (ENOENT) no-op and the
 * warning path for other errors. The junction check must come before the
 * isDirectory() branch; if it didn't, a recursive rm on a Windows junction
 * would traverse into the target and delete the main repo's node_modules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockLstat, mockReadlink, mockRmdir, mockRm, mockPromisesRm } = vi.hoisted(() => ({
  mockLstat: vi.fn(),
  mockReadlink: vi.fn(),
  mockRmdir: vi.fn(),
  mockRm: vi.fn(),
  // Real-directory Case 3 uses async fs.promises.rm so the event loop stays
  // responsive during bulk-delete batches over worktrees with real (not
  // junction) node_modules.
  mockPromisesRm: vi.fn(async () => {}),
}));

vi.mock('node:fs', () => ({
  default: {
    lstatSync: mockLstat,
    readlinkSync: mockReadlink,
    rmdirSync: mockRmdir,
    rmSync: mockRm,
    promises: {
      rm: mockPromisesRm,
    },
  },
}));

import { removeNodeModulesPath } from '../../src/main/git/node-modules-link';

function makeStat(overrides: {
  isSymbolicLink?: boolean;
  isDirectory?: boolean;
  isFile?: boolean;
}): { isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean } {
  return {
    isSymbolicLink: () => overrides.isSymbolicLink ?? false,
    isDirectory: () => overrides.isDirectory ?? false,
    isFile: () => overrides.isFile ?? false,
  };
}

function makeErrnoException(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('removeNodeModulesPath', () => {
  const originalPlatform = process.platform;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    warnSpy.mockRestore();
  });

  it('Windows junction: removes via rmdirSync without following the reparse point', () => {
    setPlatform('win32');
    mockLstat.mockReturnValue(makeStat({ isDirectory: true }));
    mockReadlink.mockReturnValue('C:\\Users\\dev\\project\\node_modules');

    removeNodeModulesPath('C:\\Users\\dev\\project\\.kangentic\\worktrees\\task-abc\\node_modules');

    expect(mockRmdir).toHaveBeenCalledWith(
      'C:\\Users\\dev\\project\\.kangentic\\worktrees\\task-abc\\node_modules',
    );
    expect(mockRm).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Windows real directory (npm install ran in worktree): removes recursively via fs.promises.rm', async () => {
    setPlatform('win32');
    // Real directory on Windows: lstatSync says isDirectory, but readlinkSync
    // throws EINVAL because there's no reparse point to read.
    mockLstat.mockReturnValue(makeStat({ isDirectory: true }));
    mockReadlink.mockImplementation(() => {
      throw makeErrnoException('EINVAL', 'EINVAL: invalid argument, readlink');
    });

    await removeNodeModulesPath('C:\\Users\\dev\\project\\.kangentic\\worktrees\\task-abc\\node_modules');

    // Real-directory Case 3 uses async fs.promises.rm (not sync rmSync) so
    // the event loop stays free during bulk cleanup on worktrees that have
    // a real populated node_modules rather than a junction.
    expect(mockPromisesRm).toHaveBeenCalledWith(
      'C:\\Users\\dev\\project\\.kangentic\\worktrees\\task-abc\\node_modules',
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockRmdir).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('POSIX symlink: removes via non-recursive rmSync (file-like)', () => {
    setPlatform('linux');
    mockLstat.mockReturnValue(makeStat({ isSymbolicLink: true }));

    removeNodeModulesPath('/home/dev/project/.kangentic/worktrees/task-abc/node_modules');

    expect(mockRm).toHaveBeenCalledWith(
      '/home/dev/project/.kangentic/worktrees/task-abc/node_modules',
      { force: true },
    );
    expect(mockRmdir).not.toHaveBeenCalled();
    // isJunction check is Windows-only, so readlinkSync must not be probed here.
    expect(mockReadlink).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('macOS symlink: treated the same as POSIX symlink', () => {
    setPlatform('darwin');
    mockLstat.mockReturnValue(makeStat({ isSymbolicLink: true }));

    removeNodeModulesPath('/Users/dev/project/.kangentic/worktrees/task-abc/node_modules');

    expect(mockRm).toHaveBeenCalledWith(
      '/Users/dev/project/.kangentic/worktrees/task-abc/node_modules',
      { force: true },
    );
    expect(mockRmdir).not.toHaveBeenCalled();
    expect(mockReadlink).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('POSIX real directory (npm install ran in worktree): removes recursively via fs.promises.rm', async () => {
    setPlatform('linux');
    mockLstat.mockReturnValue(makeStat({ isDirectory: true }));

    await removeNodeModulesPath('/home/dev/project/.kangentic/worktrees/task-abc/node_modules');

    expect(mockPromisesRm).toHaveBeenCalledWith(
      '/home/dev/project/.kangentic/worktrees/task-abc/node_modules',
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockRmdir).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Missing path (ENOENT): no-op, no warning', () => {
    setPlatform('linux');
    mockLstat.mockImplementation(() => {
      throw makeErrnoException('ENOENT', 'ENOENT: no such file or directory, lstat');
    });

    removeNodeModulesPath('/missing/node_modules');

    expect(mockRm).not.toHaveBeenCalled();
    expect(mockRmdir).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Regular file (defensive branch): removes via non-recursive rmSync', () => {
    setPlatform('linux');
    mockLstat.mockReturnValue(makeStat({ isFile: true }));

    removeNodeModulesPath('/some/path/node_modules');

    expect(mockRm).toHaveBeenCalledWith('/some/path/node_modules', { force: true });
    expect(mockRmdir).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Non-ENOENT rm errors are logged as warnings', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    mockLstat.mockReturnValue(makeStat({ isDirectory: true }));
    // Real-directory case now goes through `removeWithRetry`, which retries
    // `fs.promises.rm` on every failure across a [0, 100, 500, 2000] ms
    // schedule. `mockRejectedValue` (persistent) makes every attempt fail
    // so the outer catch in `removeNodeModulesPath` logs its warning once
    // the retries are exhausted.
    mockPromisesRm.mockRejectedValue(
      makeErrnoException('EPERM', 'EPERM: operation not permitted, rm'),
    );

    const resultPromise = removeNodeModulesPath('/protected/node_modules');
    // Drive the full 0 + 100 + 500 + 2000 = 2600 ms retry window.
    await vi.advanceTimersByTimeAsync(2600);
    await resultPromise;

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WORKTREE] Failed to remove /protected/node_modules'),
    );
    vi.useRealTimers();
  });

  it('Regression guard: Windows junction must NOT hit the recursive-rm branch', () => {
    // If isDirectory() were checked before isJunction, a recursive rm on a
    // Windows junction would traverse into the target and delete the main
    // repo's node_modules. This test locks in the ordering.
    setPlatform('win32');
    mockLstat.mockReturnValue(makeStat({ isDirectory: true, isSymbolicLink: true }));
    mockReadlink.mockReturnValue('C:\\Users\\dev\\project\\node_modules');

    removeNodeModulesPath('C:\\Users\\dev\\project\\.kangentic\\worktrees\\task-abc\\node_modules');

    expect(mockRmdir).toHaveBeenCalledTimes(1);
    expect(mockRm).not.toHaveBeenCalled();
  });
});
