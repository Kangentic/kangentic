/**
 * Unit tests for isSamePath (src/shared/paths.ts): platform-correct path
 * equality, used to compare a path git printed (forward slashes, e.g. `git
 * worktree list --porcelain`) against one Node wrote (backslashes on
 * Windows), and to fold Windows drive-letter/path case (the filesystem there
 * is case-insensitive).
 *
 * git-worktree-list.test.ts's "recognises the main checkout by resolved path"
 * case already exercises the `path.resolve()` normalization (a `.` segment
 * vs none) through POSIX-style fixtures. Nothing exercises the WINDOWS-ONLY
 * case-folding branch, which is otherwise coverage-blind on CI (Linux) and
 * only incidentally reached on a contributor's own Windows machine. These
 * tests cover that branch directly, and pin that case genuinely matters on
 * POSIX - a case-insensitive comparison there would be wrong, not merely
 * untested, since POSIX filesystems are case-sensitive.
 */
import { describe, it, expect } from 'vitest';
import { isSamePath } from '../../src/shared/paths';

describe('isSamePath', () => {
  it('is true for the identical path', () => {
    expect(isSamePath('/mock/repo', '/mock/repo')).toBe(true);
  });

  it('is true for paths that resolve to the same location via . and .. segments', () => {
    expect(isSamePath('/mock/repo', '/mock/repo/./')).toBe(true);
    expect(isSamePath('/mock/repo/child/../', '/mock/repo')).toBe(true);
  });

  it('is false for genuinely different paths', () => {
    expect(isSamePath('/mock/repo', '/mock/other-repo')).toBe(false);
    expect(isSamePath('/mock/repo', '/mock/repo/child')).toBe(false);
  });

  describe.runIf(process.platform === 'win32')('on Windows', () => {
    it('folds drive-letter and path case, since the filesystem is case-insensitive', () => {
      expect(isSamePath('C:\\Users\\dev\\Project', 'c:\\users\\dev\\project')).toBe(true);
    });

    it('is true across separator styles once both sides resolve to the same location', () => {
      expect(isSamePath('C:\\Users\\dev\\Project', 'C:/Users/dev/Project')).toBe(true);
    });
  });

  describe.runIf(process.platform !== 'win32')('on POSIX', () => {
    it('is case-sensitive, since the filesystem is', () => {
      expect(isSamePath('/mock/repo/Project', '/mock/repo/project')).toBe(false);
    });
  });
});
