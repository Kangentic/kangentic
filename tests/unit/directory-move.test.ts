/**
 * Unit tests for the directory move engine
 * (src/main/fs/directory-move.ts).
 *
 * `original-fs` is mocked so the engine's branching can be exercised without
 * touching the real filesystem:
 *
 *   - same-volume rename succeeds on the first try (no copy, no delete);
 *   - a transient Windows handle hold (EBUSY) is retried with backoff;
 *   - exhausting the retries rethrows the last error;
 *   - a cross-volume rename (EXDEV) falls back to a recursive copy that
 *     reports monotonic progress and leaves the source in place;
 *   - a copy failure rolls back the partial destination and rethrows;
 *   - removeDirectoryTree is Windows-aware (force + recursive + retries).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  rename: vi.fn(async () => {}),
  cp: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  readdir: vi.fn(async () => [] as Array<{ name: string; isDirectory: () => boolean }>),
}));

vi.mock('../../src/main/git/original-fs', () => ({
  default: { promises: fsMock },
}));

import { moveDirectory, removeDirectoryTree } from '../../src/main/fs/directory-move';

const SOURCE = '/projects/old-app';
const DEST = '/elsewhere/old-app';

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  fsMock.rename.mockResolvedValue(undefined);
  fsMock.cp.mockResolvedValue(undefined);
  fsMock.rm.mockResolvedValue(undefined);
  fsMock.readdir.mockResolvedValue([]);
});

describe('moveDirectory', () => {
  it('renames atomically on the same volume and never copies or deletes', async () => {
    const result = await moveDirectory(SOURCE, DEST);
    expect(result).toEqual({ strategy: 'rename' });
    expect(fsMock.rename).toHaveBeenCalledWith(SOURCE, DEST);
    expect(fsMock.cp).not.toHaveBeenCalled();
    expect(fsMock.rm).not.toHaveBeenCalled();
  });

  it('retries a transient EBUSY then succeeds', async () => {
    vi.useFakeTimers();
    fsMock.rename
      .mockRejectedValueOnce(errnoError('EBUSY'))
      .mockRejectedValueOnce(errnoError('EBUSY'))
      .mockResolvedValueOnce(undefined);

    const promise = moveDirectory(SOURCE, DEST);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ strategy: 'rename' });
    expect(fsMock.rename).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error after exhausting retries', async () => {
    vi.useFakeTimers();
    fsMock.rename.mockRejectedValue(errnoError('EPERM'));

    const promise = moveDirectory(SOURCE, DEST);
    const expectation = expect(promise).rejects.toThrow('EPERM');
    await vi.runAllTimersAsync();
    await expectation;
    expect(fsMock.rename).toHaveBeenCalledTimes(5);
  });

  it('rethrows a non-retryable error immediately', async () => {
    fsMock.rename.mockRejectedValueOnce(errnoError('ENOENT'));
    await expect(moveDirectory(SOURCE, DEST)).rejects.toThrow('ENOENT');
    expect(fsMock.rename).toHaveBeenCalledTimes(1);
    expect(fsMock.cp).not.toHaveBeenCalled();
  });

  it('falls back to a recursive copy on EXDEV and leaves the source in place', async () => {
    fsMock.rename.mockRejectedValueOnce(errnoError('EXDEV'));
    // Two files at the root: the engine counts 2 entries and copies them.
    fsMock.readdir.mockResolvedValueOnce([
      { name: 'a.txt', isDirectory: () => false },
      { name: 'b.txt', isDirectory: () => false },
    ]);
    const progress: Array<{ copiedEntries: number; totalEntries: number }> = [];
    fsMock.cp.mockImplementationOnce(async (_source, _dest, options: { filter: (p: string) => boolean }) => {
      // The root (SOURCE) is filtered without counting; each child counts.
      options.filter(SOURCE);
      options.filter(`${SOURCE}/a.txt`);
      options.filter(`${SOURCE}/b.txt`);
    });

    const result = await moveDirectory(SOURCE, DEST, {
      onCopyProgress: (p) => progress.push(p),
    });

    expect(result).toEqual({ strategy: 'copy', totalEntries: 2 });
    expect(fsMock.cp).toHaveBeenCalledWith(
      SOURCE,
      DEST,
      expect.objectContaining({ recursive: true, force: false, errorOnExist: true, dereference: false }),
    );
    // Engine does NOT delete the source; the caller owns that.
    expect(fsMock.rm).not.toHaveBeenCalled();
    // Progress is monotonic and ends exactly at the total.
    expect(progress.length).toBeGreaterThan(0);
    const copiedValues = progress.map((p) => p.copiedEntries);
    for (let i = 1; i < copiedValues.length; i += 1) {
      expect(copiedValues[i]).toBeGreaterThanOrEqual(copiedValues[i - 1]);
    }
    expect(progress[progress.length - 1]).toEqual({ copiedEntries: 2, totalEntries: 2 });
  });

  it('rolls back the partial destination and rethrows when the copy fails', async () => {
    fsMock.rename.mockRejectedValueOnce(errnoError('EXDEV'));
    fsMock.readdir.mockResolvedValueOnce([{ name: 'a.txt', isDirectory: () => false }]);
    fsMock.cp.mockRejectedValueOnce(new Error('disk full'));

    await expect(moveDirectory(SOURCE, DEST)).rejects.toThrow('disk full');
    expect(fsMock.rm).toHaveBeenCalledWith(
      DEST,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('retries a transient EACCES then succeeds', async () => {
    // EACCES is in TRANSIENT_HANDLE_CODES alongside EBUSY/EPERM/ENOTEMPTY.
    // Windows antivirus scanners can hold a handle that causes EACCES transiently.
    vi.useFakeTimers();
    fsMock.rename
      .mockRejectedValueOnce(errnoError('EACCES'))
      .mockRejectedValueOnce(errnoError('EACCES'))
      .mockResolvedValueOnce(undefined);

    const promise = moveDirectory(SOURCE, DEST);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ strategy: 'rename' });
    expect(fsMock.rename).toHaveBeenCalledTimes(3);
    expect(fsMock.cp).not.toHaveBeenCalled();
  });

  it('retries a transient ENOTEMPTY then succeeds', async () => {
    // ENOTEMPTY can occur on Windows when a directory is not yet vacated.
    vi.useFakeTimers();
    fsMock.rename
      .mockRejectedValueOnce(errnoError('ENOTEMPTY'))
      .mockResolvedValueOnce(undefined);

    const promise = moveDirectory(SOURCE, DEST);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ strategy: 'rename' });
    expect(fsMock.rename).toHaveBeenCalledTimes(2);
    expect(fsMock.cp).not.toHaveBeenCalled();
  });

  it('emits initial progress (0, N) before any per-entry increments during a copy', async () => {
    // The copy fallback must emit onCopyProgress({ copiedEntries: 0, totalEntries: N })
    // as its very first call (before the cp filter starts incrementing copiedEntries).
    // This lets the UI show 0 % immediately rather than jumping straight to some
    // partial count when the first filter callbacks arrive.
    fsMock.rename.mockRejectedValueOnce(errnoError('EXDEV'));
    fsMock.readdir.mockResolvedValueOnce([
      { name: 'a.txt', isDirectory: () => false },
      { name: 'b.txt', isDirectory: () => false },
      { name: 'c.txt', isDirectory: () => false },
    ]);
    const emitted: Array<{ copiedEntries: number; totalEntries: number }> = [];
    fsMock.cp.mockImplementationOnce(
      async (_source: string, _dest: string, options: { filter: (p: string) => boolean }) => {
        // Simulate the cp filter being called for each child (root is skipped).
        options.filter(`${SOURCE}/a.txt`);
        options.filter(`${SOURCE}/b.txt`);
        options.filter(`${SOURCE}/c.txt`);
      },
    );

    await moveDirectory(SOURCE, DEST, {
      onCopyProgress: (progress) => emitted.push({ ...progress }),
    });

    // First emission must be (0, 3) - the forced initial emit before any copy.
    expect(emitted[0]).toEqual({ copiedEntries: 0, totalEntries: 3 });
  });

  it('rethrows the original copy error when the rollback rm also rejects', async () => {
    // The rollback `rm` failure is swallowed via `.catch(() => undefined)`; the
    // caller must receive the original copy error, not the rm error.
    fsMock.rename.mockRejectedValueOnce(errnoError('EXDEV'));
    fsMock.readdir.mockResolvedValueOnce([{ name: 'a.txt', isDirectory: () => false }]);
    fsMock.cp.mockRejectedValueOnce(new Error('copy boom'));
    fsMock.rm.mockRejectedValueOnce(new Error('rm boom'));

    await expect(moveDirectory(SOURCE, DEST)).rejects.toThrow('copy boom');
  });
});

describe('removeDirectoryTree', () => {
  it('removes recursively and force with retries (Windows-aware)', async () => {
    await removeDirectoryTree(SOURCE);
    expect(fsMock.rm).toHaveBeenCalledWith(
      SOURCE,
      expect.objectContaining({ recursive: true, force: true, maxRetries: expect.any(Number) }),
    );
  });
});
