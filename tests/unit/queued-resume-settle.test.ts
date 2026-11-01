/**
 * A queued resume keeps its conversation. The record it resumed was retired when
 * it queued, so if it ends before it starts (a quit, a pause, a move) it is the
 * only record left that knows the way back. A task waiting its turn in a column
 * must come back to the same conversation after a relaunch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { isHeldPause } from '../../src/shared/held-pause';

vi.mock('../../src/main/browser/browser-lane-manager', () => ({ destroyLanesForSession: vi.fn() }));
vi.mock('../../src/main/browser/viewport-override', () => ({ releaseViewportOverridesForSession: vi.fn(async () => undefined) }));

const { settleQueuedRecord, markRecordExited } = await import('../../src/main/transition-engine/session-lifecycle');
const { resolveSpawnIntent } = await import('../../src/main/transition-engine/spawn-intent');

describe('settleQueuedRecord', () => {
  let database: DatabaseType.Database;
  let sessions: SessionRepository;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    sessions = new SessionRepository(database);
    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.role === null)!;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run('task-1', 'Task', '', lane.id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  });

  afterEach(() => database.close());

  function queuedRecord(agentSessionId: string | null): { id: string; agent_session_id: string | null } {
    database
      .prepare(`INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
        VALUES ('record-1', 'task-1', 'claude_agent', ?, 'claude', '/work', 'queued', '2026-01-01T00:00:00.000Z')`)
      .run(agentSessionId);
    return { id: 'record-1', agent_session_id: agentSessionId };
  }

  it('keeps a queued resume resumable through a quit', () => {
    settleQueuedRecord(sessions, queuedRecord('agent-conversation'), true, 'system');

    const [resumable] = sessions.getResumable();
    expect(resumable.agent_session_id).toBe('agent-conversation');
    // Not a hold: the next launch brings it back.
    expect(isHeldPause(resumable)).toBe(false);
  });

  it('exits a queued fresh start, which has nothing to resume', () => {
    settleQueuedRecord(sessions, queuedRecord(null), false, 'system');

    expect(sessions.getResumable()).toEqual([]);
    expect(sessions.findByAnyId('record-1')?.status).toBe('exited');
  });

  it('exits a fresh start that pre-assigned its agent session id, since nothing ran under it', () => {
    settleQueuedRecord(sessions, queuedRecord('pre-assigned-id'), false, 'system');

    expect(sessions.getResumable()).toEqual([]);
  });

  it('keeps a person\'s pause of a queued resume held', () => {
    settleQueuedRecord(sessions, queuedRecord('agent-conversation'), true, 'user');

    expect(isHeldPause(sessions.getResumable()[0])).toBe(true);
  });

  function nextSpawnFor(taskId: string) {
    return resolveSpawnIntent({
      taskId,
      sessionType: 'claude_agent',
      sessionRepo: sessions,
      promptTemplate: undefined,
      templateVars: {},
      resumePrompt: undefined,
    });
  }

  it('gives up the id of a fresh start that never ran, so the next spawn starts fresh', () => {
    settleQueuedRecord(sessions, queuedRecord('pre-assigned-id'), false, 'system');

    const settled = sessions.findByAnyId('record-1');
    expect(settled?.status).toBe('exited');
    expect(settled?.agent_session_id).toBeNull();
    // Left on an exited record, the id would be `--resume`d into "No conversation found".
    expect(nextSpawnFor('task-1')).toMatchObject({ mode: 'fresh', agentSessionId: null, retireRecordId: null });
  });

  it('keeps the conversation of a queued resume in a suspended record, so the next spawn resumes it', () => {
    settleQueuedRecord(sessions, queuedRecord('agent-conversation'), true, 'system');

    const settled = sessions.findByAnyId('record-1');
    expect(settled?.status).toBe('suspended');
    expect(settled?.agent_session_id).toBe('agent-conversation');
    expect(nextSpawnFor('task-1')).toMatchObject({ mode: 'resume', agentSessionId: 'agent-conversation', retireRecordId: 'record-1' });
  });

  it('exits a queued record with no id when the resume has none to keep', () => {
    settleQueuedRecord(sessions, queuedRecord(null), true, 'system');

    expect(sessions.findByAnyId('record-1')?.status).toBe('exited');
  });
});

describe('markRecordExited', () => {
  let database: DatabaseType.Database;
  let sessions: SessionRepository;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    sessions = new SessionRepository(database);
    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.role === null)!;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run('task-1', 'Task', '', lane.id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    database
      .prepare(`INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
        VALUES ('record-1', 'task-1', 'claude_agent', 'agent-conversation', 'claude', '/work', 'queued', '2026-01-01T00:00:00.000Z')`)
      .run();
  });

  afterEach(() => database.close());

  it('keeps the agent session id when asked for nothing more, as a kill of a queued resume exits it', () => {
    expect(markRecordExited(sessions, 'record-1')).toBe(true);

    const exited = sessions.findByAnyId('record-1');
    expect(exited?.status).toBe('exited');
    expect(exited?.agent_session_id).toBe('agent-conversation');
    expect(exited?.exited_at).toEqual(expect.any(String));
  });

  it('leaves an exited record that keeps its id resumable, which is why a fresh start must give it up', () => {
    markRecordExited(sessions, 'record-1');

    const intent = resolveSpawnIntent({
      taskId: 'task-1',
      sessionType: 'claude_agent',
      sessionRepo: sessions,
      promptTemplate: undefined,
      templateVars: {},
      resumePrompt: undefined,
    });
    expect(intent).toMatchObject({ mode: 'resume', agentSessionId: 'agent-conversation' });
  });

  it('gives the id up only when the caller says so', () => {
    expect(markRecordExited(sessions, 'record-1', { agent_session_id: null })).toBe(true);

    expect(sessions.findByAnyId('record-1')?.agent_session_id).toBeNull();
  });

  it('never overwrites a suspended record', () => {
    sessions.compareAndUpdateStatus('record-1', 'queued', 'suspended');

    expect(markRecordExited(sessions, 'record-1', { agent_session_id: null })).toBe(false);

    const untouched = sessions.findByAnyId('record-1');
    expect(untouched?.status).toBe('suspended');
    expect(untouched?.agent_session_id).toBe('agent-conversation');
  });
});
