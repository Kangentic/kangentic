/**
 * The two automation repositories, against a REAL SQLite engine.
 *
 * Real better-sqlite3, the driver production uses.
 *
 * The assertions that matter are the ones a mock could never make: that
 * `position` really is per trigger (so the file's two arrays and the UI's two
 * groups mean the same thing as the DB's ordering), that the foreign key really
 * cascades, and that the whole-column replace survives a name swap the unique
 * index would reject if it were applied row by row.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { AutomationRunRepository, WORKFLOW_RUNS_KEPT_AFTER_DONE_MS } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { WorkflowRepository } from '../../src/main/db/repositories/workflow-repository';
import type { AutomationWriteInput } from '../../src/main/db/repositories/automation-repository';

import { openTestDatabase } from './helpers/test-database';

const openDatabases: DatabaseType.Database[] = [];

function openDatabase(): DatabaseType.Database {
  const database = openTestDatabase();
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

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

describe('AutomationRepository', () => {
  function setup() {
    const database = openDatabase();
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

  // A writer that carries no ids (the kangentic.json apply on every project open,
  // an agent's kangentic_set_automations) must not reset a row's identity: the
  // Frequency count and the once-per-visit check read runs by automation id.
  describe('ids of rows written without one', () => {
    it('reuses the id of the row in the same column with the same name, type and trigger', () => {
      const { automations, columnId } = setup();
      const [first] = automations.replaceForColumn(columnId, [webhook('Ping')]);

      const [second] = automations.replaceForColumn(columnId, [
        webhook('Ping', { config: { url: 'https://changed.example.com' } }),
      ]);

      expect(second.id).toBe(first.id);
      expect(second.config.url).toBe('https://changed.example.com');
      expect(second.created_at).toBe(first.created_at);
    });

    it('keeps each row its own id when the rows come back in another order', () => {
      const { automations, columnId } = setup();
      const written = automations.replaceForColumn(columnId, [webhook('Alpha'), webhook('Beta'), webhook('Gamma')]);
      const idByName = new Map(written.map((row) => [row.name, row.id]));

      const rewritten = automations.replaceForColumn(columnId, [webhook('Gamma'), webhook('Alpha'), webhook('Beta')]);

      expect(rewritten.map((row) => row.name)).toEqual(['Gamma', 'Alpha', 'Beta']);
      for (const row of rewritten) expect(row.id).toBe(idByName.get(row.name));
      expect(new Set(rewritten.map((row) => row.id)).size).toBe(rewritten.length);
    });

    it('does not reuse the id of a row in another column', () => {
      const { database, lanes, automations, columnId } = setup();
      const otherColumn = lanes.create({ name: 'Elsewhere', position: 98 });
      const [inOtherColumn] = automations.replaceForColumn(otherColumn.id, [webhook('Ping')]);

      const [inThisColumn] = automations.replaceForColumn(columnId, [webhook('Ping')]);

      expect(inThisColumn.id).not.toBe(inOtherColumn.id);
      expect((database.prepare('SELECT COUNT(*) as rowCount FROM column_automations').get() as { rowCount: number }).rowCount).toBe(2);
    });

    // One write per case, so the name index (unique per column, case-blind) never
    // sees the old and the new row together.
    const changedIdentity: Array<[string, Partial<AutomationWriteInput>]> = [
      ['name', { name: 'Pong' }],
      ['type', { type: 'notify', config: {} }],
      ['trigger', { trigger: 'exit' }],
    ];
    it.each(changedIdentity)('gives a new id when the %s differs', (_field, changes) => {
      const { automations, columnId } = setup();
      const [first] = automations.replaceForColumn(columnId, [webhook('Ping')]);

      const [second] = automations.replaceForColumn(columnId, [webhook('Ping', changes)]);

      expect(second.id).not.toBe(first.id);
      expect(second.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(automations.getById(first.id)).toBeNull();
    });

    // The row without an id comes FIRST: the explicit-id set is built up front,
    // which is what stops it taking 'a' before 'Beta' has been written. With the
    // explicit row first, the ids already handed out would hide the same mistake.
    it('never hands an id another row in the same call names to a row written without one', () => {
      const { automations, columnId } = setup();
      automations.replaceForColumn(columnId, [webhook('Alpha', { id: 'a' })]);

      const rewrite = () => automations.replaceForColumn(columnId, [webhook('Alpha'), webhook('Beta', { id: 'a' })]);
      expect(rewrite).not.toThrow();

      const saved = automations.listForColumn(columnId);
      expect(saved).toHaveLength(2);
      expect(saved.find((row) => row.name === 'Beta')?.id).toBe('a');
      expect(saved.find((row) => row.name === 'Alpha')?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Set(saved.map((row) => row.id)).size).toBe(saved.length);
    });

    it('never hands an id to two rows, whichever order they are written in', () => {
      const { automations, columnId } = setup();
      automations.replaceForColumn(columnId, [webhook('Alpha', { id: 'a' })]);

      const saved = automations.replaceForColumn(columnId, [webhook('Beta', { id: 'a' }), webhook('Alpha')]);

      expect(saved.find((row) => row.name === 'Beta')?.id).toBe('a');
      expect(saved).toHaveLength(2);
      expect(new Set(saved.map((row) => row.id)).size).toBe(2);
    });
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

  describe('a Text match (final_line)', () => {
    it('round-trips a turn-end Text match, trimmed', () => {
      const { automations, columnId } = setup();
      automations.replaceForColumn(columnId, [webhook('Ping', { trigger: 'turn_end', final_line: '  Verdict: Ready  ' })]);

      expect(automations.listForColumn(columnId)[0]).toMatchObject({ final_line: 'Verdict: Ready', condition: null });
    });

    // Every writer already holds to both rules; this is the backstop, so a row
    // written past them can never carry a check the runner would not run, or two.
    it('stores no Text match off a turn end, and none that is blank', () => {
      const { automations, columnId } = setup();
      automations.replaceForColumn(columnId, [
        webhook('On enter', { trigger: 'enter', final_line: 'Verdict: Ready' }),
        webhook('Blank', { trigger: 'turn_end', final_line: '   ' }),
      ]);

      expect(automations.listForColumn(columnId).map((row) => [row.name, row.final_line])).toEqual([
        ['On enter', null],
        ['Blank', null],
      ]);
    });

    it('keeps one Condition kind: a Text match wins over prose on the same row', () => {
      const { automations, columnId } = setup();
      automations.replaceForColumn(columnId, [
        webhook('Both', { trigger: 'turn_end', condition: 'The review is clean', final_line: 'Verdict: Ready' }),
        webhook('Prose only', { trigger: 'turn_end', condition: 'The review is clean', final_line: null }),
      ]);

      expect(automations.listForColumn(columnId).map((row) => [row.name, row.condition, row.final_line])).toEqual([
        ['Both', null, 'Verdict: Ready'],
        ['Prose only', 'The review is clean', null],
      ]);
    });
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

  // `resolveMoveTarget` reads a Move to column target trimmed and case-blind, so
  // a stored " testing " moves a task to Testing today. A rename of that column
  // has to carry such a row along, or the row quietly stops moving anything.
  describe('a column rename (SwimlaneRepository.update)', () => {
    function moveTo(name: string, targetColumn: string): AutomationWriteInput {
      return { name, type: 'move_to_column', trigger: 'turn_end', enabled: true, config: { targetColumn } };
    }

    /** The seeded Testing column, and a different column to hold the automations. */
    function renamableSetup() {
      const context = setup();
      const testing = context.lanes.list().find((lane) => lane.name === 'Testing');
      if (!testing) throw new Error('expected a Testing column in the seeded board');
      expect(context.columnId).not.toBe(testing.id);
      return { ...context, testing };
    }

    const targetOf = (automations: AutomationRepository, columnId: string) => automations.listForColumn(columnId)[0].config.targetColumn;

    it('points a row at the new name when its stored target has surrounding space and another case', () => {
      const { database, lanes, automations, columnId, testing } = renamableSetup();
      automations.replaceForColumn(columnId, [moveTo('Hand off', ' testing ')]);
      // What the engine reads back is the stored text: a write that tidied it would leave nothing to follow.
      const stored = database.prepare("SELECT json_extract(config_json, '$.targetColumn') AS target FROM column_automations").get() as { target: string };
      expect(stored.target).toBe(' testing ');

      lanes.update({ id: testing.id, name: 'Verify' });

      expect(targetOf(automations, columnId)).toBe('Verify');
    });

    it('points a row at the new name when its stored target is wrapped in a tab or a line break, as resolveMoveTarget reads it', () => {
      const { lanes, automations, columnId, testing } = renamableSetup();
      automations.replaceForColumn(columnId, [moveTo('Tabbed', '\ttesting'), moveTo('Broken', 'Testing\r\n')]);

      lanes.update({ id: testing.id, name: 'Verify' });

      expect(automations.listForColumn(columnId).map((row) => row.config.targetColumn)).toEqual(['Verify', 'Verify']);
    });

    // SQLite's TRIM and LOWER know only ASCII; resolveMoveTarget's trim and
    // lowercase do not, so the rename matches through the same function.
    it('points a row at the new name when its stored target is padded with a space only JavaScript trims, as resolveMoveTarget reads it', () => {
      const { lanes, automations, columnId, testing } = renamableSetup();
      automations.replaceForColumn(columnId, [moveTo('No-break', 'Testing\u00a0'), moveTo('Em space', '\u2003testing')]);

      lanes.update({ id: testing.id, name: 'Verify' });

      expect(automations.listForColumn(columnId).map((row) => row.config.targetColumn)).toEqual(['Verify', 'Verify']);
    });

    it('points a row at the new name when its stored target differs only in the case of a letter outside ASCII', () => {
      const { lanes, automations, columnId, testing } = renamableSetup();
      lanes.update({ id: testing.id, name: 'Prüfung' });
      automations.replaceForColumn(columnId, [moveTo('Umlaut', 'PRÜFUNG')]);

      lanes.update({ id: testing.id, name: 'Verify' });

      expect(targetOf(automations, columnId)).toBe('Verify');
    });

    it('points a row at the new name when its stored target is the column\'s exact name (the control)', () => {
      const { lanes, automations, columnId, testing } = renamableSetup();
      automations.replaceForColumn(columnId, [moveTo('Hand off', 'Testing')]);

      lanes.update({ id: testing.id, name: 'Verify' });

      expect(targetOf(automations, columnId)).toBe('Verify');
    });

    it('leaves a row that names another column alone, however it is spaced', () => {
      const { lanes, automations, columnId, testing } = renamableSetup();
      automations.replaceForColumn(columnId, [moveTo('Back out', ' planning ')]);

      lanes.update({ id: testing.id, name: 'Verify' });

      expect(targetOf(automations, columnId)).toBe(' planning ');
    });
  });

  it('drops a column automations when the column is deleted', () => {
    const { database, lanes, automations } = setup();
    const created = lanes.create({ name: 'Temporary', position: 99 });
    automations.replaceForColumn(created.id, [webhook('Ping')]);
    expect(automations.listForColumn(created.id)).toHaveLength(1);

    lanes.delete(created.id);

    expect(automations.listForColumn(created.id)).toEqual([]);
    expect((database.prepare('SELECT COUNT(*) as rowCount FROM column_automations').get() as { rowCount: number }).rowCount).toBe(0);
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

describe('AutomationRunRepository', () => {
  function setup() {
    const database = openDatabase();
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

  it('says a workflow step check answered after a reply, in that column only', () => {
    // A resumed task's catch-up asks this to tell a judged reply from one a
    // Pause or a quit left unjudged (turn-end-runner.ts).
    const { database, runs, columnId, taskId } = setup();
    const otherColumnId = new SwimlaneRepository(database).list()[1].id;
    const before = new Date(Date.now() - 60_000).toISOString();
    const after = new Date(Date.now() + 60_000).toISOString();
    expect(runs.hasWorkflowStepSince(taskId, columnId, before)).toBe(false);

    // A "not done" answer is a check that answered.
    runs.recordWorkflowStep({ taskId, swimlaneId: columnId, workflowId: 'workflow-1', met: false, reason: 'It asked a question.', detail: 'Not done yet: it asked a question.' });

    expect(runs.hasWorkflowStepSince(taskId, columnId, before)).toBe(true);
    expect(runs.hasWorkflowStepSince(taskId, columnId, after)).toBe(false);
    expect(runs.hasWorkflowStepSince(taskId, otherColumnId, before)).toBe(false);
  });

  it('does not count a column automation\'s run as a workflow step check', () => {
    const { runs, columnId, taskId } = setup();
    const before = new Date(Date.now() - 60_000).toISOString();
    runs.start({ id: 'run-1', automation: automation('a1', columnId), taskId });
    runs.finish('run-1', 'succeeded', 'HTTP 204');

    expect(runs.hasWorkflowStepSince(taskId, columnId, before)).toBe(false);
  });

  it('records a skip with its reason', () => {
    const { runs, columnId, taskId } = setup();
    runs.recordSkipped({ id: 'run-1', automation: automation('a1', columnId), taskId }, 'Start an agent here is off.');

    const [row] = runs.listForTask(taskId);
    expect(row.status).toBe('skipped');
    expect(row.detail).toBe('Start an agent here is off.');
    expect(row.attempts).toBe(0);
  });

  it('records a Text match outcome in its own columns, apart from any Condition answer', () => {
    const { runs, columnId, taskId } = setup();
    runs.start({ id: 'run-met', automation: automation('a1', columnId), taskId, finalLine: { met: true, reason: 'The final line reads "Verdict: Ready".' } });
    runs.recordSkipped(
      { id: 'run-missed', automation: automation('a2', columnId), taskId, finalLine: { met: false, reason: 'The final line reads "Verdict: Blocked".' } },
      'Text match not met: The final line reads "Verdict: Blocked".',
    );
    runs.start({ id: 'run-plain', automation: automation('a3', columnId), taskId });

    const byId = new Map(runs.listForTask(taskId).map((row) => [row.id, row]));
    expect(byId.get('run-met')).toMatchObject({ final_line_met: true, final_line_reason: 'The final line reads "Verdict: Ready".', condition_met: null, check: null });
    expect(byId.get('run-missed')).toMatchObject({ final_line_met: false, status: 'skipped', condition_met: null });
    expect(byId.get('run-plain')).toMatchObject({ final_line_met: null, final_line_reason: null });
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

  // The prune runs on project open, a restart, which is when recovery rebuilds a
  // parked workflow task from its rows. Pruned, its stall row would start a
  // second recovery with a second notice.
  it('keeps a live workflow task\'s own rows in the column it is in, and prunes the rest as before', () => {
    const { database, runs, columnId, taskId } = setup();
    const lanes = new SwimlaneRepository(database).list();
    const earlierColumnId = lanes[1].id;
    database.prepare('UPDATE tasks SET workflow_id = ? WHERE id = ?').run('workflow-1', taskId);
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('task-plain', 'An ordinary task', '', columnId, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
    const stamp = (id: string, second: number) => database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(at(second), id);
    // The oldest rows: this column's stall and its earlier column's step answer.
    runs.recordWorkflowStall({ taskId, swimlaneId: columnId, workflowId: 'workflow-1', reason: 'the agent stopped before its step was done.', countedNudges: 4 });
    const stallId = runs.listForTask(taskId)[0].id;
    stamp(stallId, 0);
    runs.recordWorkflowStep({ taskId, swimlaneId: earlierColumnId, workflowId: 'workflow-1', met: true, reason: 'Done.', detail: 'Step done.' });
    const earlierStepId = runs.listForTask(taskId).find((row) => row.swimlane_id === earlierColumnId)!.id;
    stamp(earlierStepId, 1);
    // An ordinary task's old row, then newer rows that fill the limit.
    runs.start({ id: 'plain-old', automation: automation('a1', columnId), taskId: 'task-plain' });
    stamp('plain-old', 2);
    for (let index = 0; index < 4; index += 1) {
      runs.start({ id: `plain-${index}`, automation: automation('a1', columnId), taskId: 'task-plain' });
      stamp(`plain-${index}`, 10 + index);
    }

    runs.pruneTo(4);

    const kept = new Set(database.prepare('SELECT id FROM automation_runs').all().map((row) => (row as { id: string }).id));
    expect(kept.has(stallId)).toBe(true);
    expect(kept.has(earlierStepId)).toBe(false);
    expect(kept.has('plain-old')).toBe(false);
    expect([...kept].filter((id) => id.startsWith('plain-'))).toHaveLength(4);

    // Archived, the task needs none of it.
    database.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', taskId);
    runs.pruneTo(4);
    expect(runs.listForTask(taskId)).toEqual([]);
  });

  // Task #952: the newest 200 rows were a few hours of one workflow, so the
  // night it ran was pruned before anyone could read it.
  describe('a workflow still going, or done for less than a day', () => {
    const DAY_MS = WORKFLOW_RUNS_KEPT_AFTER_DONE_MS;

    /** A workflow in `state`, finished at `finishedAt`: created by the repository, then set as given. */
    function seedWorkflow(database: DatabaseType.Database, id: string, state: string, finishedAt: string | null): void {
      const created = new WorkflowRepository(database).create({ title: id });
      database.prepare('UPDATE workflows SET id = ?, state = ?, finished_at = ? WHERE id = ?').run(id, state, finishedAt, created.id);
    }

    it('names the workflows whose tasks keep every run: going, or done within a day, or homed elsewhere and so asked', () => {
      const { database, runs, columnId } = setup();
      const now = Date.parse('2026-10-31T12:00:00.000Z');
      seedWorkflow(database, 'running', 'running', null);
      seedWorkflow(database, 'paused', 'paused', null);
      seedWorkflow(database, 'done-recently', 'done', new Date(now - DAY_MS + 60_000).toISOString());
      seedWorkflow(database, 'done-long-ago', 'done', new Date(now - DAY_MS - 60_000).toISOString());
      const member = (taskId: string, workflowId: string, homeProjectId: string | null) => database
        .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, workflow_id, workflow_project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(taskId, taskId, '', columnId, 5, workflowId, homeProjectId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      member('task-running', 'running', null);
      member('task-paused', 'paused', null);
      member('task-done-recently', 'done-recently', null);
      member('task-done-long-ago', 'done-long-ago', null);
      member('task-elsewhere-kept', 'elsewhere-kept', 'home-project');
      member('task-elsewhere-gone', 'elsewhere-gone', 'home-project');
      const asked: string[] = [];

      const kept = runs.workflowIdsKeepingRuns(now, (homeProjectId, workflowId) => {
        asked.push(`${homeProjectId}/${workflowId}`);
        return workflowId === 'elsewhere-kept';
      });

      expect(kept.sort()).toEqual(['done-recently', 'elsewhere-kept', 'paused', 'running']);
      expect(asked.sort()).toEqual(['home-project/elsewhere-gone', 'home-project/elsewhere-kept']);
    });

    it('keeps every run of a kept workflow\'s tasks, archived or not, in any column, and prunes the rest as before', () => {
      const { database, runs, columnId, taskId } = setup();
      const otherColumnId = new SwimlaneRepository(database).list()[1].id;
      database.prepare('UPDATE tasks SET workflow_id = ?, archived_at = ? WHERE id = ?').run('workflow-1', '2026-01-02T00:00:00.000Z', taskId);
      const stamp = (id: string, second: number) => database
        .prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?')
        .run(`2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`, id);
      runs.start({ id: 'workflow-old', automation: automation('a1', otherColumnId), taskId });
      stamp('workflow-old', 0);
      for (let index = 0; index < 4; index += 1) {
        runs.start({ id: `newer-${index}`, automation: automation('a1', columnId), taskId: 'task-1' });
        stamp(`newer-${index}`, 10 + index);
      }
      database.prepare('UPDATE tasks SET workflow_id = NULL WHERE id = ?').run(taskId);

      // Not kept: the old row goes, as it always did.
      runs.pruneTo(4);
      expect(runs.listForTask(taskId).map((row) => row.id)).not.toContain('workflow-old');

      // Kept: nothing of the task's goes, whatever the limit.
      database.prepare('UPDATE tasks SET workflow_id = ? WHERE id = ?').run('workflow-1', taskId);
      runs.start({ id: 'workflow-again', automation: automation('a1', otherColumnId), taskId });
      stamp('workflow-again', 1);
      expect(runs.pruneTo(0, ['workflow-1'])).toBe(0);
      expect(runs.listForTask(taskId)).toHaveLength(5);
    });
  });

  // The startup pass hands a task that never had an agent to the board path,
  // unless its column's enter group already ran this visit (its agent failed to
  // start after it). The prune runs on the same project open, so a pruned row
  // would run that group again at the next launch. Only the newest enter row of
  // such a task in its current column is read, so only that one is kept.
  //
  // Red-green: drop the `id IS NOT (...)` clause from pruneTo and the kept row goes.
  it('keeps the newest enter run of a task that never had an agent, in the column it is in now, and prunes the rest as before', () => {
    const { database, runs } = setup();
    const lanes = new SwimlaneRepository(database).list();
    const planningId = lanes.find((lane) => lane.role === null)!.id;
    const otherColumnId = lanes.filter((lane) => lane.role === null)[1].id;
    const insertTask = (id: string) => database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, id, '', planningId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insertTask('task-never-ran');
    insertTask('task-ran-before');
    database
      .prepare('INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('session-earlier', 'task-ran-before', 'claude_agent', 'claude', '/mock/project', 'exited', '2026-01-01T00:00:00.000Z');

    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
    const record = (id: string, swimlaneId: string, taskId: string, second: number) => {
      runs.start({ id, automation: automation(`automation-${id}`, swimlaneId), taskId });
      database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(at(second), id);
    };
    // The oldest rows: two enter runs in the task's current column, one in another column,
    // and an enter run of a task that has a session record.
    record('never-ran-older', planningId, 'task-never-ran', 0);
    record('never-ran-newest', planningId, 'task-never-ran', 1);
    record('never-ran-other-column', otherColumnId, 'task-never-ran', 2);
    record('ran-before', planningId, 'task-ran-before', 3);
    // Newer rows that fill the limit.
    for (let index = 0; index < 4; index += 1) record(`filler-${index}`, planningId, 'task-ran-before', 10 + index);

    runs.pruneTo(4);

    const kept = new Set(database.prepare('SELECT id FROM automation_runs').all().map((row) => (row as { id: string }).id));
    expect(kept.has('never-ran-newest')).toBe(true);
    expect(kept.has('never-ran-older')).toBe(false);
    expect(kept.has('never-ran-other-column')).toBe(false);
    expect(kept.has('ran-before')).toBe(false);
    expect([...kept].filter((id) => id.startsWith('filler-'))).toHaveLength(4);
    // What the startup pass reads is still there.
    expect(runs.hasEnterRunSince('task-never-ran', planningId, at(1))).toBe(true);

    // Once the task has a session record, the pass no longer reads it, and it goes.
    database
      .prepare('INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('session-first', 'task-never-ran', 'claude_agent', 'claude', '/mock/project', 'running', '2026-01-02T00:00:00.000Z');
    runs.pruneTo(4);
    expect(runs.listForTask('task-never-ran')).toEqual([]);
  });

  it('prunes an enter run of a task that never had an agent once it sits in To Do', () => {
    const { database, runs, columnId, taskId } = setup();
    // `setup` puts the task in the board's first column, To Do, which never starts an agent.
    expect(new SwimlaneRepository(database).list().find((lane) => lane.id === columnId)?.role).toBe('todo');
    runs.start({ id: 'todo-enter', automation: automation('a1', columnId), taskId });
    database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', 'todo-enter');

    expect(runs.pruneTo(0)).toBe(1);
  });

  // The keep clause reads a task's newest enter run only while the startup pass
  // still reads it. Each case below holds every other condition true, so the
  // one it flips is the only reason the row goes. A control task that keeps its
  // row in the same prune shows the clause is live, so a "pruned" cannot be the
  // clause failing to match at all.
  describe('pruneTo, the newest enter run of a task that never had an agent', () => {
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

    function pruneSetup() {
      const fixture = setup();
      const { database, runs } = fixture;
      const lanes = new SwimlaneRepository(database).list();
      // A column with no role can start an agent. Done never does.
      const agentColumnId = lanes.find((lane) => lane.role === null)!.id;
      const doneColumnId = lanes.find((lane) => lane.role === 'done')!.id;
      const insertTask = (id: string, swimlaneId: string) => database
        .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, id, '', swimlaneId, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      const recordEnter = (id: string, swimlaneId: string, taskId: string, startedAt: string) => {
        runs.start({ id, automation: automation(`automation-${id}`, swimlaneId), taskId });
        database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(startedAt, id);
      };
      const survivingIds = () => (database.prepare('SELECT id FROM automation_runs').all() as Array<{ id: string }>)
        .map((row) => row.id)
        .sort();
      return { ...fixture, agentColumnId, doneColumnId, insertTask, recordEnter, survivingIds };
    }

    // Red-green: drop `AND task.archived_at IS NULL` from the keep subquery and the archived task's row stays.
    it('prunes it once the task is archived', () => {
      const { database, runs, columnId, taskId, agentColumnId, insertTask, recordEnter, survivingIds } = pruneSetup();
      insertTask('task-live', agentColumnId);
      insertTask('task-archived', agentColumnId);
      recordEnter('live-enter', agentColumnId, 'task-live', at(0));
      recordEnter('archived-enter', agentColumnId, 'task-archived', at(1));
      // The newest row fills the limit of 1, so both enter runs sit outside the window.
      recordEnter('window-filler', columnId, taskId, at(10));
      database.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', 'task-archived');

      expect(runs.pruneTo(1)).toBe(1);
      expect(survivingIds()).toEqual(['live-enter', 'window-filler']);
    });

    // Red-green: drop 'done' from NEVER_AUTO_SPAWN_ROLES_SQL (or the role NOT IN test) and the Done task's row stays.
    it('prunes it once the task sits in Done', () => {
      const { runs, columnId, taskId, agentColumnId, doneColumnId, insertTask, recordEnter, survivingIds } = pruneSetup();
      insertTask('task-in-agent-column', agentColumnId);
      insertTask('task-in-done', doneColumnId);
      recordEnter('agent-column-enter', agentColumnId, 'task-in-agent-column', at(0));
      recordEnter('done-enter', doneColumnId, 'task-in-done', at(1));
      recordEnter('window-filler', columnId, taskId, at(10));

      expect(runs.pruneTo(1)).toBe(1);
      expect(survivingIds()).toEqual(['agent-column-enter', 'window-filler']);
    });

    // Red-green: flip `newest.rowid DESC` to `ASC` in the keep subquery and the first-inserted row stays instead.
    it('keeps the later-inserted row when two enter runs share a started_at', () => {
      const { database, runs, columnId, taskId, agentColumnId, insertTask, recordEnter, survivingIds } = pruneSetup();
      insertTask('task-tied', agentColumnId);
      // The first-inserted id sorts AFTER the second, so a tie broken by id (or by
      // insertion order read backwards) cannot pass for the right reason.
      recordEnter('tie-b-inserted-first', agentColumnId, 'task-tied', at(0));
      recordEnter('tie-a-inserted-second', agentColumnId, 'task-tied', at(0));
      recordEnter('window-filler', columnId, taskId, at(10));
      const rowOrder = (database.prepare('SELECT id FROM automation_runs ORDER BY rowid').all() as Array<{ id: string }>).map((row) => row.id);
      expect(rowOrder.indexOf('tie-a-inserted-second')).toBeGreaterThan(rowOrder.indexOf('tie-b-inserted-first'));

      expect(runs.pruneTo(1)).toBe(1);
      expect(survivingIds()).toEqual(['tie-a-inserted-second', 'window-filler']);
    });
  });

  it('drops a task runs when the task is deleted', () => {
    const { database, runs, columnId, taskId } = setup();
    runs.start({ id: 'run-1', automation: automation('a1', columnId), taskId });

    database.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

    expect(runs.listForTask(taskId)).toEqual([]);
  });

  // The board's "Stalled" mark is read from the run log, so it survives a
  // restart and an automatic pause, and nothing else keeps it in step: it ends
  // when the run log says the task moved on. Every row writes the current time,
  // and the query compares strictly, so each row here is stamped at a second of
  // its own. Each case marks the task first, so a "not marked" can only come
  // from the one fact it flips.
  describe('listStalledTasks', () => {
    const REASON = 'the agent stopped before its step was done.';
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

    function stalledSetup() {
      const fixture = setup();
      const { database, runs, columnId, taskId } = fixture;
      const rowIds = () => (database.prepare('SELECT id FROM automation_runs').all() as Array<{ id: string }>).map((row) => row.id);

      /** Writes one run-log row through the repository, then stamps it at this second. */
      function stamped(second: number, record: () => void): void {
        const before = new Set(rowIds());
        record();
        const added = rowIds().filter((id) => !before.has(id));
        expect(added).toHaveLength(1);
        database.prepare('UPDATE automation_runs SET started_at = ?, finished_at = ? WHERE id = ?').run(at(second), at(second), added[0]);
      }

      return {
        ...fixture,
        otherColumnId: new SwimlaneRepository(database).list()[1].id,
        stall: (second: number, reason = REASON) => stamped(second, () => runs.recordWorkflowStall({
          taskId, swimlaneId: columnId, workflowId: 'workflow-1', reason, countedNudges: 0,
        })),
        recovery: (second: number, status: 'succeeded' | 'skipped' | 'failed') => stamped(second, () => {
          runs.recordWorkflowRecovery({ taskId, swimlaneId: columnId, workflowId: 'workflow-1', status, detail: 'A nudge.' });
        }),
        step: (second: number, met: boolean | null) => stamped(second, () => runs.recordWorkflowStep({
          taskId, swimlaneId: columnId, workflowId: 'workflow-1', met, reason: 'Not yet.', detail: 'Not done yet: Not yet.',
        })),
        moveInto: (second: number) => {
          database
            .prepare('INSERT INTO task_moves (id, task_id, from_swimlane_id, to_swimlane_id, origin, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(`move-${second}`, taskId, null, columnId, 'workflow', null, at(second));
        },
      };
    }

    it('marks a task with the reason its stall notice gave', () => {
      const { runs, taskId, stall } = stalledSetup();
      expect(runs.listStalledTasks().size).toBe(0);

      stall(10);

      expect(runs.listStalledTasks()).toEqual(new Map([[taskId, REASON]]));
    });

    it('clears the mark when a later recovery nudge ran', () => {
      const { runs, taskId, stall, recovery } = stalledSetup();
      stall(10);
      expect(runs.listStalledTasks().get(taskId)).toBe(REASON);

      recovery(20, 'succeeded');

      expect(runs.listStalledTasks().size).toBe(0);
    });

    it.each(['skipped', 'failed'] as const)('keeps the mark through a later recovery attempt that was %s, since no nudge ran', (status) => {
      const { runs, taskId, stall, recovery } = stalledSetup();
      stall(10);

      recovery(20, status);

      expect(runs.listStalledTasks().get(taskId)).toBe(REASON);
    });

    it('keeps the mark through a later step check that could not answer, and clears it once one judges a turn', () => {
      const { runs, taskId, stall, step } = stalledSetup();
      stall(10);

      // The check's call failed: its condition_met is NULL, so no turn was judged.
      step(20, null);
      expect(runs.listStalledTasks().get(taskId)).toBe(REASON);

      // A "not done" answer is a judged turn all the same.
      step(30, false);
      expect(runs.listStalledTasks().size).toBe(0);
    });

    it('does not mark a stall from an earlier visit to the column', () => {
      const { runs, taskId, stall, moveInto } = stalledSetup();
      moveInto(5);
      stall(10);
      // The stall is in the visit that began at second 5.
      expect(runs.listStalledTasks().get(taskId)).toBe(REASON);

      // The task left and came back after the stall: a new visit, with no stall of its own yet.
      moveInto(20);

      expect(runs.listStalledTasks().size).toBe(0);
    });

    it('does not mark a task that has since moved to another column', () => {
      const { database, runs, taskId, stall, otherColumnId } = stalledSetup();
      stall(10);
      expect(runs.listStalledTasks().get(taskId)).toBe(REASON);

      database.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(otherColumnId, taskId);

      expect(runs.listStalledTasks().size).toBe(0);
    });

    it('does not mark an archived task', () => {
      const { database, runs, taskId, stall } = stalledSetup();
      stall(10);
      expect(runs.listStalledTasks().get(taskId)).toBe(REASON);

      database.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(at(30), taskId);

      expect(runs.listStalledTasks().size).toBe(0);
    });

    it('gives the newest stall\'s reason when the task stalled more than once in the visit', () => {
      const { runs, taskId, stall } = stalledSetup();
      // The newest row is written first, so a read that kept the last row
      // returned would hand back the older reason.
      stall(20, 'the newest stall.');
      stall(10, 'an older stall.');

      expect(runs.listStalledTasks()).toEqual(new Map([[taskId, 'the newest stall.']]));
    });
  });
});
