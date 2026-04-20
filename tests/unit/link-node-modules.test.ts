/**
 * Unit tests for `linkNodeModules` in src/main/git/node-modules-link.ts.
 *
 * Covers:
 *   - Silent skip when root node_modules doesn't exist (early return)
 *   - Symlink already pointing at root node_modules: no-op
 *   - Symlink pointing elsewhere: removed, then new junction/symlink created
 *   - Real directory in worktree: removeWithRetry called, then new link created
 *   - Junction/symlink creation failure: non-fatal warn, no throw
 *   - ENOENT on lstatSync (worktree node_modules does not exist): skip to create
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockLstatSync,
  mockReadlinkSync,
  mockRealpathSync,
  mockRmdirSync,
  mockRmSync,
  mockSymlinkSync,
  mockPromisesRm,
  mockRemoveWithRetry,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => true),
  mockLstatSync: vi.fn(),
  mockReadlinkSync: vi.fn(),
  mockRealpathSync: vi.fn((p: string) => p),
  mockRmdirSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockSymlinkSync: vi.fn(),
  mockPromisesRm: vi.fn(async () => {}),
  mockRemoveWithRetry: vi.fn(async (_target: string): Promise<void> => {}),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    lstatSync: mockLstatSync,
    readlinkSync: mockReadlinkSync,
    realpathSync: mockRealpathSync,
    rmdirSync: mockRmdirSync,
    rmSync: mockRmSync,
    symlinkSync: mockSymlinkSync,
    promises: {
      rm: mockPromisesRm,
    },
  },
}));

vi.mock('node:path', () => ({
  default: {
    join: (...segments: string[]) => segments.join('/'),
  },
}));

// removeWithRetry is used by the real-directory branch. Mock it as a
// pass-through so the retry loop doesn't run during these unit tests.
vi.mock('../../src/main/git/rm-with-retry', () => ({
  removeWithRetry: (target: string) => mockRemoveWithRetry(target),
}));

import { linkNodeModules } from '../../src/main/git/node-modules-link';

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

const WORKTREE_PATH = '/home/dev/project/.kangentic/worktrees/my-task-abcd1234';
const ROOT_PATH = '/home/dev/project';
const ROOT_MODULES = '/home/dev/project/node_modules';
const WORKTREE_MODULES = '/home/dev/project/.kangentic/worktrees/my-task-abcd1234/node_modules';

describe('linkNodeModules', () => {
  const originalPlatform = process.platform;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('linux');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Default: root node_modules exists, worktree node_modules does not.
    mockExistsSync.mockReturnValue(true);
    mockLstatSync.mockImplementation(() => {
      throw makeErrnoException('ENOENT', 'ENOENT: no such file or directory, lstat');
    });
    mockRealpathSync.mockImplementation((p: string) => p);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('silently skips when root node_modules does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await linkNodeModules(WORKTREE_PATH, ROOT_PATH);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockRemoveWithRetry).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('creates the junction/symlink when worktree node_modules does not exist yet (ENOENT)', async () => {
    // lstatSync throws ENOENT: worktree node_modules is absent.
    mockLstatSync.mockImplementation(() => {
      throw makeErrnoException('ENOENT', 'ENOENT: no such file or directory, lstat');
    });

    await linkNodeModules(WORKTREE_PATH, ROOT_PATH);

    expect(mockSymlinkSync).toHaveBeenCalledWith(ROOT_MODULES, WORKTREE_MODULES, 'dir');
    expect(mockRemoveWithRetry).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no-op when symlink already points to the correct root node_modules', async () => {
    // POSIX symlink that resolves to the same real path as root node_modules.
    mockLstatSync.mockReturnValue(makeStat({ isSymbolicLink: true }));
    mockRealpathSync.mockReturnValue(ROOT_MODULES); // both paths resolve identically

    await linkNodeModules(WORKTREE_PATH, ROOT_PATH);

    // Already correct - nothing to do.
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockRemoveWithRetry).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('replaces a symlink pointing elsewhere with a new one pointing to root', async () => {
    // POSIX symlink, but pointing to a different (stale) path.
    mockLstatSync.mockReturnValue(makeStat({ isSymbolicLink: true }));
    // realpathSync returns different values per call: first call is worktree
    // modules (stale target), second is root modules.
    mockRealpathSync
      .mockReturnValueOnce('/home/dev/other-project/node_modules') // stale symlink target
      .mockReturnValueOnce(ROOT_MODULES);                           // root real path

    await linkNodeModules(WORKTREE_PATH, ROOT_PATH);

    // Old link removed (removeNodeModulesPath handles POSIX symlink via rmSync).
    expect(mockRmSync).toHaveBeenCalledWith(WORKTREE_MODULES, { force: true });

    // New link created.
    expect(mockSymlinkSync).toHaveBeenCalledWith(ROOT_MODULES, WORKTREE_MODULES, 'dir');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('removes a real directory via removeWithRetry before creating the link', async () => {
    // Real directory (e.g. worktree ran `npm install`). Not a symlink or junction.
    mockLstatSync.mockReturnValue(makeStat({ isDirectory: true }));
    // On Linux, readlinkSync would throw for a real dir (no junction check).
    // The code path skips the isJunction check on non-win32.
    mockRemoveWithRetry.mockResolvedValue(undefined);

    await linkNodeModules(WORKTREE_PATH, ROOT_PATH);

    // removeWithRetry must be called for the real directory.
    expect(mockRemoveWithRetry).toHaveBeenCalledWith(WORKTREE_MODULES);

    // New link created after removal.
    expect(mockSymlinkSync).toHaveBeenCalledWith(ROOT_MODULES, WORKTREE_MODULES, 'dir');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning (non-fatal) when symlinkSync fails', async () => {
    // Nothing at worktree path yet (ENOENT on lstat).
    mockLstatSync.mockImplementation(() => {
      throw makeErrnoException('ENOENT', 'ENOENT: no such file or directory, lstat');
    });

    mockSymlinkSync.mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
    });

    // Must not throw - creation failure is documented as non-fatal.
    await expect(linkNodeModules(WORKTREE_PATH, ROOT_PATH)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WORKTREE] Failed to create node_modules link (non-fatal):'),
      expect.anything(),
    );
  });

  it('Windows: creates a junction (not dir symlink) for the link type', async () => {
    setPlatform('win32');
    // No existing worktree node_modules.
    mockLstatSync.mockImplementation(() => {
      throw makeErrnoException('ENOENT', 'ENOENT: no such file or directory, lstat');
    });

    await linkNodeModules(WORKTREE_PATH, ROOT_PATH);

    expect(mockSymlinkSync).toHaveBeenCalledWith(ROOT_MODULES, WORKTREE_MODULES, 'junction');
  });

  it('Windows: no-op when junction already points to the correct root node_modules', async () => {
    setPlatform('win32');
    // Windows junction: lstatSync reports isDirectory=true, readlinkSync succeeds.
    mockLstatSync.mockReturnValue(makeStat({ isDirectory: true }));
    mockReadlinkSync.mockReturnValue(ROOT_MODULES); // isJunction returns true
    // realpathSync resolves both to the same path.
    mockRealpathSync.mockReturnValue(ROOT_MODULES);

    await linkNodeModules(WORKTREE_PATH, ROOT_PATH);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockRemoveWithRetry).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
