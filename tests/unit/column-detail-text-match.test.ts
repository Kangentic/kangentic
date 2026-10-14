/**
 * `kangentic_get_column` words a Text match row as a guard in its automation list.
 *
 * `handleGetColumnDetail` (src/main/agent/commands/analytics-commands.ts) prints
 * each automation with the conditions under which it runs: a Condition as
 * "only if: <text>", a Frequency limit as "at most N per task", and a Text match
 * as "only if the last line reads: <pattern>". This is the read-back an agent
 * relies on to see that a Move to column row fires only on its exact final line.
 * Without the guard a Text match row reads as an unconditional one, and an agent
 * that sees "Moves the task to Testing" with no condition will not know it only
 * fires on "Verdict: Ready".
 *
 * `handleListAutomations` words the same guard with quotes
 * ("only if the last line reads "..."") and is covered in
 * automation-commands.test.ts; this handler's colon form is its own wording and
 * is pinned here, against a real in-memory database so the pattern travels
 * through the repository exactly as stored.
 *
 * Tier: Unit (real better-sqlite3, in memory).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { handleGetColumnDetail } from '../../src/main/agent/commands/analytics-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

describe('handleGetColumnDetail: the Text match guard on an automation row', () => {
  let database: DatabaseType.Database;
  let context: CommandContext;
  let columnId: string;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    context = { getProjectDb: () => database } as unknown as CommandContext;
    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.name === 'Executing');
    if (!lane) throw new Error('The seeded board has no Executing column');
    columnId = lane.id;
  });

  afterEach(() => {
    database.close();
  });

  /** The detail message's line for the automation with this name, or undefined. */
  function lineFor(rowName: string): string | undefined {
    const response = handleGetColumnDetail({ column: 'Executing' }, context);
    expect(response.success).toBe(true);
    return (response.message ?? '').split('\n').find((line) => line.includes(rowName));
  }

  function writeTurnEndRows(): void {
    new AutomationRepository(database).replaceForColumn(columnId, [
      { name: 'Verdict ping', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'Ready' }, final_line: 'Verdict: Ready' },
      { name: 'Done check', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'Done' }, final_line: null, condition: 'The work is done' },
      { name: 'Plain ping', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'Plain' }, final_line: null },
    ]);
  }

  it('words a Text match row with the line it needs the agent to end on', () => {
    writeTurnEndRows();

    expect(lineFor('Verdict ping')).toContain('only if the last line reads: Verdict: Ready');
  });

  it('keeps a wildcard pattern exactly as written', () => {
    new AutomationRepository(database).replaceForColumn(columnId, [
      { name: 'Verdict ping', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'Ready' }, final_line: 'Ready for *' },
    ]);

    expect(lineFor('Verdict ping')).toContain('only if the last line reads: Ready for *');
  });

  it('does not word a Text match on a Condition row, which keeps its own guard', () => {
    writeTurnEndRows();

    const line = lineFor('Done check');
    expect(line).toContain('only if: The work is done');
    expect(line).not.toContain('last line reads');
  });

  it('does not word a Text match on a row that has neither guard', () => {
    writeTurnEndRows();

    const line = lineFor('Plain ping');
    expect(line).toBeDefined();
    expect(line).not.toContain('last line reads');
    expect(line).not.toContain('only if');
  });

  it('prints no Text match guard anywhere when no row has one', () => {
    new AutomationRepository(database).replaceForColumn(columnId, [
      { name: 'Plain ping', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'Plain' }, final_line: null },
    ]);

    const response = handleGetColumnDetail({ column: 'Executing' }, context);

    expect(response.success).toBe(true);
    expect(response.message).not.toContain('last line reads');
  });
});
