/**
 * The session reads behind a return recap (task #952): the start HEAD an
 * isolated column's session records on insert, the migration that adds its
 * column, and `listIsolatedSince`, which finds every isolated session that ran
 * while the task's main conversation was away. Real SQLite, migrated by
 * runProjectMigrations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

describe('SessionRepository isolated runs since the main conversation left (real DB)', () => {
  let db: Database.Database;
  let repository: SessionRepository;

  function insert(id: string, isolatedSwimlaneId: string | null, startedAt: string, startHeadSha?: string | null, taskId = 'task-a'): void {
    repository.insert({
      id,
      task_id: taskId,
      session_type: 'claude_agent',
      isolated_swimlane_id: isolatedSwimlaneId,
      agent_session_id: `agent-${id}`,
      command: 'claude',
      cwd: '/mock/worktree',
      permission_mode: null,
      prompt: null,
      status: 'exited',
      exit_code: null,
      started_at: startedAt,
      suspended_at: null,
      exited_at: null,
      suspended_by: null,
      ...(startHeadSha !== undefined ? { start_head_sha: startHeadSha } : {}),
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

  it('stores the start HEAD it is given, and NULL when it is given none', () => {
    insert('review', 'lane-review', '2026-10-31T02:01:00.000Z', 'abc1234');
    insert('main', null, '2026-10-31T01:00:00.000Z');
    const read = (id: string) => (db.prepare('SELECT start_head_sha FROM sessions WHERE id = ?').get(id) as { start_head_sha: string | null }).start_head_sha;
    expect(read('review')).toBe('abc1234');
    expect(read('main')).toBeNull();
  });

  it('lists the task\'s isolated sessions started at or after the time, oldest first', () => {
    insert('main-before', null, '2026-10-31T01:00:00.000Z');
    insert('review-old', 'lane-review', '2026-10-30T23:00:00.000Z', 'old0001');
    insert('review-1', 'lane-review', '2026-10-31T02:00:00.000Z', 'abc0001');
    insert('docs', 'lane-docs', '2026-10-31T02:30:00.000Z', null);
    insert('review-2', 'lane-review', '2026-10-31T03:00:00.000Z', 'abc0002');
    insert('main-after', null, '2026-10-31T03:30:00.000Z');
    insert('other-task', 'lane-review', '2026-10-31T02:10:00.000Z', 'zzz0001', 'task-b');

    const runs = repository.listIsolatedSince('task-a', '2026-10-31T02:00:00.000Z');

    expect(runs.map((run) => run.id)).toEqual(['review-1', 'docs', 'review-2']);
    expect(runs[0]).toEqual({
      id: 'review-1',
      isolated_swimlane_id: 'lane-review',
      agent_session_id: 'agent-review-1',
      start_head_sha: 'abc0001',
      started_at: '2026-10-31T02:00:00.000Z',
    });
  });

  it('adds the column once: running the migrations again changes nothing', () => {
    insert('review', 'lane-review', '2026-10-31T02:01:00.000Z', 'abc1234');
    expect(() => runProjectMigrations(db)).not.toThrow();
    const columns = (db.pragma('table_info(sessions)') as Array<{ name: string }>).filter((column) => column.name === 'start_head_sha');
    expect(columns).toHaveLength(1);
    expect(repository.listIsolatedSince('task-a', '2026-10-31T00:00:00.000Z')[0].start_head_sha).toBe('abc1234');
  });
});
