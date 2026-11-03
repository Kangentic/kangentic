/**
 * `kangentic_get_activity_intervals` reports `reasonKind` on each OPEN
 * interval row, so a caller can tell a thinking span held by background work
 * (`background-shell`) from the agent's own turn. Closed rows carry it on the
 * raw interval; the open summary copies it field by field.
 *
 * Test tier: Unit, with the same fake database as activity-interval-commands.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleGetActivityIntervals } from '../../src/main/agent/commands/activity-interval-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

function openRow(reasonKind: string | null) {
  return {
    id: 1,
    session_id: 'sess-1',
    task_id: 'task-uuid-1',
    disposition: 'active',
    state: 'thinking',
    previous_state: 'idle',
    enter_trigger: 'event:idle',
    started_ms: 5000,
    started_at: new Date(5000).toISOString(),
    ended_ms: null,
    ended_at: null,
    duration_ms: null,
    exit_trigger: null,
    recorded_at: '2026-07-22T00:00:00.000Z',
    reason_kind: reasonKind,
  };
}

function contextWithRows(rows: ReturnType<typeof openRow>[]): CommandContext {
  const database = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM session_activity_intervals') && sql.includes('WHERE session_id = ?')) {
        return { all: vi.fn(() => rows) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return {
    getProjectDb: () => database as never,
    getProjectPath: () => '/tmp/project',
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(),
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

describe('handleGetActivityIntervals reasonKind', () => {
  it('returns the reason kind on an open interval row', () => {
    const result = handleGetActivityIntervals({ sessionId: 'sess-1' }, contextWithRows([openRow('background-shell')])) as {
      data: { openIntervals: Array<{ reasonKind: string | null }> };
    };
    expect(result.data.openIntervals).toHaveLength(1);
    expect(result.data.openIntervals[0].reasonKind).toBe('background-shell');
  });

  it('returns null for an open row written before the column existed', () => {
    const result = handleGetActivityIntervals({ sessionId: 'sess-1' }, contextWithRows([openRow(null)])) as {
      data: { openIntervals: Array<{ reasonKind: string | null }> };
    };
    expect(result.data.openIntervals[0].reasonKind).toBeNull();
  });
});
