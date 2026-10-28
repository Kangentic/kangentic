/**
 * The transcript path an agent reports is written to its session record as it
 * arrives, so the resume check still has it after a quit or a removal deletes
 * the session's own folder (which left most old conversations with no evidence).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';

const openDatabases = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../src/main/db/database', () => ({
  getOpenProjectDb: (projectId: string) => openDatabases.get(projectId) ?? null,
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => false,
}));

import { forgetTranscriptPath, persistTranscriptPath } from '../../src/main/ipc/handlers/session-transcript-path';

function openProjectDatabase(): Database.Database {
  const database = new Database(':memory:');
  runProjectMigrations(database);
  database.prepare(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'Executing', 0, '2026-01-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-1', 1, 'Task', '', 'lane-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  new SessionRepository(database).insert({
    id: 'session-1', task_id: 'task-1', session_type: 'claude_agent', isolated_swimlane_id: null,
    agent_session_id: 'agent-1', command: 'claude', cwd: '/mock/project', permission_mode: null, prompt: null,
    status: 'running', exit_code: null, started_at: '2026-01-01T00:00:00.000Z', suspended_at: null,
    exited_at: null, suspended_by: null,
  });
  return database;
}

function sessionManagerFor(session: { transient?: boolean; workflowId?: string | null } | null) {
  return {
    getSession: vi.fn(() => session),
    getSessionProjectId: vi.fn(() => 'project-1'),
  };
}

function readPath(database: Database.Database): string | null {
  return (database.prepare('SELECT transcript_path FROM sessions WHERE id = ?').get('session-1') as { transcript_path: string | null }).transcript_path;
}

describe('persistTranscriptPath', () => {
  let database: Database.Database;

  beforeEach(() => {
    database = openProjectDatabase();
    openDatabases.clear();
    openDatabases.set('project-1', database);
    forgetTranscriptPath('session-1');
  });

  it('writes the reported path to the session record', () => {
    const context = { sessionManager: sessionManagerFor({}) };
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/home/dev/.claude/projects/p/agent-1.jsonl' });
    expect(readPath(database)).toBe('/home/dev/.claude/projects/p/agent-1.jsonl');
  });

  it('writes once per change, not once per status tick', () => {
    const context = { sessionManager: sessionManagerFor({}) };
    const update = vi.spyOn(SessionRepository.prototype, 'setTranscriptPath');
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-2.jsonl' });
    expect(update).toHaveBeenCalledTimes(2);
    expect(readPath(database)).toBe('/a/agent-2.jsonl');
    update.mockRestore();
  });

  it('ignores a usage update with no path', () => {
    const context = { sessionManager: sessionManagerFor({}) };
    persistTranscriptPath(context as never, 'session-1', { contextWindow: {} });
    persistTranscriptPath(context as never, 'session-1', null);
    expect(readPath(database)).toBeNull();
  });

  it('skips a Command Terminal and a workflow agent, which have no record', () => {
    const update = vi.spyOn(SessionRepository.prototype, 'setTranscriptPath');
    persistTranscriptPath({ sessionManager: sessionManagerFor({ transient: true }) } as never, 'session-1', { transcriptPath: '/a/x.jsonl' });
    persistTranscriptPath({ sessionManager: sessionManagerFor({ workflowId: 'wf-1' }) } as never, 'session-1', { transcriptPath: '/a/x.jsonl' });
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it('tries again on the next tick when the record did not exist yet', () => {
    const context = { sessionManager: sessionManagerFor({}) };
    database.prepare('DELETE FROM sessions').run();
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    database.prepare(`INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at) VALUES ('session-1', 'task-1', 'claude_agent', 'claude', '/mock', 'running', '2026-01-01T00:00:00.000Z')`).run();
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    expect(readPath(database)).toBe('/a/agent-1.jsonl');
  });
});

describe('SessionRepository.insert: a resumed conversation starts with its reported path', () => {
  // Claude keeps appending a resumed conversation to the file it reported,
  // wherever the new session's cwd maps. The new row starts with that path, so
  // a read of the newest row (the turn end's reply) follows it from the first
  // turn, before the new session's own status line paints.
  function insertSession(database: Database.Database, id: string, agentSessionId: string | null, startedAt: string) {
    return new SessionRepository(database).insert({
      id, task_id: 'task-1', session_type: 'claude_agent', isolated_swimlane_id: null,
      agent_session_id: agentSessionId, command: 'claude', cwd: '/mock/project/.kangentic/worktrees/1', permission_mode: null,
      prompt: null, status: 'running', exit_code: null, started_at: startedAt, suspended_at: null,
      exited_at: null, suspended_by: null,
    });
  }

  function storedPath(database: Database.Database, id: string): string | null {
    return (database.prepare('SELECT transcript_path FROM sessions WHERE id = ?').get(id) as { transcript_path: string | null }).transcript_path;
  }

  it('carries the newest reported path of the same conversation', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    repository.setTranscriptPath('session-1', '/home/dev/.claude/projects/-mock-project/agent-1.jsonl');

    const resumed = insertSession(database, 'session-2', 'agent-1', '2026-01-02T00:00:00.000Z');

    expect(resumed.transcript_path).toBe('/home/dev/.claude/projects/-mock-project/agent-1.jsonl');
    expect(storedPath(database, 'session-2')).toBe('/home/dev/.claude/projects/-mock-project/agent-1.jsonl');
  });

  it('starts with no path for another conversation or a session with no agent id yet', () => {
    const database = openProjectDatabase();
    new SessionRepository(database).setTranscriptPath('session-1', '/home/dev/.claude/projects/-mock-project/agent-1.jsonl');

    expect(insertSession(database, 'session-2', 'agent-2', '2026-01-02T00:00:00.000Z').transcript_path).toBeNull();
    expect(insertSession(database, 'session-3', null, '2026-01-03T00:00:00.000Z').transcript_path).toBeNull();
    expect(storedPath(database, 'session-2')).toBeNull();
    expect(storedPath(database, 'session-3')).toBeNull();
  });

  it('skips a newer row that never reported a path', () => {
    const database = openProjectDatabase();
    new SessionRepository(database).setTranscriptPath('session-1', '/home/dev/.claude/projects/-mock-project/agent-1.jsonl');
    insertSession(database, 'session-2', 'agent-1', '2026-01-02T00:00:00.000Z');
    database.prepare('UPDATE sessions SET transcript_path = NULL WHERE id = ?').run('session-2');

    expect(insertSession(database, 'session-3', 'agent-1', '2026-01-03T00:00:00.000Z').transcript_path)
      .toBe('/home/dev/.claude/projects/-mock-project/agent-1.jsonl');
  });
});
