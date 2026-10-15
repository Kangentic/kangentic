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
