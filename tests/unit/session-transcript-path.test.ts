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
const shutdownState = vi.hoisted(() => ({ shuttingDown: false }));

vi.mock('../../src/main/db/database', () => ({
  getOpenProjectDb: (projectId: string) => openDatabases.get(projectId) ?? null,
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: () => shutdownState.shuttingDown,
}));

import { forgetTranscriptPath, persistHookTranscriptPath, persistTranscriptPath } from '../../src/main/ipc/handlers/session-transcript-path';

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
    shutdownState.shuttingDown = false;
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

  // The two early returns below drop a tick and remember nothing, as the missing
  // row above does. A dropped tick that was remembered as written would leave the
  // row empty for the rest of the session, since the same path never writes twice.
  it('tries again on the next tick after one that arrived during a shutdown', () => {
    const context = { sessionManager: sessionManagerFor({}) };
    shutdownState.shuttingDown = true;
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    expect(readPath(database)).toBeNull();

    shutdownState.shuttingDown = false;
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    expect(readPath(database)).toBe('/a/agent-1.jsonl');
  });

  it('tries again on the next tick after one that found the project database not open', () => {
    const context = { sessionManager: sessionManagerFor({}) };
    openDatabases.clear();
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    expect(readPath(database)).toBeNull();

    openDatabases.set('project-1', database);
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/a/agent-1.jsonl' });
    expect(readPath(database)).toBe('/a/agent-1.jsonl');
  });
});

describe('persistHookTranscriptPath: the SessionStart hook\'s report', () => {
  // The status line was the row's only writer, and nothing makes it run before
  // a session ends. Rows of never-turned sessions reached a restart with no
  // path, which left the resume check with nothing the agent reported (Sentry
  // DESKTOP-2M). The hook names the same file at session start.
  let database: Database.Database;
  const HOOK_PATH = '/home/dev/.claude/projects/-mock-project/agent-1.jsonl';

  beforeEach(() => {
    database = openProjectDatabase();
    openDatabases.clear();
    openDatabases.set('project-1', database);
    shutdownState.shuttingDown = false;
    forgetTranscriptPath('session-1');
  });

  it('fills a record the status line never reached', () => {
    persistHookTranscriptPath({ sessionManager: sessionManagerFor({}) } as never, 'session-1', HOOK_PATH);
    expect(readPath(database)).toBe(HOOK_PATH);
  });

  it('never replaces a path the record already holds', () => {
    // A resumed row starts with the path the status line last reported, which
    // can sit outside the folder the new cwd maps to. The hook's word does not
    // outrank it.
    const context = { sessionManager: sessionManagerFor({}) };
    persistTranscriptPath(context as never, 'session-1', { transcriptPath: '/elsewhere/agent-1.jsonl' });

    persistHookTranscriptPath(context as never, 'session-1', HOOK_PATH);

    expect(readPath(database)).toBe('/elsewhere/agent-1.jsonl');
  });

  it('leaves the status line to write its own report, even of the path the hook named', () => {
    // The hook's write is kept out of the status line's memo. Remembered there,
    // a hook path that filled nothing (the record already held an earlier run's
    // path) would make the line's own report of that path read as written, and
    // the record would keep the earlier run's.
    const context = { sessionManager: sessionManagerFor({}) };
    database.prepare('UPDATE sessions SET transcript_path = ? WHERE id = ?').run('/earlier-run/agent-1.jsonl', 'session-1');

    persistHookTranscriptPath(context as never, 'session-1', HOOK_PATH);
    expect(readPath(database)).toBe('/earlier-run/agent-1.jsonl');

    persistTranscriptPath(context as never, 'session-1', { transcriptPath: HOOK_PATH });
    expect(readPath(database)).toBe(HOOK_PATH);
  });

  it('skips a Command Terminal and a workflow agent, a shutdown, and a project database that is not open', () => {
    const fill = vi.spyOn(SessionRepository.prototype, 'fillTranscriptPath');
    persistHookTranscriptPath({ sessionManager: sessionManagerFor({ transient: true }) } as never, 'session-1', HOOK_PATH);
    persistHookTranscriptPath({ sessionManager: sessionManagerFor({ workflowId: 'wf-1' }) } as never, 'session-1', HOOK_PATH);
    shutdownState.shuttingDown = true;
    persistHookTranscriptPath({ sessionManager: sessionManagerFor({}) } as never, 'session-1', HOOK_PATH);
    shutdownState.shuttingDown = false;
    openDatabases.clear();
    persistHookTranscriptPath({ sessionManager: sessionManagerFor({}) } as never, 'session-1', HOOK_PATH);

    expect(fill).not.toHaveBeenCalled();
    expect(readPath(database)).toBeNull();
    fill.mockRestore();
  });

  it('writes nothing, and does not throw, when the record does not exist yet', () => {
    // An early agent's hook fires while it is hidden, before its task's spawn
    // commits a record. That record takes the path at insert (below).
    database.prepare('DELETE FROM sessions').run();
    expect(() => persistHookTranscriptPath({ sessionManager: sessionManagerFor({}) } as never, 'session-1', HOOK_PATH)).not.toThrow();
    expect(database.prepare('SELECT COUNT(*) AS total FROM sessions').get()).toEqual({ total: 0 });
  });
});

describe('SessionRepository.insert: a resumed conversation starts with its reported path', () => {
  // Claude keeps appending a resumed conversation to the file it reported,
  // wherever the new session's cwd maps. The new row starts with that path, so
  // a read of the newest row (the turn end's reply) follows it from the first
  // turn, before the new session's own status line paints.
  function insertSession(database: Database.Database, id: string, agentSessionId: string | null, startedAt: string, reportedPath?: string | null) {
    return new SessionRepository(database).insert({
      id, task_id: 'task-1', session_type: 'claude_agent', isolated_swimlane_id: null,
      agent_session_id: agentSessionId, command: 'claude', cwd: '/mock/project/.kangentic/worktrees/1', permission_mode: null,
      prompt: null, status: 'running', exit_code: null, started_at: startedAt, suspended_at: null,
      exited_at: null, suspended_by: null,
      ...(reportedPath !== undefined ? { transcript_path: reportedPath } : {}),
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

  // A record written after its agent started (an early agent adopted once its
  // worktree's setup script ends) is handed the path that agent already
  // reported, because its SessionStart hook fired with no record to write to.
  it('starts with the path its own agent already reported', () => {
    const database = openProjectDatabase();

    const adopted = insertSession(database, 'session-2', 'agent-2', '2026-01-02T00:00:00.000Z', '/home/dev/.claude/projects/-mock-project/agent-2.jsonl');

    expect(adopted.transcript_path).toBe('/home/dev/.claude/projects/-mock-project/agent-2.jsonl');
    expect(storedPath(database, 'session-2')).toBe('/home/dev/.claude/projects/-mock-project/agent-2.jsonl');
  });

  it('prefers its own agent\'s report to the inherited one, and inherits when handed none', () => {
    const database = openProjectDatabase();
    new SessionRepository(database).setTranscriptPath('session-1', '/earlier-run/agent-1.jsonl');

    expect(insertSession(database, 'session-2', 'agent-1', '2026-01-02T00:00:00.000Z', '/this-run/agent-1.jsonl').transcript_path)
      .toBe('/this-run/agent-1.jsonl');
    // A null is "nothing reported yet", which is every ordinary spawn: it must not erase the inheritance.
    database.prepare('UPDATE sessions SET transcript_path = NULL WHERE id = ?').run('session-2');
    expect(insertSession(database, 'session-3', 'agent-1', '2026-01-03T00:00:00.000Z', null).transcript_path)
      .toBe('/earlier-run/agent-1.jsonl');
  });
});
