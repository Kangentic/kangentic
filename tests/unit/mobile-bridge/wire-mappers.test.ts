/**
 * Unit tests for toBoardTaskWire and toBoardColumnWire
 * (src/main/mobile-bridge/handlers/wire-mappers.ts). No existing suite
 * exercises either mapper directly - read-board.test.ts covers
 * handleReadBoard end to end but stubs raw partial rows, never a full Task
 * or Swimlane.
 */
import { describe, it, expect } from 'vitest';
import { columnSpawnsSession, toBoardColumnWire, toBoardTaskWire } from '../../../src/main/mobile-bridge/handlers/wire-mappers';
import { parseBoardColumnWire } from '@kangentic/protocol';
import type { JsonValue } from '@kangentic/protocol';
import type { Swimlane, Task } from '../../../src/shared/types';

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

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'Column',
    description: null,
    role: null,
    position: 0,
    color: '#00ff00',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    auto_command_mode: 'immediate',
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

describe('columnSpawnsSession', () => {
  it('is false for a role:todo column, even with auto_spawn true', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: 'todo', auto_spawn: true }))).toBe(false);
  });

  it('is false for a role:done column, even with auto_spawn true', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: 'done', auto_spawn: true }))).toBe(false);
  });

  it('is false for a custom column with auto_spawn false', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: null, auto_spawn: false }))).toBe(false);
  });

  it('is true for a custom column with auto_spawn true', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: null, auto_spawn: true }))).toBe(true);
  });

  it('is a real boolean, never undefined, for a malformed auto_spawn', () => {
    const malformed = makeSwimlane({ role: null }) as Swimlane;
    // @ts-expect-error - simulating a malformed row with a missing auto_spawn
    delete malformed.auto_spawn;
    expect(columnSpawnsSession(malformed)).toBe(false);
  });
});

describe('toBoardColumnWire', () => {
  it('carries spawns_session computed from role and auto_spawn', () => {
    expect(toBoardColumnWire(makeSwimlane({ role: 'todo', auto_spawn: true })).spawns_session).toBe(false);
    expect(toBoardColumnWire(makeSwimlane({ role: null, auto_spawn: true })).spawns_session).toBe(true);
  });

  it('passes role through unchanged', () => {
    expect(toBoardColumnWire(makeSwimlane({ role: 'done' })).role).toBe('done');
    expect(toBoardColumnWire(makeSwimlane({ role: null })).role).toBeNull();
  });
});

describe('toBoardColumnWire round-trips through parseBoardColumnWire', () => {
  // The mapper (this file's producer) and the parser (packages/protocol's
  // consumer) are otherwise only ever tested independently, so a field-name
  // drift between the two (spawnsSession vs spawns_session, a renamed
  // is_ghost) would pass both suites while breaking the real bridge. This
  // sends a mapped column through an actual wire round trip
  // (JSON.parse(JSON.stringify(...))) the way the bridge does, then asserts
  // the parser reproduces the mapper's output exactly.
  function roundTrip(swimlane: Swimlane) {
    const wire = toBoardColumnWire(swimlane);
    const overWire = JSON.parse(JSON.stringify(wire)) as JsonValue;
    return { wire, parsed: parseBoardColumnWire(overWire) };
  }

  it('round-trips a role:done column', () => {
    const { wire, parsed } = roundTrip(makeSwimlane({ role: 'done', auto_spawn: true }));
    expect(parsed).toEqual(wire);
  });

  it('round-trips a role:null, auto_spawn:true column', () => {
    const { wire, parsed } = roundTrip(makeSwimlane({ role: null, auto_spawn: true }));
    expect(parsed).toEqual(wire);
  });
});
