/**
 * The MCP automation tools, against a real in-memory SQLite database.
 *
 * Real rather than a mocked repository because the things worth pinning are
 * effects on the stored rows: a whole-column replace that keeps ids, a
 * name-uniqueness refusal the database's own COLLATE NOCASE index would also
 * make, and the `autoCommand` parameter landing on the row the engine actually
 * reads. A mock would assert that the statements were issued, not that they did
 * anything, which is the exact class of failure this subsystem was built to end.
 *
 * node:sqlite rather than better-sqlite3, which is compiled for Electron's Node
 * ABI so a suite gated on it skips on a developer's machine and only ever runs
 * in CI. Follows the harness automation-repository.test.ts established.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import {
  handleListAutomations,
  handleSetAutomations,
  handleGetAutomationRuns,
  handleRunAutomation,
} from '../../src/main/agent/commands/automation-commands';
import { handleUpdateColumn, handleCreateColumn } from '../../src/main/agent/commands/column-commands';
import { resolveColumnMessage } from '../../src/main/transition-engine/column-strategy';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { AutomationRunAgainResult, BoardProfile } from '../../src/shared/types';

describeWithSqlite('automation MCP commands', () => {
  let db: DatabaseType.Database;
  let automations: AutomationRepository;
  let swimlanes: SwimlaneRepository;
  let profiles: BoardProfile[];
  let context: CommandContext;
  let runAutomation: ReturnType<typeof vi.fn>;

  function makeContext(): CommandContext {
    runAutomation = vi.fn(async (): Promise<AutomationRunAgainResult> => ({
      ok: true,
      runId: 'run-1',
      automationName: 'Review',
      columnName: 'Executing',
      status: 'succeeded',
      detail: 'Delivered.',
    }));
    return {
      projectId: 'proj-test',
      getProjectDb: () => db,
      getProjectPath: () => 'C:/Users/dev/project',
      getDevServerPortRange: () => ({}),
      getBoardProfiles: () => profiles,
      setBoardProfiles: vi.fn((next: BoardProfile[]) => { profiles = next; }),
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted: vi.fn(),
      onTaskMove: vi.fn().mockResolvedValue(undefined),
      onTasksReordered: vi.fn(),
      onSwimlaneUpdated: vi.fn(),
      onSwimlaneDeleted: vi.fn(),
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
      onRunAutomation: runAutomation,
    };
  }

  function executingId(): string {
    const lane = swimlanes.list().find((candidate) => candidate.name === 'Executing');
    if (!lane) throw new Error('The seeded board has no Executing column');
    return lane.id;
  }

  beforeEach(() => {
    db = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    automations = new AutomationRepository(db);
    swimlanes = new SwimlaneRepository(db);
    profiles = [];
    context = makeContext();
  });

  // ---------------------------------------------------------------------------
  // set_automations
  // ---------------------------------------------------------------------------

  describe('set_automations', () => {
    it('writes a column\'s list, numbering each trigger group from zero', () => {
      const response = handleSetAutomations({
        column: 'Executing',
        automations: [
          { name: 'Review', type: 'send_message', message: '/code-review' },
          { name: 'Ping', type: 'webhook', url: 'https://example.com/hook' },
          { name: 'Archive', type: 'run_script', on: 'exit', script: 'echo done' },
        ],
      }, context);

      expect(response.success).toBe(true);
      const rows = automations.listForColumn(executingId());
      expect(rows.map((row) => [row.name, row.trigger, row.position])).toEqual([
        ['Review', 'enter', 0],
        ['Ping', 'enter', 1],
        ['Archive', 'exit', 0],
      ]);
    });

    it('replaces wholesale: a row left out of the array is gone', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [
          { name: 'Review', type: 'send_message', message: '/code-review' },
          { name: 'Ping', type: 'webhook', url: 'https://example.com/hook' },
        ],
      }, context);
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);

      expect(automations.listForColumn(executingId()).map((row) => row.name)).toEqual(['Review']);
    });

    it('keeps a row\'s identity when the caller carries its id through', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);
      const original = automations.listForColumn(executingId())[0];

      handleSetAutomations({
        column: 'Executing',
        automations: [{ id: original.id, name: 'Review', type: 'send_message', message: '/code-review --strict' }],
      }, context);

      const updated = automations.listForColumn(executingId())[0];
      expect(updated.id).toBe(original.id);
      expect(updated.created_at).toBe(original.created_at);
      expect(updated.config.message).toBe('/code-review --strict');
    });

    // The likeliest call these tools will ever see, and the one the tool's own
    // description teaches: read one column with list_automations, then write
    // another with the rows pasted through, ids included. `replaceForColumn`
    // deletes only the TARGET column's rows and then inserts with whatever id
    // it is handed, so an unguarded write hits the PRIMARY KEY and the agent
    // gets a raw SQLite string instead of a copied list.
    it('mints fresh ids for a list copied from another column', () => {
      const planning = swimlanes.list().find((candidate) => candidate.name === 'Planning');
      if (!planning) throw new Error('The seeded board has no Planning column');
      handleSetAutomations({
        column: 'Executing',
        automations: [
          { name: 'Review', type: 'send_message', message: '/code-review' },
          { name: 'Ping', type: 'webhook', url: 'https://example.com/hook' },
        ],
      }, context);
      const source = automations.listForColumn(executingId());

      const response = handleSetAutomations({
        column: 'Planning',
        automations: source.map((row) => ({ id: row.id, name: row.name, type: row.type, ...row.config })),
      }, context);

      expect(response.success).toBe(true);
      const copied = automations.listForColumn(planning.id);
      expect(copied.map((row) => row.name)).toEqual(['Review', 'Ping']);
      expect(copied.map((row) => row.id)).not.toEqual(source.map((row) => row.id));
      // The source keeps its own ids, so the copies are independent rows with
      // their own run history rather than a move.
      expect(automations.listForColumn(executingId()).map((row) => row.id)).toEqual(source.map((row) => row.id));
    });

    it('mints a fresh id for a row repeating an id used earlier in the same payload', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);
      const original = automations.listForColumn(executingId())[0];

      const response = handleSetAutomations({
        column: 'Executing',
        automations: [
          { id: original.id, name: 'Review', type: 'send_message', message: '/code-review' },
          { id: original.id, name: 'Review again', type: 'send_message', message: '/code-review --strict' },
        ],
      }, context);

      expect(response.success).toBe(true);
      const rows = automations.listForColumn(executingId());
      expect(rows[0].id).toBe(original.id);
      expect(rows[1].id).not.toBe(original.id);
    });

    it('empties the column on []', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);
      const response = handleSetAutomations({ column: 'Executing', automations: [] }, context);

      expect(response.success).toBe(true);
      expect(automations.listForColumn(executingId())).toHaveLength(0);
    });

    // The unique index is COLLATE NOCASE, so a case-only repeat is a duplicate
    // at the database. Refusing here is what turns a constraint throw into a
    // message the caller can act on.
    it('refuses a duplicate name, ignoring case, and saves nothing', () => {
      const response = handleSetAutomations({
        column: 'Executing',
        automations: [
          { name: 'Review', type: 'send_message', message: '/a' },
          { name: '  review  ', type: 'webhook', url: 'https://example.com' },
        ],
      }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('repeats a name');
      expect(automations.listForColumn(executingId())).toHaveLength(0);
    });

    it('refuses a nameless row and saves nothing', () => {
      const response = handleSetAutomations({
        column: 'Executing',
        automations: [{ name: '   ', type: 'send_message', message: '/a' }],
      }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('has no name');
      expect(automations.listForColumn(executingId())).toHaveLength(0);
    });

    it('refuses an unknown type and names the valid ones, so the caller can retry', () => {
      const response = handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Mystery', type: 'teleport' }],
      }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('unknown type "teleport"');
      expect(response.error).toContain('send_message');
    });

    it('refuses a retired type by name rather than storing an inert row', () => {
      const response = handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Kill it', type: 'kill_session' }],
      }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('retired type');
    });

    it('refuses the legacy spawn_agent type, which survives only where it already exists', () => {
      const response = handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Start', type: 'spawn_agent', promptTemplate: 'go' }],
      }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('legacy type');
    });

    it('accepts the legacy send_command spelling and stores it as send_message', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_command', command: '/code-review' }],
      }, context);

      const row = automations.listForColumn(executingId())[0];
      expect(row.type).toBe('send_message');
      expect(row.config.message).toBe('/code-review');
    });

    it('drops a key belonging to another type rather than storing it', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Ping', type: 'webhook', url: 'https://example.com', script: 'rm -rf /' }],
      }, context);

      expect(automations.listForColumn(executingId())[0].config).not.toHaveProperty('script');
    });

    // A warning rather than a refusal: building a list before switching the
    // column's agent on is a legitimate order of operations, and refusing would
    // make an agent unable to do it.
    it('warns, but still saves, a row the column cannot run as things stand', () => {
      handleUpdateColumn({ column: 'Executing', autoSpawn: false }, context);
      const response = handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);

      expect(response.success).toBe(true);
      expect(response.message).toContain('will not run');
      expect(automations.listForColumn(executingId())).toHaveLength(1);
    });

    it('writes back to kangentic.json, which re-seeds the DB on the next open', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);
      expect(context.onSwimlaneUpdated).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // list_automations
  // ---------------------------------------------------------------------------

  describe('list_automations', () => {
    it('reports a column\'s rows with their type, trigger, and settings', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);

      const response = handleListAutomations({ column: 'Executing' }, context);
      expect(response.success).toBe(true);
      expect(response.message).toContain('Review');
      expect(response.message).toContain('send_message');
      const rows = (response.data as { automations: Array<Record<string, unknown>> }).automations;
      expect(rows[0]).toMatchObject({ name: 'Review', type: 'send_message', on: 'enter', message: '/code-review' });
    });

    it('reads the whole board when no column is named', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/a' }],
      }, context);
      handleSetAutomations({
        column: 'Planning',
        automations: [{ name: 'Plan', type: 'send_message', message: '/b' }],
      }, context);

      const response = handleListAutomations({}, context);
      expect(response.message).toContain('Review');
      expect(response.message).toContain('Plan');
    });

    // The same predicate the runner uses, so a row this reports as blocked is a
    // row that WILL be recorded skipped. Without it an agent writes a message
    // onto a column whose agent never starts and believes it took effect.
    it('flags a row the column cannot run, with the reason', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/a' }],
      }, context);
      handleUpdateColumn({ column: 'Executing', autoSpawn: false }, context);

      const response = handleListAutomations({ column: 'Executing' }, context);
      expect(response.message).toContain('cannot run');
    });

    it('flags a switched-off row', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/a', enabled: false }],
      }, context);

      expect(handleListAutomations({ column: 'Executing' }, context).message).toContain('switched off');
    });

    it('says so plainly when a column has none', () => {
      expect(handleListAutomations({ column: 'Executing' }, context).message).toContain('no automations');
    });
  });

  // ---------------------------------------------------------------------------
  // The autoCommand parameter, which used to write a field nothing reads
  // ---------------------------------------------------------------------------

  describe('update_column / create_column autoCommand', () => {
    it('lands on the send_message enter row the engine actually reads', () => {
      const response = handleUpdateColumn({ column: 'Executing', autoCommand: '/review --strict' }, context);

      expect(response.success).toBe(true);
      const message = resolveColumnMessage(automations.listForColumn(executingId()));
      expect(message?.message).toBe('/review --strict');
    });

    it('echoes back the message it actually wrote, not the retired lane field', () => {
      const response = handleUpdateColumn({ column: 'Executing', autoCommand: '/review' }, context);
      expect((response.data as { autoCommand: string | null }).autoCommand).toBe('/review');
    });

    it('replaces the existing message rather than adding a second row', () => {
      handleUpdateColumn({ column: 'Executing', autoCommand: '/first' }, context);
      handleUpdateColumn({ column: 'Executing', autoCommand: '/second' }, context);

      const rows = automations.listForColumn(executingId());
      expect(rows).toHaveLength(1);
      expect(rows[0].config.message).toBe('/second');
    });

    it('deletes the message on null', () => {
      handleUpdateColumn({ column: 'Executing', autoCommand: '/first' }, context);
      const response = handleUpdateColumn({ column: 'Executing', autoCommand: null }, context);

      expect(response.success).toBe(true);
      expect(automations.listForColumn(executingId())).toHaveLength(0);
    });

    it('applies autoCommandMode to the row', () => {
      handleUpdateColumn({ column: 'Executing', autoCommand: '/review', autoCommandMode: 'deferred' }, context);
      expect(resolveColumnMessage(automations.listForColumn(executingId()))?.mode).toBe('deferred');
    });

    it('gives a newly created column its message too', () => {
      const response = handleCreateColumn({ name: 'Brand Review', autoCommand: '/brand' }, context);
      expect(response.success).toBe(true);

      const lane = swimlanes.list().find((candidate) => candidate.name === 'Brand Review');
      expect(resolveColumnMessage(automations.listForColumn(lane!.id))?.message).toBe('/brand');
    });

    it('leaves other automations on the column alone', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Ping', type: 'webhook', url: 'https://example.com' }],
      }, context);
      handleUpdateColumn({ column: 'Executing', autoCommand: '/review' }, context);

      const rows = automations.listForColumn(executingId());
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.name === 'Ping')?.config.url).toBe('https://example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // get_automation_runs / run_automation
  // ---------------------------------------------------------------------------

  describe('get_automation_runs', () => {
    it('refuses without a subject, naming both ways to give one', () => {
      const response = handleGetAutomationRuns({}, context);
      expect(response.success).toBe(false);
      expect(response.error).toContain('task');
      expect(response.error).toContain('column');
    });

    it('reports an empty log rather than failing', () => {
      const response = handleGetAutomationRuns({ column: 'Executing' }, context);
      expect(response.success).toBe(true);
      expect(response.message).toContain('No automation runs');
    });
  });

  describe('run_automation', () => {
    beforeEach(() => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'Review', type: 'send_message', message: '/code-review' }],
      }, context);
    });

    it('names the automations the column has when the one asked for is absent', async () => {
      const response = await handleRunAutomation({ column: 'Executing', automation: 'Nope', task: '1' }, context);
      expect(response.success).toBe(false);
      expect(response.error).toContain('Review');
    });

    it('requires a task, because an automation runs against one', async () => {
      const response = await handleRunAutomation({ column: 'Executing', automation: 'Review' }, context);
      expect(response.success).toBe(false);
      expect(response.error).toContain('task is required');
    });

    it('refuses a task that does not exist rather than running against nothing', async () => {
      const response = await handleRunAutomation({ column: 'Executing', automation: 'Review', task: '999' }, context);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No task matches');
      expect(runAutomation).not.toHaveBeenCalled();
    });

    it('refuses when the connection cannot run one, rather than throwing', async () => {
      const response = await handleRunAutomation(
        { column: 'Executing', automation: 'Review', task: '1' },
        { ...context, onRunAutomation: undefined },
      );
      expect(response.success).toBe(false);
      expect(response.error).toContain('not available');
    });
  });
});
