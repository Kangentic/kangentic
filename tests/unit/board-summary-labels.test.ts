/**
 * Unit tests for the label-vocabulary block kangentic_board_summary reports.
 *
 * The gap this closes: an agent about to label a task had no way to ask what
 * labels the board already uses, so it invented a fresh one and fragmented the
 * vocabulary over time. board_summary already loaded every label-bearing
 * source, so the answer cost no new query and no new tool.
 *
 * Two layers are covered: the pure tally/format pair (exhaustively), and one
 * handler-level test proving all three sources are actually wired in - a tally
 * that is correct but fed only active tasks would pass every pure test and
 * still report a vocabulary that barely exists on a mature board.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted repository mocks - registered before the import under test so no
// better-sqlite3 binary is needed. Mirrors mcp-create-task-labels.test.ts.
// ---------------------------------------------------------------------------

const mockTaskList = vi.fn();
const mockTaskListArchived = vi.fn();
const mockSwimlaneList = vi.fn();
const mockBacklogList = vi.fn();
const mockSessionListAllSummaries = vi.fn();

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    list = mockTaskList;
    listArchived = mockTaskListArchived;
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list = mockSwimlaneList; },
}));
vi.mock('../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class { list = mockBacklogList; },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class { listAllSummaries = mockSessionListAllSummaries; },
}));

import {
  handleBoardSummary,
  tallyLabelUsage,
  formatLabelVocabulary,
} from '../../src/main/agent/commands/analytics-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// tallyLabelUsage
// ---------------------------------------------------------------------------

describe('tallyLabelUsage', () => {
  it('counts label uses, not items', () => {
    const { counts } = tallyLabelUsage([['a', 'b'], ['a'], ['a', 'c']]);
    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBe(1);
  });

  it('counts labelled ITEMS separately, so a multi-label item counts once', () => {
    // The two figures measure different things and the summary prints both;
    // conflating them makes the numbers fail to reconcile for a reader.
    const { counts, labelledItems } = tallyLabelUsage([['a', 'b', 'c'], ['a']]);
    expect(labelledItems).toBe(2);
    expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(4);
  });

  it('ignores items with no labels, and null/undefined lists', () => {
    const { counts, labelledItems } = tallyLabelUsage([[], null, undefined, ['a']]);
    expect(labelledItems).toBe(1);
    expect(counts.size).toBe(1);
  });

  it('returns an empty tally for no items at all', () => {
    const { counts, labelledItems } = tallyLabelUsage([]);
    expect(counts.size).toBe(0);
    expect(labelledItems).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatLabelVocabulary
// ---------------------------------------------------------------------------

describe('formatLabelVocabulary', () => {
  it('says so explicitly when there are no labels', () => {
    // "none yet" rather than an omitted block: the agent must be able to tell
    // an empty vocabulary from a missing feature.
    expect(formatLabelVocabulary(new Map(), 0)).toEqual(['Labels in use: none yet.']);
  });

  it('orders by count descending', () => {
    const text = formatLabelVocabulary(new Map([['rare', 1], ['common', 9], ['mid', 4]]), 14).join('\n');
    expect(text.indexOf('common')).toBeLessThan(text.indexOf('mid'));
    expect(text.indexOf('mid')).toBeLessThan(text.indexOf('rare'));
  });

  it('breaks count ties alphabetically so output is stable across calls', () => {
    const text = formatLabelVocabulary(new Map([['zebra', 2], ['alpha', 2]]), 4).join('\n');
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zebra'));
  });

  it('reports the distinct count and the labelled-item count', () => {
    const [header] = formatLabelVocabulary(new Map([['a', 3], ['b', 1]]), 3);
    expect(header).toBe('Labels in use (2 distinct, 3 labelled items):');
  });

  it('singularizes a single labelled item', () => {
    const [header] = formatLabelVocabulary(new Map([['a', 1]]), 1);
    expect(header).toContain('1 labelled item)');
  });

  it('renders each label with its count', () => {
    expect(formatLabelVocabulary(new Map([['terminal', 41]]), 41).join('\n')).toContain('terminal (41)');
  });

  it('caps the list and reports how many were omitted', () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 45; index++) counts.set(`label-${index}`, 45 - index);
    const lines = formatLabelVocabulary(counts, 45);
    expect(lines.join('\n')).toContain('... and 15 more');
    // The 30 kept are the most-used ones, not an arbitrary slice.
    expect(lines.join('\n')).toContain('label-0 (45)');
    expect(lines.join('\n')).not.toContain('label-44');
  });

  it('adds no "and N more" line when everything fits', () => {
    expect(formatLabelVocabulary(new Map([['a', 1]]), 1).join('\n')).not.toContain('more');
  });

  it('wraps a wide vocabulary instead of emitting one enormous line', () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 20; index++) counts.set(`a-fairly-long-label-${index}`, 1);
    const lines = formatLabelVocabulary(counts, 20);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(110);
  });
});

// ---------------------------------------------------------------------------
// handleBoardSummary wiring
// ---------------------------------------------------------------------------

function makeContext(): CommandContext {
  return { getProjectDb: vi.fn(() => ({}) as never) } as unknown as CommandContext;
}

describe('handleBoardSummary - label vocabulary wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwimlaneList.mockReturnValue([{ id: 'lane-1', name: 'To Do', role: 'todo', is_archived: 0 }]);
    mockSessionListAllSummaries.mockReturnValue({});
  });

  it('counts labels across active tasks, archived tasks, AND backlog items', () => {
    // The load-bearing case: on a mature board most of the vocabulary lives in
    // Done, so an active-only tally would under-report it badly.
    mockTaskList.mockReturnValue([{ id: 't1', session_id: null, labels: ['mcp', 'ui'] }]);
    mockTaskListArchived.mockReturnValue([{ id: 't2', labels: ['mcp'] }, { id: 't3', labels: ['mcp'] }]);
    mockBacklogList.mockReturnValue([{ id: 'b1', labels: ['ui'] }]);

    const result = handleBoardSummary({}, makeContext());

    expect(result.success).toBe(true);
    expect(result.message).toContain('Labels in use (2 distinct, 4 labelled items):');
    expect(result.message).toContain('mcp (3)');
    expect(result.message).toContain('ui (2)');
  });

  it('reports the empty vocabulary rather than omitting the block', () => {
    mockTaskList.mockReturnValue([{ id: 't1', session_id: null, labels: [] }]);
    mockTaskListArchived.mockReturnValue([]);
    mockBacklogList.mockReturnValue([]);

    const result = handleBoardSummary({}, makeContext());

    expect(result.message).toContain('Labels in use: none yet.');
  });

  it('exposes the tally as structured data, ordered like the message', () => {
    mockTaskList.mockReturnValue([{ id: 't1', session_id: null, labels: ['ui'] }]);
    mockTaskListArchived.mockReturnValue([{ id: 't2', labels: ['mcp'] }, { id: 't3', labels: ['mcp'] }]);
    mockBacklogList.mockReturnValue([]);

    const result = handleBoardSummary({}, makeContext());

    expect((result.data as { labels: Array<{ name: string; count: number }> }).labels).toEqual([
      { name: 'mcp', count: 2 },
      { name: 'ui', count: 1 },
    ]);
  });

  it('still reports the pre-existing column and task counts', () => {
    // Guard against the label block displacing what the summary already said.
    mockTaskList.mockReturnValue([{ id: 't1', session_id: 's1', labels: ['mcp'] }]);
    mockTaskListArchived.mockReturnValue([]);
    mockBacklogList.mockReturnValue([]);

    const result = handleBoardSummary({}, makeContext());

    expect(result.message).toContain('To Do: 1 task(s) (1 active session)');
    expect(result.message).toContain('Active tasks: 1');
    expect(result.message).toContain('Active sessions: 1');
  });
});
