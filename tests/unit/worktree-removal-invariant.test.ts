/**
 * `removeWorktree` runs a retried recursive delete, deliberately aggressive
 * about Windows file locks, on a path that is COMPUTED rather than read back
 * verbatim. These pin the guard that keeps that machinery pointed at a worktree
 * directory of this project and nothing else.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { assertRemovableWorktreePath } from '../../src/main/git/worktree-manager';

const PROJECT = path.join('C:', 'Users', 'dev', 'proj');
const worktreesRoot = path.join(PROJECT, '.kangentic', 'worktrees');

describe('assertRemovableWorktreePath', () => {
  it('accepts a direct child of the project worktrees root', () => {
    expect(() => assertRemovableWorktreePath(PROJECT, path.join(worktreesRoot, '460'))).not.toThrow();
    // Legacy folders were never renamed, so they must still be removable.
    expect(() => assertRemovableWorktreePath(PROJECT, path.join(worktreesRoot, 'dns-setup-4e41b16b')))
      .not.toThrow();
  });

  it('refuses a filesystem root', () => {
    // Resolve first: PROJECT is a Windows-shaped literal, so on Linux CI it is a
    // RELATIVE path whose `root` is the empty string. Resolving against cwd
    // yields a real root on both platforms ('C:\\' on Windows, '/' elsewhere).
    expect(() => assertRemovableWorktreePath(PROJECT, path.parse(path.resolve(PROJECT)).root))
      .toThrow(/filesystem root/);
  });

  it('refuses the worktrees root itself', () => {
    expect(() => assertRemovableWorktreePath(PROJECT, worktreesRoot)).toThrow(/direct child/);
  });

  it('refuses the project directory', () => {
    expect(() => assertRemovableWorktreePath(PROJECT, PROJECT)).toThrow(/direct child/);
  });

  it('refuses an ancestor reached by traversal', () => {
    expect(() => assertRemovableWorktreePath(PROJECT, path.join(worktreesRoot, '..', '..', '..')))
      .toThrow(/direct child|filesystem root/);
  });

  it('refuses a grandchild, so a partial path can never take the whole worktree', () => {
    expect(() => assertRemovableWorktreePath(PROJECT, path.join(worktreesRoot, '460', 'src')))
      .toThrow(/direct child/);
  });

  it('refuses a path belonging to a different project', () => {
    const otherProject = path.join('C:', 'Users', 'dev', 'other');
    expect(() => assertRemovableWorktreePath(
      PROJECT,
      path.join(otherProject, '.kangentic', 'worktrees', '460'),
    )).toThrow(/direct child/);
  });
});
