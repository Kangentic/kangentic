/**
 * Shared fixtures for the never-ran mark tests (Sentry DESKTOP-2M): an in-memory
 * project database with one lane and one task, a base session row, and a reader
 * for `sessions.agent_never_ran_at`.
 */
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../../src/main/db/migrations';

export const NEVER_RAN_AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';

export function openProjectDatabase(): Database.Database {
  const database = new Database(':memory:');
  runProjectMigrations(database);
  database.prepare(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'Executing', 0, '2026-01-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-1', 1, 'Task', '', 'lane-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  return database;
}

export function neverRanBaseRow(status: 'running' | 'suspended' | 'queued') {
  return {
    task_id: 'task-1', session_type: 'claude_agent', isolated_swimlane_id: null,
    agent_session_id: NEVER_RAN_AGENT_SESSION_ID, command: 'claude', cwd: '/mock/project', permission_mode: null, prompt: 'Build the thing',
    status, exit_code: null, started_at: '2026-01-01T00:00:00.000Z', suspended_at: null,
    exited_at: null, suspended_by: null,
  };
}

export function readNeverRanAt(database: Database.Database, id: string): string | null {
  return (database.prepare('SELECT agent_never_ran_at FROM sessions WHERE id = ?').get(id) as { agent_never_ran_at: string | null }).agent_never_ran_at;
}
