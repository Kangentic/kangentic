/**
 * `resolveColumn`'s three answers for the Done lane.
 *
 * Done is persisted `is_archived = 1` by construction, so it does not resolve by
 * name unless the caller opts in. There are two shapes of opt-in, and mixing
 * them up produces the bug this whole change is about:
 *
 *   - `includeArchivedDone` - Done is a legal target (move_task, reorder_tasks,
 *     update_column, a plan-exit target).
 *   - `refuseDone` - Done resolves and is then REFUSED with an explanation
 *     (create_task, promote_backlog, move_task_to_project). Before this, those
 *     three answered `Column "Done" not found`, which flatly contradicted
 *     kangentic_list_columns once that started printing Done, and read as a typo
 *     rather than a limitation.
 *
 * Testing the resolver instead of the three handlers is deliberate: the guard
 * lives here now, so one local test covers every placement site. The handler
 * suites that exercise it end to end use a real better-sqlite3 DB and skip on a
 * dev machine (Electron ABI), so they are CI-only.
 *
 * Mocking SwimlaneRepository mirrors inventory-commands-list-columns.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSwimlaneRepoList } = vi.hoisted(() => ({
  mockSwimlaneRepoList: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    list = mockSwimlaneRepoList;
  },
}));

import { resolveColumn } from '../../src/main/agent/commands/column-resolver';
import type Database from 'better-sqlite3';

const TODO_LANE = { id: 'lane-todo', name: 'To Do', role: 'todo', is_archived: false };
const MERGE_LANE = { id: 'lane-merge', name: 'Merge', role: null, is_archived: false };
const DONE_LANE = { id: 'lane-done', name: 'Done', role: 'done', is_archived: true };
/** Archived by a user to hide it. Never resolvable, under any option. */
const HIDDEN_LANE = { id: 'lane-hidden', name: 'Icebox', role: null, is_archived: true };

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  mockSwimlaneRepoList.mockReturnValue([TODO_LANE, MERGE_LANE, DONE_LANE, HIDDEN_LANE]);
});

describe('resolveColumn with no Done option', () => {
  it('does not resolve Done by name', () => {
    const resolution = resolveColumn(db, 'Done');

    expect('error' in resolution).toBe(true);
    if ('error' in resolution) expect(resolution.error).toContain('not found');
  });
});

describe('resolveColumn with includeArchivedDone', () => {
  it('resolves Done as a legal target', () => {
    const resolution = resolveColumn(db, 'Done', 'todo', { includeArchivedDone: true });

    expect('error' in resolution).toBe(false);
    if (!('error' in resolution)) expect(resolution.swimlane.id).toBe(DONE_LANE.id);
  });

  it('still refuses a lane a user archived', () => {
    const resolution = resolveColumn(db, 'Icebox', 'todo', { includeArchivedDone: true });

    // The carve-out is `role === 'done'`, never "any archived lane". Widening it
    // would leak every hidden column through move_task.
    expect('error' in resolution).toBe(true);
  });
});

describe('resolveColumn with refuseDone', () => {
  it('refuses Done with the caller\'s clause instead of "not found"', () => {
    const resolution = resolveColumn(db, 'Done', 'todo', {
      refuseDone: 'a task cannot be created there',
    });

    expect('error' in resolution).toBe(true);
    if ('error' in resolution) {
      expect(resolution.error).not.toContain('not found');
      expect(resolution.error).toContain('completed column');
      expect(resolution.error).toContain('a task cannot be created there');
      expect(resolution.error).toContain('kangentic_move_task');
    }
  });

  it('matches Done case-insensitively, so "done" is refused the same way', () => {
    const resolution = resolveColumn(db, 'done', 'todo', { refuseDone: 'nope' });

    expect('error' in resolution).toBe(true);
    if ('error' in resolution) expect(resolution.error).not.toContain('not found');
  });

  it('leaves every other column resolvable', () => {
    const resolution = resolveColumn(db, 'Merge', 'todo', { refuseDone: 'nope' });

    expect('error' in resolution).toBe(false);
    if (!('error' in resolution)) expect(resolution.swimlane.id).toBe(MERGE_LANE.id);
  });

  it('falls back to To Do when no column is named, rather than refusing', () => {
    // The default path never asked for Done, so the refusal must not fire and
    // break every create_task call that omits `column`.
    const resolution = resolveColumn(db, null, 'todo', { refuseDone: 'nope' });

    expect('error' in resolution).toBe(false);
    if (!('error' in resolution)) expect(resolution.swimlane.id).toBe(TODO_LANE.id);
  });

  it('does not expose a user-archived lane as a side effect of opting in', () => {
    const resolution = resolveColumn(db, 'Icebox', 'todo', { refuseDone: 'nope' });

    expect('error' in resolution).toBe(true);
    if ('error' in resolution) {
      const available = resolution.error.split('Available columns: ')[1]?.split('.')[0] ?? '';
      expect(available.split(', ')).not.toContain('Icebox');
      // Done IS listed: the caller can see it exists and get the real refusal.
      expect(available.split(', ')).toContain('Done');
    }
  });
});
