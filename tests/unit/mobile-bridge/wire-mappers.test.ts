/**
 * Unit tests for toBoardTaskWire (src/main/mobile-bridge/handlers/wire-mappers.ts).
 * No existing suite exercises this mapper directly - read-board.test.ts covers
 * handleReadBoard end to end but stubs raw partial task rows, never a full
 * Task, and never asserts on pr_merge_readiness specifically.
 */
import { describe, it, expect } from 'vitest';
import { toBoardTaskWire } from '../../../src/main/mobile-bridge/handlers/wire-mappers';
import type { Task } from '../../../src/shared/types';

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
  } as Task;
}

describe('toBoardTaskWire', () => {
  it('carries a judged pr_merge_readiness value through to the wire shape', () => {
    const task = makeTask({ pr_merge_readiness: 'ready' });
    expect(toBoardTaskWire(task).pr_merge_readiness).toBe('ready');
  });

  it('passes null through when the PR has no judged readiness', () => {
    const task = makeTask({ pr_merge_readiness: null });
    expect(toBoardTaskWire(task).pr_merge_readiness).toBeNull();
  });
});
