/**
 * A session whose agent CLI ran in a WSL distro records the distro on its row
 * (`sessions.cli_target`), so the readers and the reap find it after the
 * session ends, and a Command Terminal's conversation does the same
 * (`command_terminal_history.cli_target`). Every other row keeps NULL, which
 * reads as this machine.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { CommandTerminalHistoryRepository } from '../../src/main/db/repositories/command-terminal-history-repository';
import { WorkflowRepository } from '../../src/main/db/repositories/workflow-repository';
import { parseStoredCliTarget, serializeCliTarget } from '../../src/main/agent/shared/cli-target';

function openProjectDatabase(): Database.Database {
  const database = new Database(':memory:');
  runProjectMigrations(database);
  database.prepare(`INSERT INTO swimlanes (id, name, position, created_at) VALUES ('lane-1', 'Executing', 0, '2026-01-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-1', 1, 'Task', '', 'lane-1', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  return database;
}

const BASE_ROW = {
  task_id: 'task-1', session_type: 'claude_agent', isolated_swimlane_id: null,
  agent_session_id: 'agent-1', command: 'claude', cwd: '/mock/project', permission_mode: null, prompt: null,
  status: 'running' as const, exit_code: null, started_at: '2026-01-01T00:00:00.000Z', suspended_at: null,
  exited_at: null, suspended_by: null,
};

function readTarget(database: Database.Database, id: string): string | null {
  return (database.prepare('SELECT cli_target FROM sessions WHERE id = ?').get(id) as { cli_target: string | null }).cli_target;
}

describe('sessions.cli_target', () => {
  it('is added by the migrations, and running them again changes nothing', () => {
    const database = openProjectDatabase();
    runProjectMigrations(database);
    const columns = (database.pragma('table_info(sessions)') as Array<{ name: string; dflt_value: string | null }>)
      .filter((column) => column.name === 'cli_target');
    expect(columns).toHaveLength(1);
    expect(columns[0].dflt_value).toBe('NULL');
  });

  it('holds the distro a WSL session ran in, which reads back as the same target', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    const inserted = repository.insert({ ...BASE_ROW, id: 'session-wsl', cli_target: serializeCliTarget({ kind: 'wsl', distro: 'Ubuntu' }) });

    expect(inserted.cli_target).toBe('{"kind":"wsl","distro":"Ubuntu"}');
    expect(parseStoredCliTarget(readTarget(database, 'session-wsl'))).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
  });

  it('is NULL for a row inserted without one, as every row before it was', () => {
    const database = openProjectDatabase();
    const inserted = new SessionRepository(database).insert({ ...BASE_ROW, id: 'session-local' });

    expect(inserted.cli_target).toBeNull();
    expect(readTarget(database, 'session-local')).toBeNull();
    expect(parseStoredCliTarget(readTarget(database, 'session-local'))).toBeNull();
  });

  it('reaches the readers that select their own columns', () => {
    const database = openProjectDatabase();
    const repository = new SessionRepository(database);
    const target = serializeCliTarget({ kind: 'wsl', distro: 'Ubuntu', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu' });
    repository.insert({ ...BASE_ROW, id: 'session-wsl', cli_target: target });

    expect(repository.getLatestAgentSessionForTask('task-1')?.cli_target).toBe(target);
    expect(repository.listEarlierRunRecords('task-1', null, 'another-record')[0]?.cli_target).toBe(target);
  });

  it('lists each target the given tasks ran under once, for the reap, and nothing for a task with none', () => {
    const database = openProjectDatabase();
    database.prepare(`INSERT INTO tasks (id, display_id, title, description, swimlane_id, position, created_at, updated_at) VALUES ('task-2', 2, 'Other', '', 'lane-1', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
    const repository = new SessionRepository(database);
    const ubuntu = serializeCliTarget({ kind: 'wsl', distro: 'Ubuntu' });
    repository.insert({ ...BASE_ROW, id: 'session-1', cli_target: ubuntu });
    repository.insert({ ...BASE_ROW, id: 'session-2', cli_target: ubuntu });
    repository.insert({ ...BASE_ROW, id: 'session-3' });
    repository.insert({ ...BASE_ROW, id: 'session-4', task_id: 'task-2', cli_target: serializeCliTarget({ kind: 'wsl', distro: 'Debian' }) });

    expect(repository.listCliTargetsOfTasks(['task-1'])).toEqual([ubuntu]);
    expect(repository.listCliTargetsOfTasks(['task-1', 'task-2']).map((raw) => parseStoredCliTarget(raw)?.distro).sort()).toEqual(['Debian', 'Ubuntu']);
    expect(repository.listCliTargetsOfTasks([])).toEqual([]);
    // Past one query's chunk, as the startup sweep passes every archived task.
    const manyIds = Array.from({ length: 1_200 }, (_unused, index) => `missing-${index}`);
    expect(repository.listCliTargetsOfTasks([...manyIds, 'task-2']).map((raw) => parseStoredCliTarget(raw)?.distro)).toEqual(['Debian']);
  });
});

describe('command_terminal_history.cli_target', () => {
  // A Command Terminal's conversation keeps where its CLI ran, so the Earlier
  // list asks the distro for its file instead of reporting it purged.
  it('is added by the migrations, and running them again changes nothing', () => {
    const database = openProjectDatabase();
    runProjectMigrations(database);
    const columns = (database.pragma('table_info(command_terminal_history)') as Array<{ name: string; dflt_value: string | null }>)
      .filter((column) => column.name === 'cli_target');
    expect(columns).toHaveLength(1);
    expect(columns[0].dflt_value).toBe('NULL');
  });

  it('records the target with the conversation, takes the newest on a resume, and is NULL without one', () => {
    const database = openProjectDatabase();
    const repository = new CommandTerminalHistoryRepository(database);
    const target = serializeCliTarget({ kind: 'wsl', distro: 'Ubuntu' });

    repository.recordConversation({ agentSessionId: 'conversation-wsl', agentName: 'claude', cwd: '/mock/project', label: null, touched: true, cliTarget: target });
    repository.recordConversation({ agentSessionId: 'conversation-local', agentName: 'claude', cwd: '/mock/project', label: null, touched: true });
    expect(repository.get('conversation-wsl')?.cli_target).toBe(target);
    expect(repository.get('conversation-local')?.cli_target).toBeNull();

    repository.recordConversation({ agentSessionId: 'conversation-wsl', agentName: 'claude', cwd: '/mock/project', label: null, touched: true, cliTarget: null });
    expect(repository.get('conversation-wsl')?.cli_target).toBeNull();
  });
});

describe('workflows.agent_cli_target', () => {
  // A workflow's own agent has no sessions row, so where its CLI ran is kept on
  // the workflow, and the transcript readers find a distro conversation by it.
  const workflowColumns = (database: Database.Database) =>
    (database.pragma('table_info(workflows)') as Array<{ name: string; type: string; dflt_value: string | null }>)
      .filter((column) => column.name === 'agent_cli_target');

  it('is added by the migrations, and running them again changes nothing', () => {
    const database = openProjectDatabase();
    runProjectMigrations(database);
    const columns = workflowColumns(database);
    expect(columns).toHaveLength(1);
    expect(columns[0].type).toBe('TEXT');
    expect(columns[0].dflt_value).toBe('NULL');
  });

  it('is added in place to a workflows table made before it, and the rows already there read as this machine', () => {
    const database = openProjectDatabase();
    const repository = new WorkflowRepository(database);
    const workflow = repository.create({ title: 'Made before the target column' });
    database.exec('ALTER TABLE workflows DROP COLUMN agent_cli_target');
    expect(workflowColumns(database)).toHaveLength(0);

    runProjectMigrations(database);
    runProjectMigrations(database);

    expect(workflowColumns(database)).toHaveLength(1);
    expect(repository.getById(workflow.id)?.agent_cli_target).toBeNull();
  });
});
