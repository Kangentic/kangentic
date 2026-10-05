/**
 * Real-DB tests for the session-track reads behind the context bar's tool-call
 * pill and popover: `SessionRepository.listEarlierRunRecords` /
 * `getEarlierRunToolTotals`, and `mergeTranscriptResultTokens`, the write the
 * earlier-run Tokens fill and the run-end refine share.
 *
 * Every resume (an app restart, a pause and resume) is a new session record
 * holding only its own run, so a resumed session's totals are its track's
 * earlier records plus the live run. These pin which records count:
 *   - the same task and isolated swimlane (null = the main session), any agent;
 *   - never the live record itself, whose stored count is a snapshot of the
 *     live accumulator and would otherwise count twice.
 *
 * Uses an in-memory better-sqlite3 database migrated by runProjectMigrations,
 * as session-repository-summaries.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import {
  insertSessionRecord,
  insertTask,
  openMigratedProjectDatabase,
  readStoredToolRows,
} from './helpers/earlier-run-fixture';
import type { SessionRecordFixture } from './helpers/earlier-run-fixture';

/** Every record here names its task: the suite seeds two. */
type RecordFixture = SessionRecordFixture & { taskId: string };

describe('SessionRepository earlier runs of a session track (real DB)', () => {
  let db: Database.Database;
  let repository: SessionRepository;

  /**
   * The shared insert with this suite's defaults: a Claude record whose conversation is its
   * own (`agent-<id>`), and a stored count that is exactly what the fixture states, never one
   * derived from its rows, so a record can carry a count with no rows or rows that disagree.
   */
  function insertRecord(fixture: RecordFixture): void {
    insertSessionRecord(db, {
      ...fixture,
      sessionType: fixture.sessionType ?? 'claude_agent',
      agentSessionId: fixture.agentSessionId === undefined ? `agent-${fixture.id}` : fixture.agentSessionId,
      toolCallCount: fixture.toolCallCount ?? null,
    });
  }

  beforeEach(() => {
    db = openMigratedProjectDatabase();
    repository = new SessionRepository(db);
    insertTask(db, 'task-a');
    insertTask(db, 'task-b');
  });

  afterEach(() => {
    db?.close();
  });

  /**
   * task-a's main track: two runs that ended (the second at an app quit) and
   * the live one. Its isolated Code Review track has a run of its own.
   * task-b has a run on its main track.
   */
  function seedTracks(): void {
    insertRecord({
      id: 'main-run-1',
      taskId: 'task-a',
      startedAt: '2026-10-05T08:00:00.000Z',
      toolCallCount: 30,
      toolBreakdown: [
        { toolName: 'Read', callCount: 20, totalDurationMs: 3000, interruptedCount: 0, resultTokens: 40_000 },
        { toolName: 'Bash', callCount: 10, totalDurationMs: 9000, interruptedCount: 1 },
      ],
    });
    insertRecord({
      id: 'main-run-2',
      taskId: 'task-a',
      // An agent switch on the same track still counts toward the task's total.
      sessionType: 'codex_agent',
      startedAt: '2026-10-05T09:00:00.000Z',
      toolCallCount: 6,
      toolBreakdown: [{ toolName: 'Read', callCount: 6, totalDurationMs: 1400, interruptedCount: 0 }],
    });
    insertRecord({
      id: 'main-live',
      taskId: 'task-a',
      startedAt: '2026-10-05T10:00:00.000Z',
      // The snapshot timer's copy of the live accumulator.
      toolCallCount: 4,
      toolBreakdown: [{ toolName: 'Grep', callCount: 4, totalDurationMs: 100, interruptedCount: 0 }],
    });
    insertRecord({
      id: 'review-run-1',
      taskId: 'task-a',
      isolatedSwimlaneId: 'lane-code-review',
      startedAt: '2026-10-05T09:30:00.000Z',
      toolCallCount: 12,
      toolBreakdown: [{ toolName: 'Grep', callCount: 12, totalDurationMs: 600, interruptedCount: 0 }],
    });
    insertRecord({
      id: 'other-task-run',
      taskId: 'task-b',
      startedAt: '2026-10-05T07:00:00.000Z',
      toolCallCount: 99,
      toolBreakdown: [{ toolName: 'Read', callCount: 99, totalDurationMs: 1, interruptedCount: 0 }],
    });
  }

  it('lists the track\'s other records oldest first, never the live one', () => {
    seedTracks();

    const records = repository.listEarlierRunRecords('task-a', null, 'main-live');

    expect(records.map((record) => record.id)).toEqual(['main-run-1', 'main-run-2']);
  });

  it('sums the earlier runs of the main track, across agents, by tool name', () => {
    seedTracks();

    const totals = repository.getEarlierRunToolTotals('task-a', null, 'main-live');

    expect(totals.toolCallCount).toBe(36);
    expect(totals.toolBreakdown).toEqual([
      { toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0, resultTokens: 40_000 },
      { toolName: 'Bash', callCount: 10, totalDurationMs: 9000, interruptedCount: 1 },
    ]);
  });

  it('keeps an isolated track separate from the main track, in both directions', () => {
    seedTracks();
    insertRecord({
      id: 'review-live',
      taskId: 'task-a',
      isolatedSwimlaneId: 'lane-code-review',
      startedAt: '2026-10-05T11:00:00.000Z',
    });

    const review = repository.getEarlierRunToolTotals('task-a', 'lane-code-review', 'review-live');
    const main = repository.getEarlierRunToolTotals('task-a', null, 'main-live');

    expect(review.toolCallCount).toBe(12);
    expect(review.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Grep']);
    // The main track's earlier runs carry no Grep: review-run-1 stayed on its own track.
    expect(main.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Read', 'Bash']);
  });

  it('returns zero for a session with no earlier run', () => {
    insertRecord({ id: 'first-run', taskId: 'task-a', startedAt: '2026-10-05T08:00:00.000Z', toolCallCount: 3 });

    expect(repository.getEarlierRunToolTotals('task-a', null, 'first-run')).toEqual({ toolCallCount: 0, toolBreakdown: [] });
  });

  it('tolerates a NULL count and a malformed breakdown on an earlier record', () => {
    insertRecord({ id: 'never-measured', taskId: 'task-a', startedAt: '2026-10-05T07:00:00.000Z', toolCallCount: null });
    insertRecord({
      id: 'corrupt',
      taskId: 'task-a',
      startedAt: '2026-10-05T07:30:00.000Z',
      toolCallCount: 2,
      toolBreakdown: '{not json',
    });
    insertRecord({
      id: 'measured',
      taskId: 'task-a',
      startedAt: '2026-10-05T08:00:00.000Z',
      toolCallCount: 5,
      toolBreakdown: [{ toolName: 'Edit', callCount: 5, totalDurationMs: 50, interruptedCount: 0 }],
    });
    insertRecord({ id: 'live', taskId: 'task-a', startedAt: '2026-10-05T09:00:00.000Z' });

    const totals = repository.getEarlierRunToolTotals('task-a', null, 'live');

    expect(totals.toolCallCount).toBe(7);
    expect(totals.toolBreakdown).toEqual([{ toolName: 'Edit', callCount: 5, totalDurationMs: 50, interruptedCount: 0 }]);
  });

  describe('hasEarlierRecordOfConversation', () => {
    // Gates the run-end count backfill for an agent that cannot scope a
    // transcript read: only a conversation's first run may take its whole count.
    beforeEach(() => {
      insertRecord({ id: 'first-run', taskId: 'task-a', agentSessionId: 'conversation-1', startedAt: '2026-10-05T08:00:00.000Z' });
      insertRecord({ id: 'resumed-run', taskId: 'task-a', agentSessionId: 'conversation-1', startedAt: '2026-10-05T09:00:00.000Z' });
      insertRecord({ id: 'fresh-run', taskId: 'task-a', agentSessionId: 'conversation-2', startedAt: '2026-10-05T10:00:00.000Z' });
    });

    it('is true for a resume of the conversation', () => {
      expect(repository.hasEarlierRecordOfConversation('resumed-run', 'conversation-1')).toBe(true);
    });

    it('is false for the conversation\'s first run, even though a later run shares it', () => {
      expect(repository.hasEarlierRecordOfConversation('first-run', 'conversation-1')).toBe(false);
    });

    it('is false for a fresh conversation after another one on the same task', () => {
      expect(repository.hasEarlierRecordOfConversation('fresh-run', 'conversation-2')).toBe(false);
    });
  });

  it('markResultTokensRead stamps a UTC ISO time on that record only', () => {
    insertRecord({ id: 'read-run', taskId: 'task-a', startedAt: '2026-10-05T08:00:00.000Z' });
    insertRecord({ id: 'other-run', taskId: 'task-a', startedAt: '2026-10-05T09:00:00.000Z' });

    repository.markResultTokensRead('read-run');

    const readAt = repository.findByAnyId('read-run')?.result_tokens_read_at;
    expect(readAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(repository.findByAnyId('other-run')?.result_tokens_read_at).toBeNull();
  });

  describe('mergeTranscriptResultTokens', () => {
    beforeEach(() => {
      insertRecord({
        id: 'quit-ended',
        taskId: 'task-a',
        startedAt: '2026-10-05T08:00:00.000Z',
        toolCallCount: 27,
        toolBreakdown: [
          { toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0, waitedCount: 1 },
          { toolName: 'constructor', callCount: 1, totalDurationMs: 10, interruptedCount: 0 },
        ],
      });
    });

    it('writes the estimates onto the stored rows and touches nothing else', () => {
      const changed = repository.mergeTranscriptResultTokens('quit-ended', { Read: 57_900, Grep: 13_700 });

      expect(changed).toBe(true);
      expect(readStoredToolRows(db, 'quit-ended')).toEqual([
        { toolName: 'Read', callCount: 26, totalDurationMs: 4400, interruptedCount: 0, waitedCount: 1, resultTokens: 57_900 },
        { toolName: 'constructor', callCount: 1, totalDurationMs: 10, interruptedCount: 0 },
      ]);
      const counts = db.prepare('SELECT tool_call_count FROM sessions WHERE id = ?').get('quit-ended') as { tool_call_count: number };
      expect(counts.tool_call_count).toBe(27);
    });

    it('sets rather than adds, so a second writer of the same run cannot double it', () => {
      repository.mergeTranscriptResultTokens('quit-ended', { Read: 57_900 });
      const changedAgain = repository.mergeTranscriptResultTokens('quit-ended', { Read: 57_900 });

      expect(changedAgain).toBe(false);
      expect(readStoredToolRows(db, 'quit-ended')[0].resultTokens).toBe(57_900);
    });

    it('reports no change for an empty estimate set', () => {
      expect(repository.mergeTranscriptResultTokens('quit-ended', {})).toBe(false);
    });
  });
});
