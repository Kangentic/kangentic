/**
 * The one-way migration from actions plus transitions to column automations.
 *
 * Mostly pure-planner tests, which is why the planner is separate from the DB
 * runner: the decisions worth locking are all judgements about what SURVIVES,
 * and none of them need a database. The handful that do (idempotency, the
 * unique name index the planner exists to satisfy) run on the node:sqlite
 * harness, because better-sqlite3 is compiled for Electron's ABI and a suite
 * gated on it skips everywhere, CI included.
 */
import { describe, it, expect } from 'vitest';
import {
  planAutomationsMigration,
  runAutomationsMigration,
  hasRunAutomationsMigration,
  type AutomationsMigrationInput,
  type LegacyActionRow,
} from '../../src/main/db/migrations/automations-migration';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { DEFAULT_SPAWN_PROMPT_TEMPLATE } from '../../src/shared/task-template-vars';
import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

/** Mirrors the adapter in task-repository-worktree-skip-reason.test.ts. */
function adaptDatabase(database: InstanceType<SqliteModule['DatabaseSync']>): DatabaseType.Database {
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => database.prepare(sql),
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        database.exec('BEGIN');
        try {
          const result = body(...args);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

const PLANNING = 'lane-planning';
const EXECUTING = 'lane-executing';

function action(id: string, name: string, type: string, config: object = {}): LegacyActionRow {
  return { id, name, type, config_json: JSON.stringify(config) };
}

function input(overrides: Partial<AutomationsMigrationInput> = {}): AutomationsMigrationInput {
  return {
    lanes: [
      { id: PLANNING, name: 'Planning', auto_command: null, auto_command_mode: 'immediate' },
      { id: EXECUTING, name: 'Executing', auto_command: null, auto_command_mode: 'immediate' },
    ],
    actions: [],
    transitions: [],
    ...overrides,
  };
}

describe('retired action types', () => {
  it.each(['kill_session', 'create_worktree', 'cleanup_worktree'])(
    'drops a %s row and leaves no automation behind',
    (type) => {
      const plan = planAutomationsMigration(input({
        actions: [action('a1', 'Retired', type)],
        transitions: [{ from_swimlane_id: '*', to_swimlane_id: PLANNING, action_id: 'a1', execution_order: 0 }],
      }));

      expect(plan.automations).toEqual([]);
      expect(plan.droppedByColumn).toEqual({ Planning: 1 });
    },
  );

  it('counts drops per column so the log can say where they were', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Kill Session', 'kill_session')],
      transitions: [
        { from_swimlane_id: '*', to_swimlane_id: PLANNING, action_id: 'a1', execution_order: 0 },
        { from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 },
      ],
    }));

    expect(plan.automations).toEqual([]);
    expect(plan.droppedByColumn).toEqual({ Planning: 1, Executing: 1 });
  });
});

describe('the legacy spawn_agent', () => {
  it('skips the seeded default-prompt row, because the fallback spawn already does it', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Start Planning Agent', 'spawn_agent', { promptTemplate: DEFAULT_SPAWN_PROMPT_TEMPLATE })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: PLANNING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations).toEqual([]);
    expect(plan.skippedSeededSpawnByColumn).toEqual({ Planning: 1 });
  });

  it('keeps a row carrying any other prompt, as the one legacy automation', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Start Planning Agent', 'spawn_agent', { promptTemplate: 'Read {{task_xml}} and plan{{attachments}}' })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: PLANNING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations).toHaveLength(1);
    expect(plan.automations[0].type).toBe('spawn_agent');
    expect(plan.automations[0].config.promptTemplate).toContain('Read {{task_xml}}');
    expect(plan.skippedSeededSpawnByColumn).toEqual({});
  });

  it('runs the prompt through the existing spawn-config migration first', () => {
    // A pre-attachments custom prompt is normalized before the default check,
    // so it is not mistaken for a customization it no longer is.
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Start', 'spawn_agent', { promptTemplate: '{{task_xml}}' })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: PLANNING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations).toEqual([]);
  });
});

describe('surviving action types', () => {
  it('renames send_command to send_message and carries the legacy command key', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Review', 'send_command', { command: '/code-review {{baseBranch}}' })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations[0].type).toBe('send_message');
    expect(plan.automations[0].config.message).toBe('/code-review {{baseBranch}}');
  });

  it('drops the run_script workingDir key, since a script is always task-relative now', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Setup', 'run_script', { script: 'npm install', workingDir: 'project' })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations[0].config.script).toBe('npm install');
    expect(plan.automations[0].config.workingDir).toBeUndefined();
  });

  it('keeps a webhook whole', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Ping', 'webhook', { url: 'https://example.com/x', method: 'PUT', headers: { 'X-Token': 'abc' } })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations[0].type).toBe('webhook');
    expect(plan.automations[0].config).toMatchObject({ url: 'https://example.com/x', method: 'PUT', headers: { 'X-Token': 'abc' } });
  });

  it('drops an action type nothing recognizes, the way apply-config already does', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Mystery', 'teleport_task')],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations).toEqual([]);
  });
});

describe('ordering and identity', () => {
  it('numbers a column from 0 in execution order', () => {
    const plan = planAutomationsMigration(input({
      actions: [
        action('a1', 'First', 'run_script', { script: 'one' }),
        action('a2', 'Second', 'webhook', { url: 'https://example.com' }),
      ],
      transitions: [
        { from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a2', execution_order: 1 },
        { from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 },
      ],
    }));

    expect(plan.automations.map((row) => [row.name, row.position])).toEqual([['First', 0], ['Second', 1]]);
  });

  it('gives every migrated row the enter trigger, because no exit lookup existed', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Ping', 'webhook', { url: 'https://example.com' })],
      transitions: [{ from_swimlane_id: PLANNING, to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations[0].trigger).toBe('enter');
  });

  it('copies one action referenced from two columns into two independent automations', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Ping', 'webhook', { url: 'https://example.com' })],
      transitions: [
        { from_swimlane_id: '*', to_swimlane_id: PLANNING, action_id: 'a1', execution_order: 0 },
        { from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 },
      ],
    }));

    expect(plan.automations).toHaveLength(2);
    expect(plan.automations.map((row) => row.swimlaneId).sort()).toEqual([EXECUTING, PLANNING]);
  });

  it('folds an exact pair onto the same column as the wildcard, wildcard first', () => {
    // Both name the same action on the same destination. getTransitionsFor
    // returned one set or the other, never both, so one automation is correct.
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Ping', 'webhook', { url: 'https://example.com' })],
      transitions: [
        { from_swimlane_id: PLANNING, to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 },
        { from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 },
      ],
    }));

    expect(plan.automations).toHaveLength(1);
  });

  it('makes names unique within a column so the unique index can be created', () => {
    const plan = planAutomationsMigration(input({
      actions: [
        action('a1', 'Ping', 'webhook', { url: 'https://one.example.com' }),
        action('a2', 'Ping', 'webhook', { url: 'https://two.example.com' }),
      ],
      transitions: [
        { from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 },
        { from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a2', execution_order: 1 },
      ],
    }));

    expect(plan.automations.map((row) => row.name)).toEqual(['Ping', 'Ping (2)']);
  });

  it('ignores a transition pointing at a column that no longer exists', () => {
    const plan = planAutomationsMigration(input({
      actions: [action('a1', 'Ping', 'webhook', { url: 'https://example.com' })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: 'lane-deleted', action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations).toEqual([]);
  });
});

describe("a column's message", () => {
  it('becomes a send_message automation on enter', () => {
    const plan = planAutomationsMigration(input({
      lanes: [{ id: EXECUTING, name: 'Executing', auto_command: '/pull-request', auto_command_mode: 'deferred' }],
    }));

    expect(plan.automations).toHaveLength(1);
    expect(plan.automations[0]).toMatchObject({
      swimlaneId: EXECUTING,
      name: 'Message',
      type: 'send_message',
      trigger: 'enter',
      position: 0,
      enabled: true,
      config: { message: '/pull-request', mode: 'deferred' },
    });
    expect(plan.messageColumnIds).toEqual([EXECUTING]);
  });

  it('lands after the migrated rows, because that is when it ran', () => {
    // Every transition action ran BEFORE the fallback spawn; the message was
    // delivered after it.
    const plan = planAutomationsMigration(input({
      lanes: [{ id: EXECUTING, name: 'Executing', auto_command: '/pull-request', auto_command_mode: 'immediate' }],
      actions: [action('a1', 'Setup', 'run_script', { script: 'npm ci' })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations.map((row) => [row.name, row.position])).toEqual([['Setup', 0], ['Message', 1]]);
  });

  it('ignores a blank message', () => {
    const plan = planAutomationsMigration(input({
      lanes: [{ id: EXECUTING, name: 'Executing', auto_command: '   ', auto_command_mode: 'immediate' }],
    }));

    expect(plan.automations).toEqual([]);
    expect(plan.messageColumnIds).toEqual([]);
  });

  it('does not collide with a migrated row that is already called Message', () => {
    const plan = planAutomationsMigration(input({
      lanes: [{ id: EXECUTING, name: 'Executing', auto_command: '/pull-request', auto_command_mode: 'immediate' }],
      actions: [action('a1', 'Message', 'webhook', { url: 'https://example.com' })],
      transitions: [{ from_swimlane_id: '*', to_swimlane_id: EXECUTING, action_id: 'a1', execution_order: 0 }],
    }));

    expect(plan.automations.map((row) => row.name)).toEqual(['Message', 'Message (2)']);
  });
});

describeWithSqlite('against a real database', () => {
  function migratedDatabase(): DatabaseType.Database {
    const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    runProjectMigrations(database);
    return database;
  }

  function countAutomations(database: DatabaseType.Database): number {
    return (database.prepare('SELECT COUNT(*) as c FROM column_automations').get() as { c: number }).c;
  }

  it('seeds a fresh board with no automations at all', () => {
    const database = migratedDatabase();
    expect(countAutomations(database)).toBe(0);
    // And nothing seeds the actions that used to become them.
    expect((database.prepare('SELECT COUNT(*) as c FROM actions').get() as { c: number }).c).toBe(0);
  });

  it('records that it ran, so a second pass is a no-op', () => {
    const database = migratedDatabase();
    expect(hasRunAutomationsMigration(database)).toBe(true);
    expect(runAutomationsMigration(database)).toBeNull();
  });

  it('migrates a column message and clears the field it came from', () => {
    const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    runProjectMigrations(database);
    // Simulate an upgrade: put a message back and re-run as if this database
    // predated the migration.
    database.prepare("UPDATE swimlanes SET auto_command = '/code-review' WHERE name = 'Code Review'").run();
    database.prepare('DELETE FROM schema_meta').run();

    const plan = runAutomationsMigration(database);

    expect(plan?.automations).toHaveLength(1);
    const row = database.prepare('SELECT name, type, trigger, enabled, config_json FROM column_automations').get() as {
      name: string; type: string; trigger: string; enabled: number; config_json: string;
    };
    expect(row).toMatchObject({ name: 'Message', type: 'send_message', trigger: 'enter', enabled: 1 });
    expect(JSON.parse(row.config_json)).toMatchObject({ message: '/code-review' });

    const lane = database.prepare("SELECT auto_command FROM swimlanes WHERE name = 'Code Review'").get() as { auto_command: string | null };
    expect(lane.auto_command).toBeNull();
  });

  it('refuses two automations with the same name on one column', () => {
    const database = migratedDatabase();
    const lane = database.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string };
    const insert = database.prepare(`
      INSERT INTO column_automations (id, swimlane_id, name, type, trigger, position, enabled, config_json, created_at, updated_at)
      VALUES (?, ?, ?, 'webhook', 'enter', ?, 1, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `);
    insert.run('r1', lane.id, 'Ping', 0);

    // Case-insensitively, which is what the dialog validates too.
    expect(() => insert.run('r2', lane.id, 'ping', 1)).toThrow();
  });
});
