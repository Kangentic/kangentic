/**
 * `kangentic_list_sessions` and `kangentic_get_task_stats` (`handleListSessions` and
 * `handleGetTaskStats`, src/main/agent/commands/analytics-commands.ts).
 *
 * An agent reports cost and duration as CUMULATIVE readings for a whole conversation, and a resume is
 * a new session record, so a record's raw reading includes every earlier leg. The list prints each
 * record's own share (the rule `legDeltas` applies), so the printed costs add up to the task's total
 * instead of counting a resumed conversation once per leg. The raw reading stays beside the share in
 * the structured data. The time is labeled "runtime" and never "duration".
 *
 * The handlers run with no database: the task repository and the summary read are mocked as in
 * analytics-commands-subagent-stats.test.ts, and the sessions query is answered by a fake handle that
 * returns the rows a test hands it, in the started_at order the real query sorts them in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { SessionSummary } from '../../src/shared/types';

const { mockGetById, mockGetSummaryForTask } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockGetSummaryForTask: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = mockGetById;
    getByDisplayId = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getSummaryForTask = mockGetSummaryForTask;
  },
}));

// The subagent ledger is read in the retrieval worker; these tests are about the totals above it.
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: async () => ({ bySubagentType: [], fanOuts: [] }) },
}));

import { handleGetTaskStats, handleListSessions } from '../../src/main/agent/commands/analytics-commands';

const TASK = { id: 'task-uuid-1', title: 'Ship the report', display_id: 7 };

const MINUTE = 60_000;

interface SessionRow {
  id: string;
  session_type: string;
  agent_session_id: string | null;
  cwd: string;
  status: string;
  exit_code: number | null;
  started_at: string;
  suspended_at: string | null;
  exited_at: string | null;
  suspended_by: string | null;
  permission_mode: string | null;
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_duration_ms: number | null;
  tool_call_count: number | null;
}

/** What `data` carries per record, the part these tests read. */
interface ListedSession {
  id: string;
  cost: number | null;
  cumulativeCost: number | null;
  durationMs: number | null;
  cumulativeDurationMs: number | null;
}

function sessionRow(overrides: Partial<SessionRow> & Pick<SessionRow, 'id' | 'started_at'>): SessionRow {
  return {
    session_type: 'claude',
    agent_session_id: null,
    cwd: '/mock/project',
    status: 'exited',
    exit_code: null,
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
    permission_mode: null,
    total_cost_usd: null,
    total_input_tokens: null,
    total_output_tokens: null,
    total_duration_ms: null,
    tool_call_count: null,
    ...overrides,
  };
}

function makeContext(rows: SessionRow[] = []): CommandContext {
  const database = { prepare: () => ({ all: () => rows }) };
  return { getProjectDb: () => database, getProjectPath: () => '/mock/project' } as unknown as CommandContext;
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    totalCostUsd: 1.2345,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    modelDisplayName: 'Opus 5.5',
    durationMs: 60_000,
    toolCallCount: 12,
    compactionCount: 0,
    linesAdded: 10,
    linesRemoved: 3,
    filesChanged: 2,
    taskCreatedAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:00.000Z',
    exitedAt: '2026-10-01T00:05:00.000Z',
    exitCode: 0,
    toolBreakdown: [],
    ...overrides,
  };
}

const T0 = Date.parse('2026-10-12T09:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

/** The printed line of one record, by its 1-based position in the list. */
function lineOf(message: string | undefined, position: number): string {
  const line = (message ?? '').split('\n').find((candidate) => candidate.trimStart().startsWith(`#${position}:`));
  if (!line) throw new Error(`no line for record #${position} in:\n${message}`);
  return line;
}

/**
 * A main conversation resumed across three legs, with an isolated Code Review conversation that ran
 * between the second and the third. Cumulative readings: 1.85, 26.04, 30.84 and 3.00 (its own).
 */
const RESUMED_TASK_ROWS = [
  sessionRow({ id: 'leg-1', agent_session_id: 'main', started_at: at(0), suspended_at: at(60), total_cost_usd: 1.85, total_duration_ms: 722_000 }),
  sessionRow({ id: 'leg-2', agent_session_id: 'main', started_at: at(70), suspended_at: at(140), total_cost_usd: 26.04, total_duration_ms: 4_622_000 }),
  sessionRow({ id: 'review', agent_session_id: 'review', started_at: at(150), exited_at: at(170), total_cost_usd: 3.0, total_duration_ms: 1_440_000 }),
  sessionRow({ id: 'leg-3', agent_session_id: 'main', started_at: at(180), suspended_at: at(240), total_cost_usd: 30.84, total_duration_ms: 5_629_000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetById.mockReturnValue(TASK);
  mockGetSummaryForTask.mockReturnValue(makeSummary());
});

describe('handleListSessions per-leg shares', () => {
  it('prints each record\'s own share of the cost, and the shares add up to the task\'s total', async () => {
    const response = await handleListSessions({ taskId: TASK.id }, makeContext(RESUMED_TASK_ROWS));

    expect(response.success).toBe(true);
    const printed = (response.message ?? '').split('\n').filter((line) => line.includes('cost: $')).map((line) => Number(/cost: \$([\d.]+)/.exec(line)?.[1]));
    // leg-1, leg-2, review, leg-3: not the cumulative 1.85, 26.04, 3.00, 30.84.
    expect(printed).toHaveLength(4);
    expect(printed[0]).toBeCloseTo(1.85, 4);
    expect(printed[1]).toBeCloseTo(24.19, 4);
    expect(printed[2]).toBeCloseTo(3.0, 4);
    expect(printed[3]).toBeCloseTo(4.8, 4);
    expect(printed.reduce((sum, value) => sum + value, 0)).toBeCloseTo(33.84, 4);
  });

  it('carries the share as cost and durationMs, and the raw reading as cumulativeCost and cumulativeDurationMs', async () => {
    const response = await handleListSessions({ taskId: TASK.id }, makeContext(RESUMED_TASK_ROWS));
    const data = response.data as ListedSession[];

    expect(data.map((session) => session.id)).toEqual(['leg-1', 'leg-2', 'review', 'leg-3']);
    const costs = data.map((session) => session.cost ?? Number.NaN);
    expect(costs[0]).toBeCloseTo(1.85, 10);
    expect(costs[1]).toBeCloseTo(24.19, 10);
    expect(costs[2]).toBeCloseTo(3.0, 10);
    expect(costs[3]).toBeCloseTo(4.8, 10);
    expect(data.map((session) => session.cumulativeCost)).toEqual([1.85, 26.04, 3.0, 30.84]);
    expect(data.map((session) => session.durationMs)).toEqual([722_000, 3_900_000, 1_440_000, 1_007_000]);
    expect(data.map((session) => session.cumulativeDurationMs)).toEqual([722_000, 4_622_000, 1_440_000, 5_629_000]);
  });

  it('labels a leg\'s time "runtime", never "duration"', async () => {
    const response = await handleListSessions({ taskId: TASK.id }, makeContext(RESUMED_TASK_ROWS));

    expect(response.message).not.toContain('duration:');
    // leg-2's share is 3,900 s, not the 4,622 s cumulative reading.
    expect(lineOf(response.message, 2)).toContain('runtime: 3900s');
    expect(lineOf(response.message, 4)).toContain('runtime: 1007s');
  });

  it('gives a record with no cost no cost or runtime, and does not use it as the next leg\'s baseline', async () => {
    const rows = [
      sessionRow({ id: 'leg-a', agent_session_id: 'main', started_at: at(0), suspended_at: at(10), total_cost_usd: 2, total_duration_ms: 600_000 }),
      // Reported a runtime and no cost: the task summary skips it, so it has no share and no weight.
      sessionRow({ id: 'leg-b-no-cost', agent_session_id: 'main', started_at: at(20), suspended_at: at(30), total_cost_usd: null, total_duration_ms: 900_000 }),
      sessionRow({ id: 'leg-c', agent_session_id: 'main', started_at: at(40), suspended_at: at(50), total_cost_usd: 5, total_duration_ms: 1_000_000 }),
    ];
    const response = await handleListSessions({ taskId: TASK.id }, makeContext(rows));
    const [, noCost, next] = response.data as ListedSession[];

    expect(noCost.cost).toBeNull();
    expect(noCost.durationMs).toBeNull();
    // The raw reading is still reported beside the missing share.
    expect(noCost.cumulativeDurationMs).toBe(900_000);
    const noCostLine = lineOf(response.message, 2);
    expect(noCostLine).not.toContain('cost:');
    expect(noCostLine).not.toContain('runtime:');
    // 1,000,000 - 600,000, not 1,000,000 - 900,000.
    expect(next.durationMs).toBe(400_000);
    expect(next.cost).toBeCloseTo(3, 10);
  });
});

describe('handleGetTaskStats runtime label', () => {
  it('prints the task\'s agent time as "Agent runtime", not "Duration"', async () => {
    mockGetSummaryForTask.mockReturnValue(makeSummary({ durationMs: 125_000 }));

    const response = await handleGetTaskStats({ taskId: TASK.id }, makeContext());

    expect(response.success).toBe(true);
    expect(response.message).toContain('  Agent runtime: 125s');
    expect(response.message).not.toMatch(/duration/i);
  });
});
