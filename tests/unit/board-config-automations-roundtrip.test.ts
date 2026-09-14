/**
 * `kangentic.json` round-trip for column automations: DB -> file -> DB.
 *
 * This suite exists because of a bug a preview found and no unit test could
 * have: `apply-config` runs on EVERY project open, after the schema migration,
 * and it used to write `columns[].autoCommand` back onto `swimlanes.auto_command`.
 * So the migration would move a column's message into an automation and the very
 * next apply would put it back on a field nothing reads any more, and the column
 * would go quiet. Converting on READ is what makes a teammate's older file, or
 * simply a file that has not been rewritten yet, still behave.
 *
 * node:sqlite rather than better-sqlite3, whose native binding is built for
 * Electron's ABI so a suite gated on it skips everywhere, CI included.
 */
import { describe, it, expect, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

/** The one database every module under test shares, swapped per test. */
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => harness.db,
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { buildBoardConfigFromDb } = await import('../../src/main/config/board-config/build-config');
const { applyBoardConfigToDb } = await import('../../src/main/config/board-config/apply-config');
const { AutomationRepository } = await import('../../src/main/db/repositories/automation-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');

/**
 * Adapt node:sqlite to the slice of better-sqlite3 the migrations and
 * repositories use.
 *
 * Unlike the simpler adapter in the sibling suites, this one supports NESTED
 * transactions, because the code under test genuinely nests: `applyBoardConfigToDb`
 * wraps its whole reconcile in one, and `replaceForColumn` opens its own inside
 * it. better-sqlite3's `transaction()` handles that with SAVEPOINTs, so an
 * adapter that issued a bare BEGIN would fail on a nesting production handles
 * fine, and the test would be reporting on the harness rather than the code.
 */
function adaptDatabase(database: InstanceType<SqliteModule['DatabaseSync']>): DatabaseType.Database {
  let depth = 0;
  const adapter = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => database.prepare(sql),
    pragma: (statement: string) => database.prepare(`PRAGMA ${statement}`).all(),
    transaction: <Args extends unknown[], Result>(body: (...args: Args) => Result) =>
      (...args: Args): Result => {
        const savepoint = `sp_${depth}`;
        const begin = depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`;
        const commit = depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`;
        const rollback = depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`;
        database.exec(begin);
        depth += 1;
        try {
          const result = body(...args);
          depth -= 1;
          database.exec(commit);
          return result;
        } catch (error) {
          depth -= 1;
          database.exec(rollback);
          throw error;
        }
      },
  };
  return adapter as unknown as DatabaseType.Database;
}

describeWithSqlite('kangentic.json automations round-trip', () => {
  function freshDatabase() {
    const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    harness.db = database;
    return {
      database,
      lanes: new SwimlaneRepository(database),
      automations: new AutomationRepository(database),
    };
  }

  const build = () => buildBoardConfigFromDb({ projectId: 'p1', existingTeamConfig: null, fingerprint: 'test' });
  const columnNamed = (config: ReturnType<typeof build>, name: string) =>
    config.columns.find((column) => column.name === name);

  it('writes two named arrays whose order is the position', () => {
    const { lanes, automations } = freshDatabase();
    const executing = lanes.list().find((lane) => lane.name === 'Executing')!;

    automations.replaceForColumn(executing.id, [
      { name: 'Setup', type: 'run_script', trigger: 'enter', enabled: true, config: { script: 'npm ci' } },
      { name: 'Review', type: 'send_message', trigger: 'enter', enabled: true, config: { message: '/code-review', mode: 'immediate' } },
      { name: 'Archive', type: 'run_script', trigger: 'exit', enabled: false, config: { script: 'scripts/archive.sh' } },
    ]);

    const column = columnNamed(build(), 'Executing');

    expect(column?.automations?.onEnter?.map((row) => row.name)).toEqual(['Setup', 'Review']);
    expect(column?.automations?.onExit?.map((row) => row.name)).toEqual(['Archive']);
    // Only `false` is written: an absent key means enabled.
    expect(column?.automations?.onEnter?.[0].enabled).toBeUndefined();
    expect(column?.automations?.onExit?.[0].enabled).toBe(false);
  });

  it('writes the type fields flat on the row', () => {
    const { lanes, automations } = freshDatabase();
    const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
    automations.replaceForColumn(executing.id, [
      { name: 'Ping', type: 'webhook', trigger: 'enter', enabled: true, config: { url: 'https://hooks.example.com/abc', method: 'POST' } },
    ]);

    expect(columnNamed(build(), 'Executing')?.automations?.onEnter?.[0]).toEqual({
      name: 'Ping',
      type: 'webhook',
      url: 'https://hooks.example.com/abc',
      method: 'POST',
    });
  });

  it('omits a key the chosen type does not declare', () => {
    // A draft that was briefly a webhook and became a script keeps the url in
    // its config blob so switching back is lossless. The FILE must not carry it.
    const { lanes, automations } = freshDatabase();
    const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
    automations.replaceForColumn(executing.id, [
      { name: 'Setup', type: 'run_script', trigger: 'enter', enabled: true, config: { script: 'npm ci', url: 'https://leftover.example.com' } },
    ]);

    const row = columnNamed(build(), 'Executing')?.automations?.onEnter?.[0];
    expect(row?.script).toBe('npm ci');
    expect(row?.url).toBeUndefined();
  });

  it('omits the key entirely for a column with no automations', () => {
    const { lanes } = freshDatabase();
    expect(columnNamed(build(), 'Planning')?.automations).toBeUndefined();
    expect(lanes.list().length).toBeGreaterThan(0);
  });

  it('no longer writes the retired arrays or the legacy message keys', () => {
    const { lanes, automations } = freshDatabase();
    const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
    automations.replaceForColumn(executing.id, [
      { name: 'Review', type: 'send_message', trigger: 'enter', enabled: true, config: { message: '/code-review' } },
    ]);

    const config = build();
    expect(config.actions).toBeUndefined();
    expect(config.transitions).toBeUndefined();
    expect(columnNamed(config, 'Executing')?.autoCommand).toBeUndefined();
    expect(columnNamed(config, 'Executing')?.autoCommandMode).toBeUndefined();
  });

  it('round-trips through apply unchanged', () => {
    const { lanes, automations } = freshDatabase();
    const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
    automations.replaceForColumn(executing.id, [
      { name: 'Setup', type: 'run_script', trigger: 'enter', enabled: true, config: { script: 'npm ci' } },
      { name: 'Ping', type: 'webhook', trigger: 'exit', enabled: false, config: { url: 'https://hooks.example.com/abc' } },
    ]);

    const first = build();
    applyBoardConfigToDb('p1', first);
    const second = build();

    expect(second.columns).toEqual(first.columns);
  });

  describe('reading a file written by an older build', () => {
    it('converts columns[].autoCommand into a send_message automation', () => {
      const { lanes, automations } = freshDatabase();
      const config = build();
      const executing = columnNamed(config, 'Executing')!;
      executing.autoCommand = '/pull-request';
      executing.autoCommandMode = 'deferred';

      const { warnings } = applyBoardConfigToDb('p1', config);

      expect(warnings).toEqual([]);
      const lane = lanes.list().find((candidate) => candidate.name === 'Executing')!;
      const rows = automations.listForColumn(lane.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Message', type: 'send_message', trigger: 'enter', enabled: true });
      expect(rows[0].config).toMatchObject({ message: '/pull-request', mode: 'deferred' });
    });

    it('leaves the retired lane field cleared, which is the bug a preview caught', () => {
      // Writing it back is what put the message somewhere nothing reads.
      const { lanes } = freshDatabase();
      const config = build();
      columnNamed(config, 'Executing')!.autoCommand = '/pull-request';

      applyBoardConfigToDb('p1', config);

      const lane = lanes.list().find((candidate) => candidate.name === 'Executing')!;
      expect(lane.auto_command).toBeNull();
    });

    it('renames a hand-written send_command and reads its legacy payload key', () => {
      const { lanes, automations } = freshDatabase();
      const config = build();
      columnNamed(config, 'Executing')!.automations = {
        onEnter: [{ name: 'Review', type: 'send_command', command: '/code-review' }],
      };

      applyBoardConfigToDb('p1', config);

      const lane = lanes.list().find((candidate) => candidate.name === 'Executing')!;
      const rows = automations.listForColumn(lane.id);
      expect(rows[0].type).toBe('send_message');
      expect(rows[0].config.message).toBe('/code-review');
    });

    it('warns and skips a retired type rather than failing the whole config', () => {
      const { lanes, automations } = freshDatabase();
      const config = build();
      columnNamed(config, 'Executing')!.automations = {
        onEnter: [
          { name: 'Kill Session', type: 'kill_session' },
          { name: 'Setup', type: 'run_script', script: 'npm ci' },
        ],
      };

      const { warnings } = applyBoardConfigToDb('p1', config);

      expect(warnings.some((warning) => warning.includes('retired type "kill_session"'))).toBe(true);
      const lane = lanes.list().find((candidate) => candidate.name === 'Executing')!;
      // The board still loads, and the row beside it still runs.
      expect(automations.listForColumn(lane.id).map((row) => row.name)).toEqual(['Setup']);
    });

    it('warns and skips an unknown type', () => {
      const { lanes, automations } = freshDatabase();
      const config = build();
      columnNamed(config, 'Executing')!.automations = {
        onEnter: [{ name: 'Teleport', type: 'teleport_task' }],
      };

      const { warnings } = applyBoardConfigToDb('p1', config);

      expect(warnings.some((warning) => warning.includes('unknown type "teleport_task"'))).toBe(true);
      const lane = lanes.list().find((candidate) => candidate.name === 'Executing')!;
      expect(automations.listForColumn(lane.id)).toEqual([]);
    });
  });

  describe('additive versus destructive', () => {
    it('leaves existing automations alone when the config never mentions them', () => {
      // Same rule the columns and actions already use: a hand-written file that
      // has never mentioned automations must not silently delete the ones a
      // user built in the app.
      const { lanes, automations } = freshDatabase();
      const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
      automations.replaceForColumn(executing.id, [
        { name: 'Mine', type: 'webhook', trigger: 'enter', enabled: true, config: { url: 'https://example.com' } },
      ]);

      const config = build();
      for (const column of config.columns) delete column.automations;

      applyBoardConfigToDb('p1', config);

      expect(automations.listForColumn(executing.id).map((row) => row.name)).toEqual(['Mine']);
    });

    it('clears a column the config has emptied, once the config is automation-aware', () => {
      const { lanes, automations } = freshDatabase();
      const all = lanes.list();
      const executing = all.find((lane) => lane.name === 'Executing')!;
      const planning = all.find((lane) => lane.name === 'Planning')!;
      automations.replaceForColumn(executing.id, [
        { name: 'Gone', type: 'webhook', trigger: 'enter', enabled: true, config: { url: 'https://example.com' } },
      ]);
      automations.replaceForColumn(planning.id, [
        { name: 'Kept', type: 'webhook', trigger: 'enter', enabled: true, config: { url: 'https://example.com' } },
      ]);

      const config = build();
      delete columnNamed(config, 'Executing')!.automations;

      applyBoardConfigToDb('p1', config);

      expect(automations.listForColumn(executing.id)).toEqual([]);
      expect(automations.listForColumn(planning.id).map((row) => row.name)).toEqual(['Kept']);
    });
  });
});
