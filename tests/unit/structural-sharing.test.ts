import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyStructuralSharing,
  applySwimlaneStructuralSharing,
} from '../../src/renderer/stores/board-store/structural-sharing';
import type { Task, Swimlane } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TYPES_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/shared/types.ts'), 'utf8');
const SHARING_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'src/renderer/stores/board-store/structural-sharing.ts'),
  'utf8',
);

/**
 * Top-level property names declared on an interface in `src/shared/types.ts`.
 *
 * Property lines sit at exactly two spaces of indent; doc-comment lines inside
 * the body start with three spaces and a star, so the indent alone separates
 * them. Neither interface this is used on nests an object literal, and a nested
 * one would need this revisited rather than silently mis-parsed - hence the
 * assertion in each caller that the list is non-empty and plausible.
 */
function declaredInterfaceFields(interfaceName: string): string[] {
  const start = TYPES_SOURCE.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`Could not find "export interface ${interfaceName}" in types.ts`);
  const end = TYPES_SOURCE.indexOf('\n}', start);
  if (end < 0) throw new Error(`Could not find the end of interface ${interfaceName}`);
  const body = TYPES_SOURCE.slice(start, end);
  const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);
  if (fields.length < 5) throw new Error(`Parsed only ${fields.length} fields off ${interfaceName}; the parser needs revisiting`);
  return fields;
}

/**
 * Property names a comparator function reads off its `previous` argument. This
 * catches both the `previous.x !== next.x` compares and the `previous.labels ??
 * []` array special-case, so a field handled either way counts as covered.
 */
function comparedFields(functionName: string): string[] {
  const start = SHARING_SOURCE.indexOf(`function ${functionName}(`);
  if (start < 0) throw new Error(`Could not find "function ${functionName}" in structural-sharing.ts`);
  const end = SHARING_SOURCE.indexOf('\n}', start);
  const body = SHARING_SOURCE.slice(start, end);
  return [...new Set([...body.matchAll(/\bprevious\.(\w+)\b/g)].map((match) => match[1]))];
}

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
    worktree_skip_reason: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    head_sha: null,
    pushed_branch: null,
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

  it('uses next reference when worktree_folder changed', () => {
    const previous = makeTask({ worktree_folder: null });
    const next = makeTask({ worktree_folder: '460' });

    const result = applyStructuralSharing([previous], [next]);

    expect(result[0]).toBe(next);
  });

  // A background PR sweep or an explicit "Refresh PR" can resolve a new merge
  // verdict while the link itself (url/number/state) stays exactly the same -
  // see pr-link-ladder.test.ts's "fires when only the merge-readiness verdict
  // changes (url/number/state unchanged)". Without this comparison the card
  // would keep the stale chip reference until an unrelated field changed too.
  it('uses next reference when pr_merge_readiness changed with url/number/state unchanged', () => {
    const previous = makeTask({
      pr_url: 'https://github.com/owner/repo/pull/10',
      pr_number: 10,
      pr_state: 'open',
      pr_merge_readiness: 'ready',
    });
    const next = makeTask({
      pr_url: 'https://github.com/owner/repo/pull/10',
      pr_number: 10,
      pr_state: 'open',
      pr_merge_readiness: 'blocked',
    });

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
  // interface, taskContentsMatch must compare it. Otherwise the equality check
  // reuses a stale reference and React.memo misses the change.
  //
  // This reads the REAL interface out of src/shared/types.ts rather than
  // counting a local fixture's keys. The count form could not fire for a field
  // the fixture itself omitted, and the fixture omitted ten of them - so a new
  // Task field added to neither passed silently. `tests/**` is outside
  // tsconfig's `include`, so the compiler will not catch it either; this scan is
  // the only thing that can.
  it('guards against Task-interface field drift', () => {
    const declared = declaredInterfaceFields('Task');
    const compared = comparedFields('taskContentsMatch');
    const missing = declared.filter((field) => !compared.includes(field));
    expect(
      missing,
      `taskContentsMatch does not compare these Task fields, so a change to one of them `
      + `reuses the stale object and the card never re-renders: ${missing.join(', ')}`,
    ).toEqual([]);
    // The interface is the source of truth, so a compared field that no longer
    // exists is dead weight worth deleting.
    const extra = compared.filter((field) => !declared.includes(field));
    expect(extra, `taskContentsMatch compares fields Task no longer declares: ${extra.join(', ')}`).toEqual([]);
  });

  it('guards against Swimlane-interface field drift, by the same derivation', () => {
    const declared = declaredInterfaceFields('Swimlane');
    const compared = comparedFields('swimlaneContentsMatch');
    const missing = declared.filter((field) => !compared.includes(field));
    expect(
      missing,
      `swimlaneContentsMatch does not compare these Swimlane fields: ${missing.join(', ')}`,
    ).toEqual([]);
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

  // The Swimlane counterpart of the Task drift guard above lives beside it, so
  // both read their interface out of types.ts by the same derivation. The
  // fixture-count form this replaced was passing while swimlaneContentsMatch
  // silently omitted `auto_command_mode`.
});
