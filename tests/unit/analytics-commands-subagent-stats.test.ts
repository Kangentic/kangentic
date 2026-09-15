/**
 * `handleGetTaskStats`'s subagent breakdown (src/main/agent/commands/analytics-commands.ts,
 * the `bySubagentType` block).
 *
 * The single-task branch folds `ConversationUsageStore.getSubagentTotalsByType(null, null,
 * taskId)` into `data.bySubagentType` and, only when the task actually has subagent turns,
 * appends a `Subagents: ...` summary line plus one per-type line to the rendered message. A
 * task with no subagent rows must render neither line - the block must be fully omitted, not
 * printed with zeroes.
 *
 * Mocking the repositories mirrors board-profile-commands.test.ts / inventory-commands-list-
 * tasks.test.ts: no better-sqlite3 binary is needed (it is built for Electron's Node ABI and
 * will not load under vitest), and `ConversationUsageStore` is instantiated directly inside the
 * handler (not routed through `CommandContext`), so it is mocked the same way as the repository
 * classes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { SessionSummary, SubagentUsageTotals } from '../../src/shared/types';

const { mockGetById, mockGetSummaryForTask, mockGetSubagentTotalsByType } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockGetSummaryForTask: vi.fn(),
  mockGetSubagentTotalsByType: vi.fn(),
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

vi.mock('../../src/main/retrieval/conversation/conversation-usage-store', () => ({
  ConversationUsageStore: class {
    getSubagentTotalsByType = mockGetSubagentTotalsByType;
  },
}));

import { handleGetTaskStats } from '../../src/main/agent/commands/analytics-commands';

const TASK = { id: 'task-uuid-1', title: 'Fix the flaky test', display_id: 42 };

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    totalCostUsd: 1.2345,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    modelDisplayName: 'Sonnet 5',
    durationMs: 60000,
    toolCallCount: 12,
    compactionCount: 0,
    linesAdded: 10,
    linesRemoved: 3,
    filesChanged: 2,
    taskCreatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0,
    toolBreakdown: [],
    ...overrides,
  };
}

function makeContext(): CommandContext {
  return { getProjectDb: vi.fn(() => ({}) as never) } as unknown as CommandContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetById.mockReturnValue(TASK);
  mockGetSummaryForTask.mockReturnValue(makeSummary());
});

describe('handleGetTaskStats subagent breakdown', () => {
  it('folds bySubagentType into data and renders a summary line plus per-type lines when the task has subagent rows', () => {
    const rows: SubagentUsageTotals[] = [
      { agentType: 'review-finder', inputTokens: 400, outputTokens: 800, cacheCreationTokens: 10, cacheReadTokens: 5000, turnCount: 7, subagentCount: 2 },
      { agentType: 'test-builder', inputTokens: 50, outputTokens: 60, cacheCreationTokens: 0, cacheReadTokens: 300, turnCount: 3, subagentCount: 1 },
    ];
    mockGetSubagentTotalsByType.mockReturnValue(rows);

    const response = handleGetTaskStats({ taskId: TASK.id }, makeContext());

    expect(response.success).toBe(true);
    expect(mockGetSubagentTotalsByType).toHaveBeenCalledWith(null, null, TASK.id);
    const data = response.data as { bySubagentType: SubagentUsageTotals[] };
    expect(data.bySubagentType).toEqual(rows);

    // subagentCount summed (2 + 1 = 3) across turnCount summed (7 + 3 = 10).
    expect(response.message).toContain('Subagents: 3 across 10 turn(s)');
    expect(response.message).toContain('review-finder');
    expect(response.message).toContain('test-builder');
  });

  it('omits the subagent block entirely for a task with zero subagent rows', () => {
    mockGetSubagentTotalsByType.mockReturnValue([]);

    const response = handleGetTaskStats({ taskId: TASK.id }, makeContext());

    expect(response.success).toBe(true);
    const data = response.data as { bySubagentType: SubagentUsageTotals[] };
    expect(data.bySubagentType).toEqual([]);
    expect(response.message).not.toContain('Subagents:');
  });
});
