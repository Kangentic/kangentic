import { describe, it, expect } from 'vitest';
import { worktreeFolderFromPath, worktreeFolderUnderRoot } from '../../src/shared/worktree-folder';
import {
  worktreePathHeadroom,
  describeWorktreePathLengthCause,
  WINDOWS_MAX_PATH,
  ORDINARY_TOOLING_RESERVE,
} from '../../src/shared/windows-path-budget';

/**
 * A task's worktree directory name is chosen once and never changes. These are
 * the pure helpers that read and validate it, plus the MAX_PATH budget used to
 * explain a worktree failure that has already happened.
 */

describe('worktreeFolderFromPath', () => {
  it('reads the last segment of either separator style', () => {
    // A path written on Windows is read back on Linux in CI, where
    // path.basename does not split on a backslash.
    expect(worktreeFolderFromPath('C:\\project\\.kangentic\\worktrees\\460')).toBe('460');
    expect(worktreeFolderFromPath('/project/.kangentic/worktrees/460')).toBe('460');
  });

  it('ignores a trailing separator', () => {
    expect(worktreeFolderFromPath('/project/.kangentic/worktrees/460/')).toBe('460');
  });

  it('reads a legacy title-derived folder unchanged', () => {
    expect(worktreeFolderFromPath('/project/.kangentic/worktrees/dns-setup-4e41b16b'))
      .toBe('dns-setup-4e41b16b');
  });

  it('returns null for empty input', () => {
    expect(worktreeFolderFromPath(null)).toBeNull();
    expect(worktreeFolderFromPath(undefined)).toBeNull();
    expect(worktreeFolderFromPath('')).toBeNull();
  });
});

describe('worktreeFolderUnderRoot', () => {
  const worktreesRoot = '/project/.kangentic/worktrees';

  it('accepts a direct child', () => {
    expect(worktreeFolderUnderRoot(worktreesRoot, '/project/.kangentic/worktrees/460')).toBe('460');
    expect(worktreeFolderUnderRoot(worktreesRoot, '/project/.kangentic/worktrees/dns-setup-4e41b16b'))
      .toBe('dns-setup-4e41b16b');
  });

  it('rejects the root itself', () => {
    expect(worktreeFolderUnderRoot(worktreesRoot, worktreesRoot)).toBeNull();
  });

  it('rejects a grandchild', () => {
    expect(worktreeFolderUnderRoot(worktreesRoot, '/project/.kangentic/worktrees/460/src')).toBeNull();
  });

  it('rejects a path outside the root', () => {
    expect(worktreeFolderUnderRoot(worktreesRoot, '/project')).toBeNull();
    expect(worktreeFolderUnderRoot(worktreesRoot, '/elsewhere/.kangentic/worktrees/460')).toBeNull();
  });

  it('matches across separator styles', () => {
    expect(worktreeFolderUnderRoot('C:\\project\\.kangentic\\worktrees', 'C:/project/.kangentic/worktrees/460'))
      .toBe('460');
  });

  /**
   * The reason this helper takes a root at all. Kangentic can be opened AT a
   * worktree path (an opened worktree, or a /preview ephemeral project), so the
   * project root itself contains the `.kangentic/worktrees/` marker. A bare
   * marker search would hand a task that never had a worktree the ENCLOSING
   * worktree's folder name, permanently, because the column is write-once.
   */
  describe('when the project is itself a worktree', () => {
    const nestedProjectRoot = '/outer/.kangentic/worktrees/some-branch-a1b2c3d4';
    const nestedWorktreesRoot = `${nestedProjectRoot}/.kangentic/worktrees`;

    it('rejects a session cwd that is only the project root', () => {
      expect(worktreeFolderUnderRoot(nestedWorktreesRoot, nestedProjectRoot)).toBeNull();
    });

    it('still resolves a genuine nested worktree', () => {
      expect(worktreeFolderUnderRoot(nestedWorktreesRoot, `${nestedWorktreesRoot}/460`)).toBe('460');
    });
  });
});

describe('windows path budget', () => {
  it('leaves room for a relative path plus its separator', () => {
    const worktreePath = 'C:\\kw';
    expect(worktreePathHeadroom(worktreePath)).toBe(WINDOWS_MAX_PATH - worktreePath.length - 1);
  });

  it('explains a failure only when headroom is genuinely short', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // A normal project leaves ample room, so nothing is added to the error.
      expect(describeWorktreePathLengthCause('C:\\Users\\dev\\projects\\myapp\\.kangentic\\worktrees\\460'))
        .toBeNull();

      // Deep enough that an npm install would start failing.
      const deepPath = `C:\\${'x'.repeat(WINDOWS_MAX_PATH - ORDINARY_TOOLING_RESERVE)}`;
      const explanation = describeWorktreePathLengthCause(deepPath);
      expect(explanation).toContain('characters');
      expect(explanation).toContain(String(WINDOWS_MAX_PATH));
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('never explains anything off Windows, where MAX_PATH does not apply', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(describeWorktreePathLengthCause(`/${'x'.repeat(400)}`)).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
