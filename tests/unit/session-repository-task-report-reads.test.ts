/**
 * Real-DB tests for the two session reads behind the completed task view
 * (`src/main/ipc/helpers/task-report.ts`):
 *   - `listTaskReportRecords`, every record of the task with only the columns
 *     `assembleTaskReport` reads. The report reads every record of the task, so
 *     the large text columns (`prompt`, `command`) stay out of it;
 *   - `getLatestAgentSessionForTask`, the one record the last-message read
 *     needs: the newest that names an agent conversation.
 *
 * Uses an in-memory better-sqlite3 database migrated by runProjectMigrations,
 * as session-repository-earlier-runs.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { insertSessionRecord, insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

describe('SessionRepository reads for the completed task report (real DB)', () => {
  let db: Database.Database;
  let repository: SessionRepository;

  beforeEach(() => {
    db = openMigratedProjectDatabase();
    repository = new SessionRepository(db);
    insertTask(db, 'task-a');
    insertTask(db, 'task-b');
  });

  afterEach(() => {
    db?.close();
  });

  describe('listTaskReportRecords', () => {
    it('returns only the task\'s records, newest first', () => {
      insertSessionRecord(db, { id: 'older', taskId: 'task-a', startedAt: '2026-10-05T08:00:00.000Z' });
      insertSessionRecord(db, { id: 'newer', taskId: 'task-a', startedAt: '2026-10-05T09:00:00.000Z' });
      insertSessionRecord(db, { id: 'other-task', taskId: 'task-b', startedAt: '2026-10-05T10:00:00.000Z' });

      expect(repository.listTaskReportRecords('task-a').map((record) => record.id)).toEqual(['newer', 'older']);
    });

    it('leaves out the prompt and the command', () => {
      insertSessionRecord(db, { id: 'with-prompt', taskId: 'task-a', startedAt: '2026-10-05T08:00:00.000Z' });
      db.prepare('UPDATE sessions SET prompt = ? WHERE id = ?').run('A long task prompt.', 'with-prompt');

      const [record] = repository.listTaskReportRecords('task-a');

      expect(record.id).toBe('with-prompt');
      expect(Object.keys(record)).not.toContain('prompt');
      expect(Object.keys(record)).not.toContain('command');
      expect(Object.keys(record)).not.toContain('cwd');
    });

    it('returns exactly the columns the report reads', () => {
      insertSessionRecord(db, { id: 'one-record', taskId: 'task-a', startedAt: '2026-10-05T08:00:00.000Z' });

      const [record] = repository.listTaskReportRecords('task-a');

      // The result is cast to TaskReportSessionRecord, so tsc cannot see a column dropped from
      // the SELECT. better-sqlite3 returns a key for every selected column, null or not.
      expect(Object.keys(record).sort()).toEqual([
        'agent_session_id',
        'applied_effort',
        'compaction_count',
        'exit_code',
        'exited_at',
        'id',
        'isolated_swimlane_id',
        'model_display_name',
        'model_id',
        'permission_mode',
        'session_type',
        'started_at',
        'suspended_at',
        'tool_breakdown',
        'tool_call_count',
        'total_cost_usd',
        'total_duration_ms',
        'total_input_tokens',
        'total_output_tokens',
      ]);
    });

    it('lists records that start at the same instant by id, greater first, even when the lesser id was inserted first', () => {
      // The lesser id goes in first, so a sort on the start time alone would leave it ahead.
      insertSessionRecord(db, { id: 'record-a', taskId: 'task-a', startedAt: '2026-10-05T08:00:00.000Z' });
      insertSessionRecord(db, { id: 'record-b', taskId: 'task-a', startedAt: '2026-10-05T08:00:00.000Z' });

      expect(repository.listTaskReportRecords('task-a').map((record) => record.id)).toEqual(['record-b', 'record-a']);
    });

    it('returns an empty list for a task with no records', () => {
      expect(repository.listTaskReportRecords('task-a')).toEqual([]);
    });
  });

  describe('getLatestAgentSessionForTask', () => {
    it('passes over a newer record that names no conversation', () => {
      insertSessionRecord(db, { id: 'oldest', taskId: 'task-a', agentSessionId: 'conversation-a', sessionType: 'claude', cwd: '/mock/oldest', startedAt: '2026-10-05T08:00:00.000Z' });
      insertSessionRecord(db, { id: 'second', taskId: 'task-a', agentSessionId: 'conversation-b', sessionType: 'codex', cwd: '/mock/second', startedAt: '2026-10-05T09:00:00.000Z' });
      insertSessionRecord(db, { id: 'newest', taskId: 'task-a', agentSessionId: null, sessionType: 'claude', cwd: '/mock/newest', startedAt: '2026-10-05T10:00:00.000Z' });

      expect(repository.getLatestAgentSessionForTask('task-a')).toEqual({
        session_type: 'codex',
        agent_session_id: 'conversation-b',
        cwd: '/mock/second',
      });
    });

    it('breaks a tie on the start time by taking the greater id, even when the lesser id was inserted first', () => {
      // The lesser id goes in first: SQLite settles a tie in storage order, so a sort on the
      // start time alone would return it, and only the id tie-break returns the other record.
      insertSessionRecord(db, { id: 'record-a', taskId: 'task-a', agentSessionId: 'conversation-a', cwd: '/mock/record-a', startedAt: '2026-10-05T08:00:00.000Z' });
      insertSessionRecord(db, { id: 'record-b', taskId: 'task-a', agentSessionId: 'conversation-b', cwd: '/mock/record-b', startedAt: '2026-10-05T08:00:00.000Z' });

      expect(repository.getLatestAgentSessionForTask('task-a')).toEqual({
        session_type: 'stub_agent',
        agent_session_id: 'conversation-b',
        cwd: '/mock/record-b',
      });
    });

    it('returns undefined when no record of the task names a conversation', () => {
      insertSessionRecord(db, { id: 'no-conversation', taskId: 'task-a', agentSessionId: null, startedAt: '2026-10-05T08:00:00.000Z' });

      expect(repository.getLatestAgentSessionForTask('task-a')).toBeUndefined();
    });

    it('stays within its task', () => {
      insertSessionRecord(db, { id: 'own', taskId: 'task-a', agentSessionId: 'conversation-a', startedAt: '2026-10-05T08:00:00.000Z' });
      insertSessionRecord(db, { id: 'other', taskId: 'task-b', agentSessionId: 'conversation-b', startedAt: '2026-10-05T09:00:00.000Z' });

      expect(repository.getLatestAgentSessionForTask('task-a')?.agent_session_id).toBe('conversation-a');
    });
  });
});
