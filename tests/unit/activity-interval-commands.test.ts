import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleGetActivityIntervals } from '../../src/main/agent/commands/activity-interval-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

interface FakeIntervalRow {
  id: number;
  session_id: string;
  task_id: string | null;
  disposition: string;
  state: string;
  previous_state: string;
  enter_trigger: string;
  started_ms: number;
  started_at: string;
  ended_ms: number | null;
  ended_at: string | null;
  duration_ms: number | null;
  exit_trigger: string | null;
  recorded_at: string;
}

function row(overrides: Partial<FakeIntervalRow> = {}): FakeIntervalRow {
  return {
    id: 1,
    session_id: 'sess-1',
    task_id: 'task-uuid-1',
    disposition: 'idle',
    state: 'idle',
    previous_state: 'thinking',
    enter_trigger: 'event:idle',
    started_ms: 1000,
    started_at: new Date(1000).toISOString(),
    ended_ms: 5000,
    ended_at: new Date(5000).toISOString(),
    duration_ms: 4000,
    exit_trigger: 'event:prompt',
    recorded_at: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

function createDb(options: {
  intervalsByTask?: Record<string, FakeIntervalRow[]>;
  intervalsBySession?: Record<string, FakeIntervalRow[]>;
  tasks?: Array<{ id: string; display_id: number; title: string }>;
}) {
  const intervalsByTask = options.intervalsByTask ?? {};
  const intervalsBySession = options.intervalsBySession ?? {};
  const tasks = options.tasks ?? [];

  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM session_activity_intervals') && sql.includes('WHERE task_id = ?')) {
        return { all: vi.fn((taskId: string) => intervalsByTask[taskId] ?? []) };
      }
      if (sql.includes('FROM session_activity_intervals') && sql.includes('WHERE session_id = ?')) {
        return { all: vi.fn((sessionId: string) => intervalsBySession[sessionId] ?? []) };
      }
      if (sql.includes('FROM tasks') && sql.includes('WHERE t.display_id')) {
        return { get: vi.fn((displayId: number) => tasks.find((task) => task.display_id === displayId)) };
      }
      if (sql.includes('FROM tasks') && sql.includes('WHERE t.id')) {
        return { get: vi.fn((taskId: string) => tasks.find((task) => task.id === taskId)) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
}

function createContext(db: ReturnType<typeof createDb>): CommandContext {
  return {
    getProjectDb: () => db as never,
    getProjectPath: () => '/tmp/project',
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-22T00:01:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleGetActivityIntervals', () => {
  it('returns an error when neither taskId nor sessionId is given', () => {
    const db = createDb({});
    const result = handleGetActivityIntervals({}, createContext(db));
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { success: boolean }).success).toBe(false);
    expect((result as { error?: string }).error).toContain('taskId or sessionId');
  });

  it('resolves by sessionId directly, no task lookup', () => {
    const db = createDb({ intervalsBySession: { 'sess-1': [row()] } });
    const result = handleGetActivityIntervals({ sessionId: 'sess-1' }, createContext(db)) as { success: boolean; data: unknown };
    expect(result.success).toBe(true);
    const data = result.data as { intervals: unknown[]; totals: { activeMs: number; idleMs: number }; openIntervals: unknown[] };
    expect(data.intervals).toHaveLength(1);
    expect(data.totals).toEqual({ activeMs: 0, idleMs: 4000 });
    expect(data.openIntervals).toEqual([]);
  });

  it('resolves by numeric display_id and returns intervals across all the task\'s sessions', () => {
    const db = createDb({
      tasks: [{ id: 'task-uuid-1', display_id: 42, title: 'Fix the bug' }],
      intervalsByTask: {
        'task-uuid-1': [
          row({ id: 1, session_id: 'sess-1', disposition: 'active', state: 'thinking', duration_ms: 3000, ended_ms: 4000 }),
          row({ id: 2, session_id: 'sess-2', disposition: 'idle', state: 'idle', duration_ms: 4000, ended_ms: 5000 }),
        ],
      },
    });
    const result = handleGetActivityIntervals({ taskId: '42' }, createContext(db)) as { success: boolean; data: unknown };
    expect(result.success).toBe(true);
    const data = result.data as { intervals: Array<{ sessionId: string }>; totals: { activeMs: number; idleMs: number } };
    expect(data.intervals.map((interval) => interval.sessionId)).toEqual(['sess-1', 'sess-2']);
    expect(data.totals).toEqual({ activeMs: 3000, idleMs: 4000 });
  });

  it('returns an error when the task cannot be resolved', () => {
    const db = createDb({ tasks: [] });
    const result = handleGetActivityIntervals({ taskId: 'nonexistent' }, createContext(db)) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent');
  });

  it('separates a still-open interval into openIntervals with a live-computed elapsed time, excluded from totals', () => {
    const db = createDb({
      intervalsBySession: {
        'sess-1': [
          row({ id: 1, disposition: 'idle', duration_ms: 4000, ended_ms: 5000 }),
          row({
            id: 2,
            disposition: 'active',
            state: 'thinking',
            previous_state: 'idle',
            started_ms: 5000,
            started_at: new Date(5000).toISOString(),
            ended_ms: null,
            ended_at: null,
            duration_ms: null,
            exit_trigger: null,
          }),
        ],
      },
    });
    const result = handleGetActivityIntervals({ sessionId: 'sess-1' }, createContext(db)) as { success: boolean; data: unknown };
    const data = result.data as {
      totals: { activeMs: number; idleMs: number };
      openIntervals: Array<{ sessionId: string; disposition: string; startedMs: number; startedAt: string; liveElapsedMs: number }>;
    };
    // Only the closed 'idle' row counts toward totals; the open 'active' row does not.
    expect(data.totals).toEqual({ activeMs: 0, idleMs: 4000 });
    expect(data.openIntervals).toHaveLength(1);
    expect(data.openIntervals[0]).toMatchObject({
      sessionId: 'sess-1',
      disposition: 'active',
      startedMs: 5000,
      startedAt: new Date(5000).toISOString(),
    });
    // System time is frozen at 2026-07-22T00:01:00.000Z = epoch 1784685660000; startedMs 5000 -> elapsed = 1784685660000 - 5000.
    expect(data.openIntervals[0].liveElapsedMs).toBe(new Date('2026-07-22T00:01:00.000Z').getTime() - 5000);
  });
});
