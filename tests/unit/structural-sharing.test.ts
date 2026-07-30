import { describe, it, expect } from 'vitest';
import {
  applyStructuralSharing,
  applySwimlaneStructuralSharing,
} from '../../src/renderer/stores/board-store/structural-sharing';
import type { Task, Swimlane } from '../../src/shared/types';

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
    worktree_folder: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    head_sha: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    run_mode: 'column_settings',
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

  it('uses next reference when run_mode differs (Column Settings vs Agent Override)', () => {
    const previous = makeTask({ run_mode: 'column_settings' });
    const next = makeTask({ run_mode: 'agent_override' });

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
  //
  // Known limitation: this counts the LOCAL FIXTURE's keys, not the real
  // `Task` interface's - `makeTask()` above already omits several required
  // Task fields (profile_id, model_override, effort_override, agent_override,
  // permission_mode, auto_command, detail_view_state, external_id,
  // external_source, external_url) that `tsconfig.json` never typechecks
  // (tests/** is outside its `include`), so the guard cannot fire for a field
  // missing from the fixture itself, only for one present in the fixture but
  // uncounted. Keep `run_mode` represented here so the guard is at least
  // honest for this field.
  it('guards against Task-interface field drift', () => {
    const TASK_FIELD_COUNT = 24; // keep in sync with taskContentsMatch
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

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'To Do',
    description: null,
    role: null,
    position: 0,
    color: '#888888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('applySwimlaneStructuralSharing', () => {
  it('reuses the previous swimlane reference when fields are identical', () => {
    const previous = makeSwimlane();
    const next = makeSwimlane();
    expect(previous).not.toBe(next);

    const result = applySwimlaneStructuralSharing([previous], [next]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(previous);
  });

  it('uses the next reference when any field changed', () => {
    const previous = makeSwimlane({ name: 'Old', auto_command: null });
    const next = makeSwimlane({ name: 'Old', auto_command: '/code-review' });

    const result = applySwimlaneStructuralSharing([previous], [next]);

    expect(result[0]).toBe(next);
  });

  it('reuses siblings while one swimlane changed', () => {
    const previousA = makeSwimlane({ id: 'a', name: 'A' });
    const previousB = makeSwimlane({ id: 'b', name: 'B-old' });
    const nextA = makeSwimlane({ id: 'a', name: 'A' });
    const nextB = makeSwimlane({ id: 'b', name: 'B-new' });

    const result = applySwimlaneStructuralSharing([previousA, previousB], [nextA, nextB]);

    expect(result[0]).toBe(previousA);
    expect(result[1]).toBe(nextB);
  });

  it('returns the next array verbatim when previous is empty', () => {
    const next = [makeSwimlane({ id: 'a' }), makeSwimlane({ id: 'b' })];
    const result = applySwimlaneStructuralSharing([], next);
    expect(result).toBe(next);
  });

  it('returns a new outer array reference even when every swimlane was reused', () => {
    const previous = [makeSwimlane({ id: 'a' }), makeSwimlane({ id: 'b' })];
    const next = [makeSwimlane({ id: 'a' }), makeSwimlane({ id: 'b' })];

    const result = applySwimlaneStructuralSharing(previous, next);

    expect(result).not.toBe(previous);
    expect(result).not.toBe(next);
    expect(result[0]).toBe(previous[0]);
    expect(result[1]).toBe(previous[1]);
  });

  // Guard against silent drift: when a new field is added to the Swimlane
  // interface, swimlaneContentsMatch must be updated to compare it, otherwise a
  // stale reference is reused and the column memo misses the change.
  //
  // How to update when this fails: read the field list in
  // `structural-sharing.ts` swimlaneContentsMatch, add the new field there, then
  // update SWIMLANE_FIELD_COUNT below to match.
  it('guards against Swimlane-interface field drift', () => {
    const SWIMLANE_FIELD_COUNT = 20; // keep in sync with swimlaneContentsMatch
    const sample = makeSwimlane();
    expect(Object.keys(sample)).toHaveLength(SWIMLANE_FIELD_COUNT);
  });
});
