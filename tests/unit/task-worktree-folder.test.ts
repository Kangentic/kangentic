/**
 * Unit tests for `src/main/git/task-worktree-folder.ts`.
 *
 * This module implements the PR's headline guarantee: a task's worktree
 * directory name is chosen once and never changes, even across a Done
 * round-trip that nulls `worktree_path`. `prepareWorktreeFolder` is the
 * recovery step that runs before creation; `candidateWorktreePathsFor` is the
 * probe used by best-effort cleanup passes that cannot trust a single field.
 *
 * `transition-engine.test.ts` mocks `recoverLegacyWorktreeFolder` to always
 * return null, so the recovery branch of `prepareWorktreeFolder` has never
 * actually executed anywhere else in the suite. This file is the only place
 * that behavior is pinned.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import {
  worktreesRootFor,
  prepareWorktreeFolder,
  legacyAutoBranchNameFor,
  candidateWorktreePathsFor,
} from '../../src/main/git/task-worktree-folder';
import type { TaskRepository } from '../../src/main/db/repositories/task-repository';
import type { Task } from '../../src/shared/types';

const PROJECT_PATH = path.join('C:', 'Users', 'dev', 'proj');
const WORKTREES_ROOT = path.join(PROJECT_PATH, '.kangentic', 'worktrees');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'aaaa1111-0000-0000-0000-000000000000',
    display_id: 460,
    title: 'DNS Setup',
    worktree_path: null,
    worktree_folder: null,
    ...overrides,
  } as Task;
}

function makeTaskRepo(recoveredFolder: string | null): { repo: TaskRepository; recoverLegacyWorktreeFolder: ReturnType<typeof vi.fn> } {
  const recoverLegacyWorktreeFolder = vi.fn(() => recoveredFolder);
  return {
    repo: { recoverLegacyWorktreeFolder } as unknown as TaskRepository,
    recoverLegacyWorktreeFolder,
  };
}

describe('worktreesRootFor', () => {
  it('joins the fixed .kangentic/worktrees segment onto the project path', () => {
    expect(worktreesRootFor(PROJECT_PATH)).toBe(WORKTREES_ROOT);
  });
});

describe('prepareWorktreeFolder', () => {
  it('is a no-op when worktree_folder is already set', () => {
    const task = makeTask({ worktree_folder: 'dns-setup-aaaa1111', worktree_path: null });
    const { repo, recoverLegacyWorktreeFolder } = makeTaskRepo('should-never-be-read');

    prepareWorktreeFolder(task, repo, PROJECT_PATH);

    expect(recoverLegacyWorktreeFolder).not.toHaveBeenCalled();
    expect(task.worktree_folder).toBe('dns-setup-aaaa1111');
  });

  /**
   * A task with a live worktree_path skips the DB read too: createWorktree
   * derives the folder from the path itself (worktreeFolderFromPath) when
   * worktree_folder is still null, so there is nothing for recovery to do.
   */
  it('is a no-op when only worktree_path is set (folder still null)', () => {
    const task = makeTask({
      worktree_folder: null,
      worktree_path: path.join(WORKTREES_ROOT, 'dns-setup-aaaa1111'),
    });
    const { repo, recoverLegacyWorktreeFolder } = makeTaskRepo('should-never-be-read');

    prepareWorktreeFolder(task, repo, PROJECT_PATH);

    expect(recoverLegacyWorktreeFolder).not.toHaveBeenCalled();
    expect(task.worktree_folder).toBeNull();
  });

  it('recovers the legacy folder and mutates the task in place when both fields are null', () => {
    const task = makeTask({ worktree_folder: null, worktree_path: null });
    const { repo, recoverLegacyWorktreeFolder } = makeTaskRepo('dns-setup-aaaa1111');

    prepareWorktreeFolder(task, repo, PROJECT_PATH);

    // Called with the ANCHORED worktrees root, not a bare project path - that
    // anchor is what keeps recovery from claiming an enclosing worktree's
    // folder when Kangentic itself is opened at a worktree path.
    expect(recoverLegacyWorktreeFolder).toHaveBeenCalledWith(task.id, WORKTREES_ROOT);
    expect(task.worktree_folder).toBe('dns-setup-aaaa1111');
  });

  it('leaves worktree_folder null when there is nothing to recover', () => {
    const task = makeTask({ worktree_folder: null, worktree_path: null });
    const { repo, recoverLegacyWorktreeFolder } = makeTaskRepo(null);

    prepareWorktreeFolder(task, repo, PROJECT_PATH);

    expect(recoverLegacyWorktreeFolder).toHaveBeenCalledWith(task.id, WORKTREES_ROOT);
    expect(task.worktree_folder).toBeNull();
  });
});

describe('legacyAutoBranchNameFor', () => {
  it('slugifies the title and appends the 8-char task id shortId', () => {
    expect(legacyAutoBranchNameFor({ id: 'aaaa1111-0000-0000-0000-000000000000', title: 'DNS Setup' }))
      .toBe('dns-setup-aaaa1111');
  });

  it('falls back to "task" for an unsluggable title', () => {
    expect(legacyAutoBranchNameFor({ id: 'aaaa1111-0000-0000-0000-000000000000', title: '!!!' }))
      .toBe('task-aaaa1111');
  });
});

describe('candidateWorktreePathsFor', () => {
  it('puts worktree_path first when present', () => {
    const task = makeTask({
      worktree_path: path.join(WORKTREES_ROOT, 'stored-path'),
      worktree_folder: 'pinned-folder',
      display_id: 460,
    });

    const candidates = candidateWorktreePathsFor(task, PROJECT_PATH);

    expect(candidates[0]).toBe(path.join(WORKTREES_ROOT, 'stored-path'));
  });

  it('dedups when worktree_folder already equals the numeric display_id name', () => {
    // The common new-task case: worktree_folder was pinned to String(display_id)
    // on first creation, so the folder-derived and display_id-derived candidates
    // collapse into one entry rather than two identical paths.
    const task = makeTask({
      worktree_path: null,
      worktree_folder: '460',
      display_id: 460,
      title: 'DNS Setup',
    });

    const candidates = candidateWorktreePathsFor(task, PROJECT_PATH);

    expect(candidates).toEqual([
      path.join(WORKTREES_ROOT, '460'),
      path.join(WORKTREES_ROOT, 'dns-setup-aaaa1111'),
    ]);
  });

  it('omits the display_id candidate when display_id is not a positive integer', () => {
    const zeroDisplayId = makeTask({ worktree_path: null, worktree_folder: null, display_id: 0 });
    expect(candidateWorktreePathsFor(zeroDisplayId, PROJECT_PATH)).toEqual([
      path.join(WORKTREES_ROOT, 'dns-setup-aaaa1111'),
    ]);

    const nonIntegerDisplayId = makeTask({
      worktree_path: null,
      worktree_folder: null,
      display_id: 1.5 as unknown as number,
    });
    expect(candidateWorktreePathsFor(nonIntegerDisplayId, PROJECT_PATH)).toEqual([
      path.join(WORKTREES_ROOT, 'dns-setup-aaaa1111'),
    ]);
  });

  it('always includes the legacy title-derived name, even alongside the others', () => {
    const task = makeTask({
      worktree_path: path.join(WORKTREES_ROOT, 'stored-path'),
      worktree_folder: 'pinned-folder',
      display_id: 460,
      title: 'DNS Setup',
    });

    const candidates = candidateWorktreePathsFor(task, PROJECT_PATH);

    expect(candidates).toEqual([
      path.join(WORKTREES_ROOT, 'stored-path'),
      path.join(WORKTREES_ROOT, 'pinned-folder'),
      path.join(WORKTREES_ROOT, '460'),
      path.join(WORKTREES_ROOT, 'dns-setup-aaaa1111'),
    ]);
  });

  it('returns only the legacy name for a task with no stored path, folder, or usable display_id', () => {
    const task = makeTask({ worktree_path: null, worktree_folder: null, display_id: 0, title: 'DNS Setup' });

    expect(candidateWorktreePathsFor(task, PROJECT_PATH)).toEqual([
      path.join(WORKTREES_ROOT, 'dns-setup-aaaa1111'),
    ]);
  });
});
