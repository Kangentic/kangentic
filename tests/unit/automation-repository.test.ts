/**
 * The two automation repositories, against a REAL SQLite engine.
 *
 * node:sqlite rather than better-sqlite3, which is compiled for Electron's Node
 * ABI so a suite gated on it skips everywhere, CI included. Follows the harness
 * already established in worktree-folder-migration.test.ts.
 *
 * The assertions that matter are the ones a mock could never make: that
 * `position` really is per trigger (so the file's two arrays and the UI's two
 * groups mean the same thing as the DB's ordering), that the foreign key really
 * cascades, and that the whole-column replace survives a name swap the unique
 * index would reject if it were applied row by row.
 */
import { describe, it, expect } from 'vitest';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import type { AutomationWriteInput } from '../../src/main/db/repositories/automation-repository';
import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

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

function webhook(name: string, overrides: Partial<AutomationWriteInput> = {}): AutomationWriteInput {
  return {
    name,
    type: 'webhook',
    trigger: 'enter',
    enabled: true,
    config: { url: 'https://example.com/hook' },
    ...overrides,
  };
}

describeWithSqlite('AutomationRepository', () => {
  function setup() {
    const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const lanes = new SwimlaneRepository(database);
    const automations = new AutomationRepository(database);
    const column = lanes.list().find((lane) => lane.role === null);
    if (!column) throw new Error('expected a non-role column in the seeded board');
    return { database, lanes, automations, columnId: column.id };
  }

  it('numbers positions from 0 within each trigger, so the groups never interleave', () => {
    const { automations, columnId } = setup();

    automations.replaceForColumn(columnId, [
      webhook('Enter one', { trigger: 'enter' }),
      webhook('Exit one', { trigger: 'exit' }),
      webhook('Enter two', { trigger: 'enter' }),
      webhook('Exit two', { trigger: 'exit' }),
    ]);

    const saved = automations.listForColumn(columnId);
    const byName = new Map(saved.map((row) => [row.name, row]));
    expect(byName.get('Enter one')?.position).toBe(0);
    expect(byName.get('Enter two')?.position).toBe(1);
    expect(byName.get('Exit one')?.position).toBe(0);
    expect(byName.get('Exit two')?.position).toBe(1);
  });

  it('keeps a supplied id and mints one otherwise', () => {
    const { automations, columnId } = setup();

    const saved = automations.replaceForColumn(columnId, [
      webhook('Kept', { id: 'automation-kept' }),
      webhook('Minted'),
    ]);

    expect(saved.find((row) => row.name === 'Kept')?.id).toBe('automation-kept');
    const minted = saved.find((row) => row.name === 'Minted');
    expect(minted?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the created_at of a row that survives the replace', () => {
    const { automations, columnId } = setup();
    const first = automations.replaceForColumn(columnId, [webhook('Ping', { id: 'ping' })]);
    const originalCreatedAt = first[0].created_at;

    const second = automations.replaceForColumn(columnId, [
      webhook('Ping', { id: 'ping', config: { url: 'https://changed.example.com' } }),
    ]);

    expect(second[0].created_at).toBe(originalCreatedAt);
    expect(second[0].config.url).toBe('https://changed.example.com');
  });

  it('applies a name swap that would fail the unique index row by row', () => {
    // This is why the replace is whole-column and transactional: the final
    // state is unique, but every intermediate state of a pairwise rename is not.
    const { automations, columnId } = setup();
    automations.replaceForColumn(columnId, [
      webhook('Alpha', { id: 'a' }),
      webhook('Beta', { id: 'b' }),
    ]);

    expect(() =>
      automations.replaceForColumn(columnId, [
        webhook('Beta', { id: 'a' }),
        webhook('Alpha', { id: 'b' }),
      ]),
    ).not.toThrow();

    const saved = automations.listForColumn(columnId);
    expect(saved.find((row) => row.id === 'a')?.name).toBe('Beta');
    expect(saved.find((row) => row.id === 'b')?.name).toBe('Alpha');
  });

  it('round-trips enabled and the config blob', () => {
    const { automations, columnId } = setup();

    automations.replaceForColumn(columnId, [
      webhook('Off', { enabled: false, config: { url: 'https://example.com', method: 'PUT', headers: { 'X-A': '1' } } }),
    ]);

    const saved = automations.listForColumn(columnId)[0];
    expect(saved.enabled).toBe(false);
    expect(saved.config).toEqual({ url: 'https://example.com', method: 'PUT', headers: { 'X-A': '1' } });
  });

  describe('getForTrigger', () => {
    it('returns only that trigger, in position order, skipping disabled rows', () => {
      const { automations, columnId } = setup();
      automations.replaceForColumn(columnId, [
        webhook('Enter one', { trigger: 'enter' }),
        webhook('Enter off', { trigger: 'enter', enabled: false }),
        webhook('Enter two', { trigger: 'enter' }),
        webhook('Exit one', { trigger: 'exit' }),
      ]);

      expect(automations.getForTrigger(columnId, 'enter').map((row) => row.name)).toEqual(['Enter one', 'Enter two']);
      expect(automations.getForTrigger(columnId, 'exit').map((row) => row.name)).toEqual(['Exit one']);
    });
  });

  it('drops a column automations when the column is deleted', () => {
    const { database, lanes, automations } = setup();
    const created = lanes.create({ name: 'Temporary', position: 99 });
    automations.replaceForColumn(created.id, [webhook('Ping')]);
    expect(automations.listForColumn(created.id)).toHaveLength(1);

    lanes.delete(created.id);

    expect(automations.listForColumn(created.id)).toEqual([]);
    expect((database.prepare('SELECT COUNT(*) as c FROM column_automations').get() as { c: number }).c).toBe(0);
  });

  it('treats an unparseable config blob as empty rather than failing the column', () => {
    const { database, automations, columnId } = setup();
    automations.replaceForColumn(columnId, [webhook('Ping', { id: 'ping' })]);
    database.prepare("UPDATE column_automations SET config_json = '{not json' WHERE id = 'ping'").run();

    const saved = automations.listForColumn(columnId);
    expect(saved).toHaveLength(1);
    expect(saved[0].config).toEqual({});
  });
});

describeWithSqlite('AutomationRunRepository', () => {
  function setup() {
    const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const lanes = new SwimlaneRepository(database);
    const columnId = lanes.list()[0].id;
    const taskId = 'task-1';
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, 'A task', '', columnId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    return { database, runs: new AutomationRunRepository(database), columnId, taskId };
  }

  const automation = (id: string, swimlaneId: string) => ({
    id,
    name: 'Ping the channel',
    type: 'webhook' as const,
    swimlane_id: swimlaneId,
    trigger: 'enter' as const,
  });

  it('records the attempt before it is made, so a crash leaves a trace', () => {
    const { runs, columnId, taskId } = setup();
    runs.start({ id: 'run-1', automation: automation('a1', columnId), taskId });

    const [row] = runs.listForTask(taskId);
    expect(row.status).toBe('running');
    expect(row.finished_at).toBeNull();
    expect(row.automation_name).toBe('Ping the channel');
  });

  it('keeps the name and type after the automation is gone', () => {
    // The denormalization exists for exactly this: a run log that empties
    // itself when you rename or delete the automation is not a log.
    const { runs, columnId, taskId } = setup();
    runs.start({ id: 'run-1', automation: automation('a1', columnId), taskId });
    runs.finish('run-1', 'succeeded', 'HTTP 204');

    const [row] = runs.listForTask(taskId);
    expect(row).toMatchObject({ automation_id: 'a1', automation_name: 'Ping the channel', type: 'webhook', status: 'succeeded', detail: 'HTTP 204' });
    expect(row.finished_at).not.toBeNull();
  });

  it('records a skip with its reason', () => {
    const { runs, columnId, taskId } = setup();
    runs.recordSkipped({ id: 'run-1', automation: automation('a1', columnId), taskId }, 'Start an agent here is off.');

    const [row] = runs.listForTask(taskId);
    expect(row.status).toBe('skipped');
    expect(row.detail).toBe('Start an agent here is off.');
    expect(row.attempts).toBe(0);
  });

  it('closes out runs the app died in the middle of', () => {
    const { runs, columnId, taskId } = setup();
    runs.start({ id: 'run-1', automation: automation('a1', columnId), taskId });
    runs.start({ id: 'run-2', automation: automation('a2', columnId), taskId });
    runs.finish('run-2', 'succeeded', 'HTTP 200');

    // Everything above started before "now", so a boundary in the future sweeps
    // it, which is the restart case: the process booted after those rows.
    const laterThanEverything = new Date(Date.now() + 60_000).toISOString();
    expect(runs.markStaleRunsInterrupted(laterThanEverything)).toBe(1);

    const byId = new Map(runs.listForTask(taskId).map((row) => [row.id, row]));
    expect(byId.get('run-1')?.status).toBe('interrupted');
    expect(byId.get('run-1')?.finished_at).not.toBeNull();
    expect(byId.get('run-2')?.status).toBe('succeeded');
    // A second open has nothing left to close.
    expect(runs.markStaleRunsInterrupted(laterThanEverything)).toBe(0);
  });

  // Project open fires on a project SWITCH, not only at boot. Without the
  // boundary the sweep stamps a genuinely in-flight run `interrupted` the
  // moment the user looks at another board and comes back, and the summary
  // notice then tells them a live automation did not finish.
  it('leaves a run this process started alone, however many times a project opens', () => {
    const { runs, columnId, taskId } = setup();
    const processStartedAt = new Date(Date.now() - 60_000).toISOString();
    runs.start({ id: 'live-run', automation: automation('a1', columnId), taskId });

    expect(runs.markStaleRunsInterrupted(processStartedAt)).toBe(0);
    expect(runs.listForTask(taskId)[0].status).toBe('running');

    // And it still closes normally afterwards, with its REAL outcome.
    runs.finish('live-run', 'succeeded', 'exit 0');
    expect(runs.listForTask(taskId)[0].status).toBe('succeeded');
  });

  it('prunes to the newest rows, because nothing else bounds the table', () => {
    const { database, runs, columnId, taskId } = setup();
    for (let index = 0; index < 10; index += 1) {
      runs.start({ id: `run-${index}`, automation: automation('a1', columnId), taskId });
      // Distinct timestamps, since the ordering is by started_at.
      database
        .prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?')
        .run(`2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, `run-${index}`);
    }

    expect(runs.pruneTo(4)).toBe(6);
    expect(runs.listForTask(taskId).map((row) => row.id)).toEqual(['run-9', 'run-8', 'run-7', 'run-6']);
  });

  it('drops a task runs when the task is deleted', () => {
    const { database, runs, columnId, taskId } = setup();
    runs.start({ id: 'run-1', automation: automation('a1', columnId), taskId });

    database.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

    expect(runs.listForTask(taskId)).toEqual([]);
  });
});
