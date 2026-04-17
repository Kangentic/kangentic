import { describe, it, expect } from 'vitest';
import { applyStructuralSharing } from '../../src/renderer/stores/board-store/structural-sharing';
import type { Task } from '../../src/shared/types';

/**
 * `applyStructuralSharing` is our narrow port of TanStack Query's default
 * "structural sharing" optimization: reuse the previous object reference for
 * every task whose contents are unchanged so `React.memo` on TaskCard can
 * short-circuit. These tests lock the contract.
 */

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    display_id: 1,
    title: 'Task',
    description: 'Description',
    swimlane_id: 'lane-1',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2026-04-17T00:00:00.000Z',
    updated_at: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('applyStructuralSharing', () => {
  it('reuses previous task reference when fields are identical', () => {
    const previous = makeTask();
    const next = makeTask();
    expect(previous).not.toBe(next); // different objects

    const result = applyStructuralSharing([previous], [next]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(previous); // SAME reference as previous
  });

  it('uses next reference when any primitive field changed', () => {
    const previous = makeTask({ title: 'Old' });
    const next = makeTask({ title: 'New' });

    const result = applyStructuralSharing([previous], [next]);

    expect(result[0]).toBe(next);
    expect(result[0].title).toBe('New');
  });

  it('uses next reference when position changed (task was moved)', () => {
    const previous = makeTask({ position: 0 });
    const next = makeTask({ position: 3 });

    const result = applyStructuralSharing([previous], [next]);

    expect(result[0]).toBe(next);
  });

  it('uses next reference when labels array differs in length', () => {
    const previous = makeTask({ labels: ['bug'] });
    const next = makeTask({ labels: ['bug', 'regression'] });

    const result = applyStructuralSharing([previous], [next]);

    expect(result[0]).toBe(next);
  });

  it('uses next reference when labels differ in order (treats order as meaningful)', () => {
    const previous = makeTask({ labels: ['bug', 'frontend'] });
    const next = makeTask({ labels: ['frontend', 'bug'] });

    const result = applyStructuralSharing([previous], [next]);

    // Documented behavior: order matters. Worst case is a false-negative
    // (unnecessary re-render), never a false-positive (stale data).
    expect(result[0]).toBe(next);
  });

  it('reuses references for unchanged tasks even when a sibling changed', () => {
    const previousA = makeTask({ id: 'a', title: 'A' });
    const previousB = makeTask({ id: 'b', title: 'B-old' });
    const previousC = makeTask({ id: 'c', title: 'C' });
    const nextA = makeTask({ id: 'a', title: 'A' });
    const nextB = makeTask({ id: 'b', title: 'B-new' });
    const nextC = makeTask({ id: 'c', title: 'C' });

    const result = applyStructuralSharing(
      [previousA, previousB, previousC],
      [nextA, nextB, nextC],
    );

    expect(result[0]).toBe(previousA); // reused
    expect(result[1]).toBe(nextB); // replaced (title changed)
    expect(result[2]).toBe(previousC); // reused
  });

  it('passes through new tasks that were not present before', () => {
    const previous = makeTask({ id: 'a' });
    const next = makeTask({ id: 'b' });

    const result = applyStructuralSharing([previous], [next]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(next);
  });

  it('drops tasks removed from the next list', () => {
    const previousA = makeTask({ id: 'a' });
    const previousB = makeTask({ id: 'b' });
    const nextA = makeTask({ id: 'a' });

    const result = applyStructuralSharing([previousA, previousB], [nextA]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(previousA); // reused
    // previousB is not in result - correct
  });

  it('returns the next array verbatim when previous is empty', () => {
    const next = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    const result = applyStructuralSharing([], next);
    expect(result).toBe(next);
  });

  it('returns a new outer array reference even when every task was reused', () => {
    const previous = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    const next = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];

    const result = applyStructuralSharing(previous, next);

    // Outer ref MUST break - downstream memos (tasksPerLane, swimlane taskIds)
    // rely on this to re-evaluate after any loadBoard roundtrip.
    expect(result).not.toBe(previous);
    expect(result).not.toBe(next);
    expect(result[0]).toBe(previous[0]);
    expect(result[1]).toBe(previous[1]);
  });

  // Guard against silent drift: when a new field is added to the Task
  // interface, taskContentsMatch must be updated to compare it. Otherwise the
  // equality check will reuse a stale reference and React.memo will miss
  // the change. The assertion below fails if Task acquires a new field
  // not covered by the equality check.
  //
  // How to update when this fails: read the list of fields in
  // `src/renderer/stores/board-store/structural-sharing.ts` taskContentsMatch,
  // add the new field there, then update TASK_FIELD_COUNT below to match.
  it('guards against Task-interface field drift', () => {
    const TASK_FIELD_COUNT = 20; // keep in sync with taskContentsMatch
    const sample = makeTask();
    expect(Object.keys(sample)).toHaveLength(TASK_FIELD_COUNT);
  });

  it('handles absent labels defensively', () => {
    // Legacy IPC payloads that skipped the labels column would arrive with
    // `labels === undefined`. The helper must not crash. The Task interface
    // declares `labels: string[]` (required), so we model the malformed
    // shape explicitly and cast at the boundary to exercise the runtime
    // fallback without disabling type checking more broadly.
    type TaskMissingLabels = Omit<Task, 'labels'> & { labels?: undefined };
    const previousMalformed: TaskMissingLabels = { ...makeTask(), labels: undefined };
    const nextMalformed: TaskMissingLabels = { ...makeTask(), labels: undefined };

    const result = applyStructuralSharing(
      [previousMalformed as unknown as Task],
      [nextMalformed as unknown as Task],
    );
    expect(result[0]).toBe(previousMalformed);
  });
});
