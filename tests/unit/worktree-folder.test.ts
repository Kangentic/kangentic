import { describe, it, expect } from 'vitest';
import { worktreeFolderFromPath, worktreeFolderUnderRoot } from '../../src/shared/worktree-folder';
import {
  describeWorktreePathLengthCause,
  isPathLengthError,
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
   * `comparablePath` case-folds on win32 only, and this is the only test that
   * exercises that branch with an actual case difference. It works on any CI OS
   * because these helpers are pure string manipulation that never touch
   * `node:path` - unlike `isSameDirectory`, whose win32 semantics come from the
   * path module bound at process start and so cannot be spoofed this way.
   */
  it('folds case on Windows, where the filesystem does, and nowhere else', () => {
    const originalPlatform = process.platform;
    const mixedCaseRoot = 'C:\\Project\\.kangentic\\worktrees';
    const differentlyCasedChild = 'c:\\project\\.KANGENTIC\\Worktrees\\460';

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // The ORIGINAL-case segment comes back, not the folded one.
      expect(worktreeFolderUnderRoot(mixedCaseRoot, differentlyCasedChild)).toBe('460');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      // Off Windows these are two different directories, and claiming the folder
      // would write a permanently wrong value into a write-once column.
      expect(worktreeFolderUnderRoot(mixedCaseRoot, differentlyCasedChild)).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
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

/**
 * Path length is recognized from ERROR EVIDENCE, never predicted from a length
 * threshold. Measurement is why: inside a 98-character worktree of a React
 * Native project, 1,958 files exceeded MAX_PATH and `npm install`, `expo
 * prebuild` and Gradle all succeeded. A length-triggered warning would have
 * fired on that healthy tree, and could not observe the one thing that did fail.
 */
describe('windows path-length diagnosis', () => {
  const DEEP_PATH = `C:\\${'x'.repeat(200)}`;

  function onWindows<T>(body: () => T): T {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      return body();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  }

  it('says nothing about a deep path when the error is unrelated', () => {
    onWindows(() => {
      const unrelated = new Error('fatal: could not lock config file .git/config: File exists');
      expect(describeWorktreePathLengthCause(DEEP_PATH, unrelated)).toBeNull();
    });
  });

  it('recognizes the signatures a tool emits when it runs out of path', () => {
    onWindows(() => {
      for (const message of [
        'ENAMETOOLONG: name too long, open ...',
        'error: unable to create file: Filename too long',
        'The filename or extension is too long.',
        // Both captured verbatim from a failing React Native Android build.
        'ninja: error: Stat(EnrichedMarkdownTextSpec_autolinked_build/CMakeFiles/'
        + 'react_codegen_EnrichedMarkdownTextSpec.dir/C_/Users/dev/proj/node_modules/'
        + 'react-native-enriched-markdown/android/generated/jni/react/renderer/components/'
        + 'EnrichedMarkdownTextSpec/ComponentDescriptors.cpp.o): Filename longer than 260 characters',
        "ninja: error: manifest 'build.ninja' still dirty after 100 tries",
      ]) {
        expect(describeWorktreePathLengthCause(DEEP_PATH, new Error(message))).toContain('ran out of path');
      }
    });
  });

  /**
   * CMake's object-path policy warning is NOT a path-length failure signal.
   *
   * Measured 2026-07-30 on a React Native Android build: this text appeared 402
   * times in a build whose real failure was ninja's manifest loop, and 0 times
   * in a build that still failed after CMAKE_OBJECT_PATH_MAX was raised to 1000.
   * The build routinely survives it, so matching it attributes an unrelated
   * failure to path length.
   */
  it('stays silent on the CMake object-path warning, which builds survive', () => {
    onWindows(() => {
      for (const message of [
        'has 195 characters. The maximum full path to an object file is 250 characters (CMAKE_OBJECT_PATH_MAX)',
        'Object file RNScreens.cpp.o cannot be safely placed under this directory',
      ]) {
        expect(describeWorktreePathLengthCause(DEEP_PATH, new Error(message))).toBeNull();
      }
    });
  });

  it('matches through a wrapped cause, so an enriched error still resolves', () => {
    onWindows(() => {
      const wrapped = new Error('Worktree setup failed', { cause: new Error('ENAMETOOLONG') });
      expect(describeWorktreePathLengthCause(DEEP_PATH, wrapped)).not.toBeNull();
    });
  });

  it('is a no-op off Windows, where PATH_MAX is 1024 or more', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      expect(describeWorktreePathLengthCause(`/${'x'.repeat(400)}`, new Error('ENAMETOOLONG')))
        .toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('exposes the raw predicate for callers that only need the verdict', () => {
    expect(isPathLengthError(new Error('ENAMETOOLONG'))).toBe(true);
    expect(isPathLengthError(new Error('permission denied'))).toBe(false);
    expect(isPathLengthError(undefined)).toBe(false);
  });
});
