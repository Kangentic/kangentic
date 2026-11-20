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
 * Real better-sqlite3, the driver production uses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import type { AutomationWriteInput, BoardAutomationConfig, BoardColumnAutomations, BoardColumnConfig, BoardConfig } from '../../src/shared/types';

/** The one database every module under test shares, swapped per test. */
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => harness.db,
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { buildBoardConfigFromDb } = await import('../../src/main/config/board-config/build-config');
const { applyBoardConfigToDb } = await import('../../src/main/config/board-config/apply-config');
const { AutomationRepository } = await import('../../src/main/db/repositories/automation-repository');
const { AutomationRunRepository } = await import('../../src/main/db/repositories/automation-run-repository');
const { frequencyLimitReason } = await import('../../src/main/automations/automation-runner');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { ActionRepository } = await import('../../src/main/db/repositories/action-repository');
const { planColumnAutomations, fileHoldsUnreadableAutomations } = await import('../../src/main/config/board-config/apply-automations');
const { CURRENT_VERSION, fileFormatVersionFor, migrateBoardColumnFields, newerFormatReason } = await import('../../src/main/config/board-config/config-helpers');

import { openTestDatabase } from './helpers/test-database';

describe('kangentic.json automations round-trip', () => {
  const openDatabases: DatabaseType.Database[] = [];

  afterEach(() => {
    harness.db = null;
    for (const database of openDatabases.splice(0)) database.close();
  });

  function freshDatabase() {
    const database = openTestDatabase();
    openDatabases.push(database);
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

  // #872: a row's Task lines (filter) and a Text match beside an Agent
  // evaluation are file format 2. A board that uses neither stays format 1, so
  // an older build keeps reading it.
  describe('Task filter and a two-kind condition (file format 2)', () => {
    const bothKinds = {
      name: 'Back for revisions',
      type: 'move_to_column',
      trigger: 'turn_end',
      enabled: true,
      config: { targetColumn: 'Executing' },
      condition: 'The review found work',
      final_line: 'Verdict: Changes',
      filter: { priorities: [3, 4], labels: ['bug'] },
    } as const satisfies AutomationWriteInput;

    it('writes the filter by level name and both condition kinds, stamps format 2, and round-trips through apply', () => {
      const { lanes, automations } = freshDatabase();
      const codeReview = lanes.list().find((lane) => lane.name === 'Code Review')!;
      automations.replaceForColumn(codeReview.id, [{ ...bothKinds, filter: { ...bothKinds.filter } }]);
      const [before] = automations.listForColumn(codeReview.id);

      const first = build();
      expect(first.version).toBe(2);
      expect(columnNamed(first, 'Code Review')?.automations?.onTurnEnd).toEqual([{
        name: 'Back for revisions',
        type: 'move_to_column',
        condition: { text: 'Verdict: Changes', agent: 'The review found work' },
        filter: { priorities: ['High', 'Urgent'], labels: ['bug'] },
        targetColumn: 'Executing',
      }]);

      applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(first)) as BoardConfig);
      const [after] = automations.listForColumn(codeReview.id);
      expect(after).toMatchObject({
        id: before.id,
        condition: 'The review found work',
        final_line: 'Verdict: Changes',
        filter: { priorities: [3, 4], labels: ['bug'] },
      });
      expect(build().columns).toEqual(first.columns);
    });

    it('stamps format 2 for a filter alone, and format 1 for a board with neither new key', () => {
      const { lanes, automations } = freshDatabase();
      const codeReview = lanes.list().find((lane) => lane.name === 'Code Review')!;
      automations.replaceForColumn(codeReview.id, [
        { name: 'Judged', type: 'notify', trigger: 'turn_end', enabled: true, config: {}, condition: 'The review is clean', filter: null },
        { name: 'Texted', type: 'notify', trigger: 'turn_end', enabled: true, config: {}, final_line: 'Ready', filter: null },
      ]);
      const plain = build();
      expect(plain.version).toBe(1);
      expect(fileFormatVersionFor(plain.columns)).toBe(1);

      automations.replaceForColumn(codeReview.id, [
        { name: 'Judged', type: 'notify', trigger: 'turn_end', enabled: true, config: {}, condition: 'The review is clean', filter: { priorities: [4], labels: [] } },
      ]);
      expect(build().version).toBe(2);
    });

    it('reads a filter by level name, any case, and plans it as indices', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: {
          onTurnEnd: [{ name: 'Urgent bugs', type: 'notify', filter: { priorities: ['urgent', 'HIGH'], labels: ['bug'] } }],
        },
      });

      expect(plan.keepExisting).toBe(false);
      expect(plan.warnings).toEqual([]);
      expect(plan.rows.map((row) => row.filter)).toEqual([{ priorities: [3, 4], labels: ['bug'] }]);
    });

    it('keeps the column, with a warning, over an unknown priority name', () => {
      const column = {
        name: 'Code Review',
        automations: {
          onTurnEnd: [{ name: 'Critical only', type: 'notify', filter: { priorities: ['Critical'] } }],
        },
      };
      const plan = planColumnAutomations(column);

      expect(plan.keepExisting).toBe(true);
      expect(plan.rows).toEqual([]);
      expect(plan.warnings.join('\n')).toContain('Critical');
      expect(plan.warnings.at(-1)).toBe('"Code Review" has an automation this build cannot read. Kept the column\'s current automations.');
      expect(fileHoldsUnreadableAutomations([column] as unknown as BoardColumnConfig[], 2)).toBe(true);
    });

    it('keeps the column over a malformed filter', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: {
          onTurnEnd: [{ name: 'Odd', type: 'notify', filter: { priorities: ['High'], extra: true } as unknown as undefined }],
        },
      });

      expect(plan.keepExisting).toBe(true);
      expect(plan.rows).toEqual([]);
    });

    it('keeps the stored rows when apply meets an unknown priority name', () => {
      const { lanes, automations } = freshDatabase();
      const codeReview = lanes.list().find((lane) => lane.name === 'Code Review')!;
      automations.replaceForColumn(codeReview.id, [{ ...bothKinds, filter: { ...bothKinds.filter } }]);
      const file = build();
      columnNamed(file, 'Code Review')!.automations = {
        onTurnEnd: [{ name: 'Back for revisions', type: 'move_to_column', filter: { priorities: ['Critical'] } }],
      };

      const { warnings } = applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(file)) as BoardConfig);

      expect(automations.listForColumn(codeReview.id)).toMatchObject([{ name: 'Back for revisions', filter: { priorities: [3, 4], labels: ['bug'] } }]);
      expect(warnings.join('\n')).toContain('Critical');
    });
  });

  describe('On agent turn end, Condition and Frequency', () => {
    function seedReviewLoop() {
      const fixture = freshDatabase();
      const codeReview = fixture.lanes.list().find((lane) => lane.name === 'Code Review')!;
      fixture.automations.replaceForColumn(codeReview.id, [
        { name: 'Review', type: 'send_message', trigger: 'enter', enabled: true, config: { message: '/code-review' } },
        {
          name: 'Back for revisions',
          type: 'move_to_column',
          trigger: 'turn_end',
          enabled: true,
          config: { targetColumn: 'Executing', message: 'Back from review:\n{{agentReply}}' },
          condition: 'The review found work the implementer can do',
          max_runs: 3,
        },
        { name: 'Clean', type: 'move_to_column', trigger: 'turn_end', enabled: true, config: {}, condition: 'The review is clean' },
      ]);
      return fixture;
    }

    it('writes onTurnEnd with the guards as camelCase row keys, and the column by name', () => {
      seedReviewLoop();
      const automations = columnNamed(build(), 'Code Review')?.automations;

      expect(automations?.onTurnEnd).toEqual([
        {
          name: 'Back for revisions',
          type: 'move_to_column',
          condition: { agent: 'The review found work the implementer can do' },
          maxRuns: 3,
          targetColumn: 'Executing',
          message: 'Back from review:\n{{agentReply}}',
        },
        // No targetColumn: Next column is the absent key, not a stored value.
        { name: 'Clean', type: 'move_to_column', condition: { agent: 'The review is clean' } },
      ]);
      // A row with neither guard carries neither key.
      expect(automations?.onEnter?.[0]).toEqual({ name: 'Review', type: 'send_message', message: '/code-review' });
    });

    it('round-trips the turn-end group, the guards and an absent targetColumn through apply unchanged', () => {
      seedReviewLoop();
      const first = build();
      applyBoardConfigToDb('p1', first);
      const second = build();

      expect(second.columns).toEqual(first.columns);
    });

    // apply-config runs on every project open and hands the rows to the
    // repository without ids. Frequency counts runs by automation id, so a row
    // that came back with a fresh id each time would start its count over at every
    // launch, and a "twice only" review loop would loop forever across restarts.
    it('keeps a row\'s id, and with it its Frequency count, when the same file is applied again', () => {
      const { database, lanes, automations } = freshDatabase();
      const codeReview = lanes.list().find((lane) => lane.name === 'Code Review')!;
      const taskId = 'task-frequency';
      database
        .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(taskId, 'A task in review', '', codeReview.id, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      const file = build();
      columnNamed(file, 'Code Review')!.automations = {
        onTurnEnd: [{ name: 'Back for revisions', type: 'move_to_column', targetColumn: 'Executing', maxRuns: 2 }],
      };
      // The file on disk, read back the way the app reads it on each open.
      const fileText = JSON.stringify(file);

      applyBoardConfigToDb('p1', JSON.parse(fileText) as BoardConfig);
      const [applied] = automations.listForColumn(codeReview.id);
      expect(applied).toMatchObject({ name: 'Back for revisions', trigger: 'turn_end', max_runs: 2 });

      const runs = new AutomationRunRepository(database);
      for (const runId of ['run-1', 'run-2']) {
        runs.start({ id: runId, automation: applied, taskId });
        runs.finish(runId, 'succeeded', 'Moved to Executing.');
      }
      expect(runs.countRuns(applied.id, taskId)).toBe(2);

      applyBoardConfigToDb('p1', JSON.parse(fileText) as BoardConfig);

      const [reapplied] = automations.listForColumn(codeReview.id);
      expect(reapplied.id).toBe(applied.id);
      expect(runs.countRuns(reapplied.id, taskId)).toBe(2);
      // And the limit still bites: the row is spent for this task, not fresh.
      expect(frequencyLimitReason(reapplied, runs, taskId)).toBe('Already ran 2 times on this task, its limit.');
    });

    it('clears a Condition the file stops carrying and takes the file\'s new order, keeping each row\'s id', () => {
      // The Executing loop as the board had it: a judged Apply findings first,
      // then a judged move. The file now asks every time and moves on an exact
      // last line, with the move first.
      const { lanes, automations } = freshDatabase();
      const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
      automations.replaceForColumn(executing.id, [
        { name: 'Apply findings', type: 'send_message', trigger: 'turn_end', enabled: true, config: { message: 'Apply them.' }, condition: 'The final message lists findings it has not applied.' },
        { name: 'On to Code Review', type: 'move_to_column', trigger: 'turn_end', enabled: true, config: { targetColumn: 'Code Review' }, condition: 'The work is finished.', max_runs: 4 },
      ]);
      const before = new Map(automations.listForColumn(executing.id).map((row) => [row.name, row.id]));

      const file = build();
      const lastLine = 'The last line of the final message is exactly "Findings: applied".';
      columnNamed(file, 'Executing')!.automations = {
        onTurnEnd: [
          { name: 'On to Code Review', type: 'move_to_column', condition: lastLine, maxRuns: 4, targetColumn: 'Code Review' },
          { name: 'Apply findings', type: 'send_message', message: 'Apply them, then end with the line "Findings: applied".' },
        ],
      };
      applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(file)) as BoardConfig);

      const after = automations.listForColumn(executing.id).filter((row) => row.trigger === 'turn_end');
      expect(after.map((row) => [row.name, row.position, row.condition])).toEqual([
        ['On to Code Review', 0, lastLine],
        ['Apply findings', 1, null],
      ]);
      // Same ids, so once-per-visit and Frequency history carry over.
      for (const row of after) expect(row.id).toBe(before.get(row.name));
    });

    describe('Text match (condition.text, and the legacy finalLine)', () => {
      it('writes condition.text, one pattern as a string, and round-trips it through apply with the row\'s id', () => {
        const { lanes, automations } = freshDatabase();
        const codeReview = lanes.list().find((lane) => lane.name === 'Code Review')!;
        automations.replaceForColumn(codeReview.id, [
          { name: 'On to Testing', type: 'move_to_column', trigger: 'turn_end', enabled: true, config: { targetColumn: 'Testing' }, final_line: 'Verdict: Ready', max_runs: 1 },
        ]);
        const [before] = automations.listForColumn(codeReview.id);

        const first = build();
        expect(columnNamed(first, 'Code Review')?.automations?.onTurnEnd).toEqual([
          { name: 'On to Testing', type: 'move_to_column', condition: { text: 'Verdict: Ready' }, maxRuns: 1, targetColumn: 'Testing' },
        ]);

        applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(first)) as BoardConfig);
        const [after] = automations.listForColumn(codeReview.id);
        expect(after).toMatchObject({ id: before.id, final_line: 'Verdict: Ready', condition: null, max_runs: 1 });
        expect(build().columns).toEqual(first.columns);
      });

      it('writes several patterns as a list, ! kept, and round-trips them', () => {
        const { lanes, automations } = freshDatabase();
        const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
        automations.replaceForColumn(executing.id, [
          { name: 'Apply findings', type: 'send_message', trigger: 'turn_end', enabled: true, config: { message: 'Apply them.' }, final_line: '!Design: waiting on you\n!Design: shelved' },
        ]);

        const first = build();
        expect(columnNamed(first, 'Executing')?.automations?.onTurnEnd?.[0]).toMatchObject({
          condition: { text: ['!Design: waiting on you', '!Design: shelved'] },
        });
        applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(first)) as BoardConfig);
        expect(automations.listForColumn(executing.id)[0]?.final_line).toBe('!Design: waiting on you\n!Design: shelved');
        expect(build().columns).toEqual(first.columns);
      });

      // #1078: the long form says the Text match reads the user's message, and round-trips.
      it('writes a Text match on the user\'s message in the long form and round-trips it', () => {
        const { lanes, automations } = freshDatabase();
        const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
        automations.replaceForColumn(executing.id, [
          {
            name: 'On to Code Review', type: 'move_to_column', trigger: 'turn_end', enabled: true,
            config: { targetColumn: 'Code Review' }, final_line: '*signed off*\n!*not signed off*', text_match_source: 'user', max_runs: 1,
          },
        ]);

        const first = build();
        expect(columnNamed(first, 'Executing')?.automations?.onTurnEnd?.[0]).toMatchObject({
          condition: { text: { from: 'user', patterns: ['*signed off*', '!*not signed off*'] } },
        });
        applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(first)) as BoardConfig);
        expect(automations.listForColumn(executing.id)[0]).toMatchObject({ final_line: '*signed off*\n!*not signed off*', text_match_source: 'user' });
        expect(build().columns).toEqual(first.columns);
      });

      it('reads the long form from the agent as the agent\'s line', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Agent long', type: 'notify', condition: { text: { from: 'agent', patterns: 'Verdict: Ready' } } },
            ],
          },
        });
        expect(plan.rows.map((row) => [row.name, row.final_line, row.text_match_source])).toEqual([
          ['Agent long', 'Verdict: Ready', 'agent'],
        ]);
      });

      it('keeps the column when a long form names an unknown from, and never plans the row unguarded', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Agent long', type: 'notify', condition: { text: { from: 'agent', patterns: 'Verdict: Ready' } } },
              { name: 'Unknown from', type: 'notify', condition: { text: { from: 'owner', patterns: 'signed off' } } as unknown as { text: string } },
            ],
          },
        });
        expect(plan.keepExisting).toBe(true);
        expect(plan.rows).toEqual([]);
        expect(plan.warnings).toEqual([
          'Automation "Unknown from" on "Code Review" has a condition.text that is not { "from": "agent" | "user", "patterns": ... }.',
          '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
        ]);
      });

      it('reads what older builds wrote: a string condition as an Agent evaluation, finalLine as text with its ! taken off', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Judged', type: 'notify', condition: 'The review is clean' },
              { name: 'Legacy', type: 'notify', finalLine: '!Verdict: Ready' },
              { name: 'Only bang', type: 'notify', finalLine: '!' },
            ],
          },
        });

        expect(plan.rows.map((row) => [row.name, row.condition, row.final_line])).toEqual([
          ['Judged', 'The review is clean', null],
          ['Legacy', null, 'Verdict: Ready'],
          // Never ran, and still cannot: kept as written, and said so.
          ['Only bang', null, '!'],
        ]);
        expect(plan.warnings).toEqual([
          'Automation "Only bang" on "Code Review" has a finalLine with no letter, number or *, so no last line can match it and the row never runs.',
        ]);
      });

      // A Condition this build cannot read is never dropped from its row: that
      // ran guarded Move to column rows as unguarded moves for four days. The
      // column keeps what it has instead, and the file is left for a person.
      it('keeps the column over each condition shape it cannot read, naming each', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onEnter: [{ name: 'Too early', type: 'notify', condition: { text: 'Verdict: Ready' } }],
            onTurnEnd: [
              { name: 'Empty object', type: 'notify', condition: {} as unknown as { text: string } },
              { name: 'Unknown kind', type: 'notify', condition: { pattern: 'A' } as unknown as { text: string } },
              { name: 'Bad list', type: 'notify', condition: { text: ['A', 3] as unknown as string[] } },
              { name: 'Bad agent', type: 'notify', condition: { agent: 3 as unknown as string } },
            ],
          },
        });

        expect(plan.keepExisting).toBe(true);
        expect(plan.rows).toEqual([]);
        expect(plan.warnings).toEqual([
          'Automation "Too early" on "Code Review" has a condition.text in onEnter. A text match reads the agent\'s last message, so it works in onTurnEnd only.',
          'Automation "Empty object" on "Code Review" has a condition that is not { "text": ... }, { "agent": ... } or both.',
          'Automation "Unknown kind" on "Code Review" has a condition that is not { "text": ... }, { "agent": ... } or both.',
          'Automation "Bad list" on "Code Review" has a condition.text that is not text or a list of text.',
          'Automation "Bad agent" on "Code Review" has a condition.agent that is not text.',
          '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
        ]);
      });

      it('plans readable conditions beside a finalLine and a never-matching pattern, each said so', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Beside', type: 'notify', condition: { text: 'Verdict: Ready' }, finalLine: 'Done' },
              { name: 'Rule line', type: 'notify', condition: { text: ['Verdict: Ready', '!---'] } },
            ],
          },
        });

        expect(plan.keepExisting).toBe(false);
        expect(plan.rows.map((row) => [row.name, row.condition, row.final_line])).toEqual([
          ['Beside', null, 'Verdict: Ready'],
          ['Rule line', null, 'Verdict: Ready\n!---'],
        ]);
        expect(plan.warnings).toEqual([
          'Automation "Beside" on "Code Review" has both a condition and a finalLine. It keeps the condition.',
          'Automation "Rule line" on "Code Review" has a condition.text pattern "!---" with no letter, number or *, so it can never match.',
        ]);
      });

      it('moves a row from a Condition to a Text match when the file says so, keeping its id', () => {
        const { lanes, automations } = freshDatabase();
        const testing = lanes.list().find((lane) => lane.name === 'Testing')!;
        automations.replaceForColumn(testing.id, [
          { name: 'On to Merge', type: 'move_to_column', trigger: 'turn_end', enabled: true, config: {}, condition: 'The PR is ready to merge.', final_line: null },
        ]);
        const [before] = automations.listForColumn(testing.id);

        const file = build();
        columnNamed(file, 'Testing')!.automations = {
          onTurnEnd: [{ name: 'On to Merge', type: 'move_to_column', finalLine: 'PR: ready to merge' }],
        };
        applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(file)) as BoardConfig);

        const [after] = automations.listForColumn(testing.id);
        expect(after).toMatchObject({ id: before.id, condition: null, final_line: 'PR: ready to merge' });
      });

      it('keeps the column over a finalLine that is not text and one off a turn end', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onEnter: [{ name: 'Too early', type: 'notify', finalLine: 'Verdict: Ready' }],
            onTurnEnd: [{ name: 'Number', type: 'notify', finalLine: 3 as unknown as string }],
          },
        });

        expect(plan.keepExisting).toBe(true);
        expect(plan.rows).toEqual([]);
        expect(plan.warnings).toEqual([
          'Automation "Too early" on "Code Review" has a finalLine in onEnter. A text match reads the agent\'s last message, so it works in onTurnEnd only.',
          'Automation "Number" on "Code Review" has a finalLine that is not text.',
          '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
        ]);
      });

      it('reads a finalLine beside a string condition, a blank one, and one that can never match', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Both', type: 'notify', condition: 'The review is clean', finalLine: 'Verdict: Ready' },
              { name: 'Blank', type: 'notify', finalLine: '   ' },
              { name: 'Rule', type: 'notify', finalLine: '---' },
            ],
          },
        });

        expect(plan.rows.map((row) => [row.name, row.condition, row.final_line])).toEqual([
          ['Both', null, 'Verdict: Ready'],
          ['Blank', null, null],
          // Kept: dropped, the row would run at every turn end.
          ['Rule', null, '---'],
        ]);
        expect(plan.warnings).toEqual([
          'Automation "Both" on "Code Review" has both a condition and a finalLine. It keeps the finalLine.',
          'Automation "Rule" on "Code Review" has a finalLine with no letter, number or *, so no last line can match it and the row never runs.',
        ]);
      });

      it('keeps the column when a condition object beside a finalLine is malformed, rather than guess which guard was meant', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Empty object', type: 'notify', condition: {} as unknown as { text: string }, finalLine: 'Findings: applied' },
              { name: 'Bad agent', type: 'notify', condition: { agent: 3 } as unknown as { text: string }, finalLine: 'Findings: applied' },
              { name: 'Bad text', type: 'notify', condition: { text: 5 } as unknown as { text: string }, finalLine: 'Findings: applied' },
            ],
          },
        });

        expect(plan.keepExisting).toBe(true);
        expect(plan.rows).toEqual([]);
        expect(plan.warnings).toEqual([
          'Automation "Empty object" on "Code Review" has a condition that is not { "text": ... }, { "agent": ... } or both.',
          'Automation "Bad agent" on "Code Review" has a condition.agent that is not text.',
          'Automation "Bad text" on "Code Review" has a condition.text that is not text or a list of text.',
          '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
        ]);
      });

      it('keeps the finalLine beside an empty condition.text, with no "both" warning', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [{ name: 'Empty text', type: 'notify', condition: { text: [] }, finalLine: 'Done' }],
          },
        });

        expect(plan.rows.map((row) => [row.condition, row.final_line])).toEqual([[null, 'Done']]);
        expect(plan.warnings).toEqual([]);
      });

      it('keeps a valid condition.text over a finalLine, and a string condition loses to the finalLine, each said so', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Object', type: 'notify', condition: { text: 'Ready' }, finalLine: 'Done' },
              { name: 'String', type: 'notify', condition: 'The review is clean', finalLine: 'Done' },
            ],
          },
        });

        expect(plan.rows.map((row) => [row.name, row.condition, row.final_line])).toEqual([
          ['Object', null, 'Ready'],
          ['String', null, 'Done'],
        ]);
        expect(plan.warnings).toEqual([
          'Automation "Object" on "Code Review" has both a condition and a finalLine. It keeps the condition.',
          'Automation "String" on "Code Review" has both a condition and a finalLine. It keeps the finalLine.',
        ]);
      });

      it('keeps the column over a malformed long form (an extra key, non-text patterns) and names the long form', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Extra key', type: 'notify', condition: { text: { from: 'user', patterns: 'x', other: 1 } } as unknown as { text: string } },
              { name: 'Number patterns', type: 'notify', condition: { text: { from: 'user', patterns: 5 } } as unknown as { text: string } },
            ],
          },
        });

        expect(plan.keepExisting).toBe(true);
        expect(plan.rows).toEqual([]);
        expect(plan.warnings).toEqual([
          'Automation "Extra key" on "Code Review" has a condition.text that is not { "from": "agent" | "user", "patterns": ... }.',
          'Automation "Number patterns" on "Code Review" has a condition.text that is not { "from": "agent" | "user", "patterns": ... }.',
          '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
        ]);
      });

      it('keeps a user long form over a legacy finalLine, source included', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'User wins', type: 'notify', condition: { text: { from: 'user', patterns: 'Ready' } } as unknown as { text: string }, finalLine: 'Done' },
            ],
          },
        });

        expect(plan.rows.map((row) => [row.name, row.final_line, row.text_match_source])).toEqual([
          ['User wins', 'Ready', 'user'],
        ]);
        expect(plan.warnings).toEqual([
          'Automation "User wins" on "Code Review" has both a condition and a finalLine. It keeps the condition.',
        ]);
      });

      it('keeps the column when a long form beside a finalLine is unreadable, rather than fall back to the finalLine', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onTurnEnd: [
              { name: 'Bad long form', type: 'notify', condition: { text: { from: 'user', patterns: 5 } } as unknown as { text: string }, finalLine: 'Done' },
            ],
          },
        });

        expect(plan.keepExisting).toBe(true);
        expect(plan.rows).toEqual([]);
      });

      it('warns naming condition.text for a pattern of only punctuation, and keeps it', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: { onTurnEnd: [{ name: 'Rule', type: 'notify', condition: { text: '---' } }] },
        });

        expect(plan.rows.map((row) => [row.condition, row.final_line])).toEqual([[null, '---']]);
        expect(plan.warnings).toEqual([
          'Automation "Rule" on "Code Review" has a condition.text with no letter, number or *, so no last line can match it and the row never runs.',
        ]);
      });

      it('round-trips a condition.text list with a ! pattern: imported, then exported, gives the same list', () => {
        const { lanes, automations } = freshDatabase();
        const file = build();
        columnNamed(file, 'Executing')!.automations = {
          onTurnEnd: [{ name: 'Apply findings', type: 'send_message', message: 'Apply them.', condition: { text: ['Ready for *', '!Ready for review'] } }],
        };
        applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(file)) as BoardConfig);

        const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
        expect(automations.listForColumn(executing.id)[0]?.final_line).toBe('Ready for *\n!Ready for review');
        expect(columnNamed(build(), 'Executing')?.automations?.onTurnEnd?.[0]).toMatchObject({
          condition: { text: ['Ready for *', '!Ready for review'] },
        });
      });
    });

    it('warns and skips a Move to column row filed under onEnter or onExit', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: {
          onEnter: [{ name: 'Too early', type: 'move_to_column', targetColumn: 'Executing' }],
          onExit: [{ name: 'Too late', type: 'move_to_column' }],
          onTurnEnd: [{ name: 'Clean', type: 'move_to_column' }],
        },
      });

      expect(plan.rows.map((row) => row.name)).toEqual(['Clean']);
      expect(plan.warnings).toHaveLength(2);
      expect(plan.warnings[0]).toContain('"Too early"');
      expect(plan.warnings[0]).toContain('onTurnEnd');
    });

    it('keeps the column when onTurnEnd is not a list', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: { onTurnEnd: { name: 'Clean', type: 'move_to_column' } } as unknown as BoardColumnAutomations,
      });

      expect(plan.keepExisting).toBe(true);
      expect(plan.rows).toEqual([]);
      expect(plan.warnings[0]).toContain('onTurnEnd must be a list');
    });

    it('reads a blank condition as off with no warning', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: { onTurnEnd: [{ name: 'Blank', type: 'notify', condition: '   ' }] },
      });

      expect(plan.rows.map((row) => [row.name, row.condition, row.max_runs])).toEqual([['Blank', null, null]]);
      expect(plan.warnings).toEqual([]);
    });

    // A blank condition is a deliberate "off"; a guard of the wrong type is not.
    // Read as no limit, a hand-edited "3" would let a review loop run forever.
    it('keeps the column over a maxRuns of the wrong type, and never plans the row without its limit', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: { onTurnEnd: [{ name: 'Text limit', type: 'notify', maxRuns: '3' as unknown as number }] },
      });

      expect(plan.keepExisting).toBe(true);
      expect(plan.rows).toEqual([]);
      expect(plan.warnings).toEqual([
        'Automation "Text limit" on "Code Review" has a maxRuns that is not a number.',
        '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
      ]);
    });

    // The MCP writer refuses a maxRuns that is not a whole number of at least 1,
    // so a file carrying one was hand-edited. It used to be read quietly: a 0 ran
    // the row with no limit and nothing said so, in a loop whose limit exists to
    // stop it.
    describe('a numeric maxRuns that is not a whole number of at least 1', () => {
      function planForMaxRuns(maxRuns: number) {
        return planColumnAutomations({
          name: 'Code Review',
          automations: { onTurnEnd: [{ name: 'Loop', type: 'notify', maxRuns }] },
        });
      }

      it('warns that a 0 runs without a limit, and stores no limit', () => {
        const plan = planForMaxRuns(0);

        expect(plan.rows.map((row) => row.max_runs)).toEqual([null]);
        expect(plan.warnings).toEqual([
          'Automation "Loop" on "Code Review" has a maxRuns of 0, which is not a whole number of at least 1. It runs without a limit.',
        ]);
      });

      it.each([-1, 0.5])('warns that a %s runs without a limit, and stores no limit', (maxRuns) => {
        const plan = planForMaxRuns(maxRuns);

        expect(plan.rows.map((row) => row.max_runs)).toEqual([null]);
        expect(plan.warnings).toEqual([
          `Automation "Loop" on "Code Review" has a maxRuns of ${maxRuns}, which is not a whole number of at least 1. It runs without a limit.`,
        ]);
      });

      it('warns that a 2.5 is read as 2, and stores 2', () => {
        const plan = planForMaxRuns(2.5);

        expect(plan.rows.map((row) => row.max_runs)).toEqual([2]);
        expect(plan.warnings).toEqual([
          'Automation "Loop" on "Code Review" has a maxRuns of 2.5, which is not a whole number of at least 1. Its limit is read as 2.',
        ]);
      });

      it('warns about nothing for a whole number of at least 1', () => {
        const plan = planForMaxRuns(3);

        expect(plan.rows.map((row) => row.max_runs)).toEqual([3]);
        expect(plan.warnings).toEqual([]);
      });

      it('reaches the apply result and the database, not just the planner', () => {
        const { lanes, automations } = freshDatabase();
        const config = build();
        columnNamed(config, 'Code Review')!.automations = {
          onTurnEnd: [
            { name: 'Unlimited', type: 'notify', maxRuns: 0 },
            { name: 'Floored', type: 'notify', maxRuns: 2.5 },
            { name: 'Whole', type: 'notify', maxRuns: 3 },
          ],
        };

        const { warnings } = applyBoardConfigToDb('p1', config);

        const codeReview = lanes.list().find((lane) => lane.name === 'Code Review')!;
        expect(automations.listForColumn(codeReview.id).map((row) => [row.name, row.max_runs])).toEqual([
          ['Unlimited', null],
          ['Floored', 2],
          ['Whole', 3],
        ]);
        expect(warnings.filter((warning) => warning.includes('maxRuns'))).toEqual([
          'Automation "Unlimited" on "Code Review" has a maxRuns of 0, which is not a whole number of at least 1. It runs without a limit.',
          'Automation "Floored" on "Code Review" has a maxRuns of 2.5, which is not a whole number of at least 1. Its limit is read as 2.',
        ]);
      });
    });

    it('keeps the column over a condition that is not text or an object', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: {
          onTurnEnd: [{ name: 'Numbered', type: 'notify', condition: 5 as unknown as string }],
        },
      });

      expect(plan.keepExisting).toBe(true);
      expect(plan.rows).toEqual([]);
      expect(plan.warnings).toEqual([
        'Automation "Numbered" on "Code Review" has a condition that is not text or an object.',
        '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
      ]);
    });

    // The incident: a build that could not read a row's guard applied the row
    // without it, and its export wrote the loss into the committed file. Now the
    // database keeps the guarded row, and the file keeps what it said.
    it('keeps the guarded row in the database when the file\'s guard for it cannot be read', () => {
      const { lanes, automations } = freshDatabase();
      const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
      automations.replaceForColumn(executing.id, [
        { name: 'On to Code Review', type: 'move_to_column', trigger: 'turn_end', enabled: true, config: { targetColumn: 'Code Review' }, final_line: 'Ready for review', max_runs: 3 },
      ]);
      const config = build();
      columnNamed(config, 'Executing')!.automations = {
        onTurnEnd: [{ name: 'On to Code Review', type: 'move_to_column', targetColumn: 'Code Review', condition: { regex: 'Ready' } as unknown as { text: string } }],
      };

      const { warnings } = applyBoardConfigToDb('p1', config);

      expect(automations.listForColumn(executing.id)).toMatchObject([{ name: 'On to Code Review', final_line: 'Ready for review', max_runs: 3 }]);
      expect(warnings).toContain('"Executing" has an automation this build cannot read. Kept the column\'s current automations.');
    });
  });

  // A build migrates an older file to the newest format on update: the apply
  // converts each legacy key, and the open-time export writes none of them.
  describe('migrating a version 1 file to the newest format', () => {
    it('converts every legacy key on apply, and the export writes the newest shape with each guard and message kept', () => {
      const { lanes, automations } = freshDatabase();
      const legacy = build() as BoardConfig & Record<string, unknown>;
      const executing = columnNamed(legacy, 'Executing')!;
      executing.automations = {
        onTurnEnd: [
          { name: 'On to Code Review', type: 'move_to_column', targetColumn: 'Code Review', finalLine: '!Ready for review' },
          { name: 'Judged', type: 'notify', condition: 'The plan was approved' },
        ],
        onEnter: [{ name: 'Kickoff', type: 'send_command', command: '/start' }],
      };
      const codeReview = columnNamed(legacy, 'Code Review')! as BoardColumnConfig & Record<string, unknown>;
      delete codeReview.automations;
      codeReview.autoCommand = '/code-review';
      codeReview.permissionStrategy = 'bypass-permissions';
      const file = JSON.parse(JSON.stringify(legacy)) as BoardConfig;
      migrateBoardColumnFields(file);

      const { warnings } = applyBoardConfigToDb('p1', file);
      const exported = build();

      expect(warnings).toEqual([]);
      // Nothing here uses a Task filter or two-kind condition, so the file stays at format 1.
      expect(exported.version).toBe(1);
      expect(fileFormatVersionFor(exported.columns)).toBe(1);
      const text = JSON.stringify(exported);
      for (const legacyKey of ['"finalLine"', '"autoCommand"', '"autoCommandMode"', '"permissionStrategy"', '"actions"', '"transitions"', '"command"', 'send_command']) {
        expect(text).not.toContain(legacyKey);
      }
      expect(columnNamed(exported, 'Executing')?.automations).toEqual({
        onEnter: [{ name: 'Kickoff', type: 'send_message', message: '/start' }],
        onTurnEnd: [
          { name: 'On to Code Review', type: 'move_to_column', targetColumn: 'Code Review', condition: { text: 'Ready for review' } },
          { name: 'Judged', type: 'notify', condition: { agent: 'The plan was approved' } },
        ],
      });
      expect(columnNamed(exported, 'Code Review')).toMatchObject({
        permissionMode: 'bypassPermissions',
        automations: { onEnter: [{ name: 'Message', type: 'send_message', message: '/code-review' }] },
      });
      const reviewLane = lanes.list().find((lane) => lane.name === 'Code Review')!;
      expect(automations.listForColumn(reviewLane.id)).toHaveLength(1);
    });

    it('warns that a newer file was saved by a newer version, and applies what it can read', () => {
      freshDatabase();
      const newer = { ...build(), version: CURRENT_VERSION + 1 };
      columnNamed(newer, 'Executing')!.color = '#123456';

      const { warnings, applied } = applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(newer)) as BoardConfig);

      expect(applied).toBe(true);
      expect(warnings).toContain(newerFormatReason(CURRENT_VERSION + 1));
      expect(columnNamed(build(), 'Executing')?.color).toBe('#123456');
    });
  });

  // Keys format 1 wrote and format 2 retired. Past their last version they are
  // warned about and not applied, never silently dropped or converted.
  describe('retired keys in a file of format 2', () => {
    const executingLane = (lanes: InstanceType<typeof SwimlaneRepository>) =>
      lanes.list().find((lane) => lane.name === 'Executing')!;

    it('skips top-level actions and transitions, and warns for each', () => {
      const { database } = freshDatabase();
      const config = { ...build(), version: 2 } as BoardConfig;
      config.actions = [{ name: 'Retired script', type: 'run_script', config: { script: 'echo hi' } }];
      config.transitions = [{ from: '*', to: 'Executing', actions: ['Retired script'] }];

      const { warnings } = applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(config)) as BoardConfig);

      expect(warnings).toContain('kangentic.json uses actions, which file format 2 no longer reads. Skipped.');
      expect(warnings).toContain('kangentic.json uses transitions, which file format 2 no longer reads. Skipped.');
      expect(new ActionRepository(database).list().map((action) => action.name)).not.toContain('Retired script');
      expect(database.prepare('SELECT COUNT(*) AS total FROM swimlane_transitions').get()).toEqual({ total: 0 });
    });

    it('still reconciles top-level actions and transitions in a version 1 file', () => {
      const { database } = freshDatabase();
      const config = { ...build(), version: 1 } as BoardConfig;
      config.actions = [{ name: 'Old script', type: 'run_script', config: { script: 'echo hi' } }];
      config.transitions = [{ from: '*', to: 'Executing', actions: ['Old script'] }];

      const { warnings } = applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(config)) as BoardConfig);

      expect(warnings.some((warning) => warning.includes('no longer reads'))).toBe(false);
      expect(new ActionRepository(database).list().map((action) => action.name)).toContain('Old script');
      expect(database.prepare('SELECT COUNT(*) AS total FROM swimlane_transitions').get()).toEqual({ total: 1 });
    });

    it('warns about permissionStrategy and keeps the column\'s current permission mode', () => {
      const { lanes } = freshDatabase();
      lanes.update({ id: executingLane(lanes).id, permission_mode: 'acceptEdits' });
      const config = { ...build(), version: 2 } as BoardConfig;
      const executing = columnNamed(config, 'Executing')! as BoardColumnConfig & Record<string, unknown>;
      delete executing.permissionMode;
      executing.permissionStrategy = 'bypassPermissions';

      const { warnings } = applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(config)) as BoardConfig);

      expect(warnings).toContain('Column "Executing" uses permissionStrategy, which file format 2 no longer reads. Kept its current permission mode.');
      expect(executingLane(lanes).permission_mode).toBe('acceptEdits');
    });

    it('warns about an old permissionMode value and keeps the column\'s current permission mode', () => {
      const { lanes } = freshDatabase();
      lanes.update({ id: executingLane(lanes).id, permission_mode: 'acceptEdits' });
      const config = { ...build(), version: 2 } as BoardConfig;
      (columnNamed(config, 'Executing') as unknown as Record<string, unknown>).permissionMode = 'bypass-permissions';

      const { warnings } = applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(config)) as BoardConfig);

      expect(warnings).toContain('Column "Executing" uses an old permissionMode value, which file format 2 no longer reads. Kept its current permission mode.');
      expect(executingLane(lanes).permission_mode).toBe('acceptEdits');
    });
  });

  describe('keeping what this build does not understand', () => {
    // A file written by a NEWER build. The list, the row type and the row key are
    // invented: they stand for whatever a later release adds.
    function newerFile(executingId: string): BoardConfig {
      return {
        version: 1,
        columns: [{
          id: executingId,
          name: 'Executing',
          automations: {
            onEnter: [
              { name: 'Setup', type: 'run_script', script: 'npm ci', retryLimit: 2 },
              { name: 'Post to chat', type: 'post_chat_message', channel: 'builds' },
              { name: 'Ping', type: 'webhook', url: 'https://hooks.example.com/abc' },
            ],
            onPullRequestMerged: [{ name: 'Close the loop', type: 'notify' }],
          } as unknown as BoardColumnAutomations,
        }],
      };
    }

    function seedExecuting() {
      const fixture = freshDatabase();
      const executing = fixture.lanes.list().find((lane) => lane.name === 'Executing')!;
      return { ...fixture, executing };
    }

    it('applies what it knows and warns about the type it does not', () => {
      const { executing, automations } = seedExecuting();
      const result = applyBoardConfigToDb('p1', newerFile(executing.id));

      expect(automations.listForColumn(executing.id).map((row) => row.name)).toEqual(['Setup', 'Ping']);
      expect(result.warnings.some((warning) => warning.includes('post_chat_message'))).toBe(true);
    });

    it('carries the unknown list, row type and row key into the next export', () => {
      const { executing } = seedExecuting();
      const file = newerFile(executing.id);
      applyBoardConfigToDb('p1', file);

      const exported = buildBoardConfigFromDb({ projectId: 'p1', existingTeamConfig: file, fingerprint: 'test' });
      const automations = columnNamed(exported, 'Executing')?.automations as Record<string, unknown> | undefined;

      // The unknown row keeps its place in the run order, after the row it followed.
      expect(automations?.onEnter).toEqual([
        { name: 'Setup', type: 'run_script', script: 'npm ci', retryLimit: 2 },
        { name: 'Post to chat', type: 'post_chat_message', channel: 'builds' },
        { name: 'Ping', type: 'webhook', url: 'https://hooks.example.com/abc' },
      ]);
      expect(automations?.onPullRequestMerged).toEqual([{ name: 'Close the loop', type: 'notify' }]);
    });

    // Where the unknown row lands once the row it followed is gone. The file's
    // order is the run order, so a wrong spot changes what runs first.
    describe('placing an unknown row when a neighbor was deleted', () => {
      const setup = { name: 'Setup', type: 'run_script', script: 'npm ci' };
      const ping = { name: 'Ping', type: 'webhook', url: 'https://hooks.example.com/abc' };
      const postToChat = { name: 'Post to chat', type: 'post_chat_message', channel: 'builds' };
      const announce = { name: 'Announce', type: 'announce_build', target: 'builds' };

      const setupInDatabase: AutomationWriteInput = {
        name: 'Setup', type: 'run_script', trigger: 'enter', enabled: true, config: { script: 'npm ci' },
      };
      const pingInDatabase: AutomationWriteInput = {
        name: 'Ping', type: 'webhook', trigger: 'enter', enabled: true, config: { url: 'https://hooks.example.com/abc' },
      };

      /**
       * The file on disk (a newer build's, onEnter in the order given) and then the
       * database the user edited down to `keptInDatabase`. Returns the exported
       * onEnter names, in order.
       */
      function exportAfterKeeping(
        fileOnEnter: Array<Record<string, unknown>>,
        keptInDatabase: AutomationWriteInput[],
      ): unknown[] {
        const { executing, automations } = seedExecuting();
        const file: BoardConfig = {
          version: 1,
          columns: [{
            id: executing.id,
            name: 'Executing',
            automations: { onEnter: fileOnEnter } as unknown as BoardColumnAutomations,
          }],
        };
        automations.replaceForColumn(executing.id, keptInDatabase);

        const exported = buildBoardConfigFromDb({ projectId: 'p1', existingTeamConfig: file, fingerprint: 'test' });
        const onEnter = columnNamed(exported, 'Executing')?.automations?.onEnter as Array<Record<string, unknown>>;
        return onEnter.map((row) => row.name);
      }

      it('puts it after the nearest earlier row that is still there, not first, when the row it followed was deleted', () => {
        // The file reads [Setup, Ping, Post to chat]. Ping is deleted, so the
        // export writes [Setup, Post to chat]. Anchored on the deleted Ping, the
        // lookup finds nothing and the unknown row used to land first.
        expect(exportAfterKeeping([setup, ping, postToChat], [setupInDatabase])).toEqual(['Setup', 'Post to chat']);
      });

      it('walks back past more than one deleted row to the nearest one that is left', () => {
        expect(exportAfterKeeping([setup, ping, { ...ping, name: 'Ping 2' }, postToChat], [setupInDatabase]))
          .toEqual(['Setup', 'Post to chat']);
      });

      it('keeps two unknown rows that followed a deleted row together and in order', () => {
        expect(exportAfterKeeping([setup, ping, postToChat, announce], [setupInDatabase]))
          .toEqual(['Setup', 'Post to chat', 'Announce']);
      });

      it('keeps an unknown row that led the list first, even with the row after it deleted', () => {
        expect(exportAfterKeeping([postToChat, setup, ping], [pingInDatabase])).toEqual(['Post to chat', 'Ping']);
      });

      it('leaves the order alone when nothing was deleted', () => {
        expect(exportAfterKeeping([setup, postToChat, ping], [setupInDatabase, pingInDatabase]))
          .toEqual(['Setup', 'Post to chat', 'Ping']);
      });
    });

    it('keeps them across a second apply and export, so they survive every save', () => {
      const { executing } = seedExecuting();
      const file = newerFile(executing.id);
      applyBoardConfigToDb('p1', file);
      const firstExport = buildBoardConfigFromDb({ projectId: 'p1', existingTeamConfig: file, fingerprint: 'test' });
      applyBoardConfigToDb('p1', firstExport);
      const secondExport = buildBoardConfigFromDb({ projectId: 'p1', existingTeamConfig: firstExport, fingerprint: 'test' });

      expect(secondExport.columns).toEqual(firstExport.columns);
    });

    it('drops an unknown key once its row is gone from the database', () => {
      // Matching is by name and type: a row the user deleted takes its unknown
      // keys with it rather than leaving them stranded on a neighbor.
      const { executing, automations } = seedExecuting();
      const file = newerFile(executing.id);
      applyBoardConfigToDb('p1', file);
      automations.replaceForColumn(executing.id, [
        { name: 'Ping', type: 'webhook', trigger: 'enter', enabled: true, config: { url: 'https://hooks.example.com/abc' } },
      ]);

      const exported = buildBoardConfigFromDb({ projectId: 'p1', existingTeamConfig: file, fingerprint: 'test' });
      const onEnter = columnNamed(exported, 'Executing')?.automations?.onEnter as Array<Record<string, unknown>>;

      expect(onEnter.some((row) => 'retryLimit' in row)).toBe(false);
    });
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

    it('keeps a migrated transition script on a column the file says nothing about', () => {
      // The real upgrade shape, taken from a board in the wild: a custom script
      // hung off a `* -> Planning` transition, and three OTHER columns whose
      // only automation is their message. The schema migration turns the
      // transition into Planning's automation; then this apply runs.
      //
      // The trap is that `configDeclaresAutomations` is true for the WHOLE
      // config as soon as any column carries a message, and the reconcile then
      // visits every column. Planning declares nothing, so a plan of zero rows
      // for it would call `replaceForColumn(planning, [])` and delete the
      // script the migration had just rescued, on the first open after upgrade.
      const { lanes, automations } = freshDatabase();
      const planning = lanes.list().find((lane) => lane.name === 'Planning')!;
      automations.replaceForColumn(planning.id, [
        {
          name: 'Move Work Item',
          type: 'run_script',
          trigger: 'enter',
          enabled: true,
          config: { script: 'node scripts/move-work-item.mjs --state InProgress' },
        },
      ]);

      const config = build();
      columnNamed(config, 'Code Review')!.autoCommand = '/code-review';
      columnNamed(config, 'Testing')!.autoCommand = '/pull-request';
      columnNamed(config, 'Merge')!.autoCommand = '/merge-pull-request';
      // Planning's own automations are dropped from the file, exactly as an
      // older build would have written it: it never knew about the key.
      delete columnNamed(config, 'Planning')!.automations;

      applyBoardConfigToDb('p1', config);

      expect(automations.listForColumn(planning.id).map((row) => row.name)).toEqual(['Move Work Item']);
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

    // `idx_column_automations_name` is UNIQUE on (swimlane_id, name COLLATE
    // NOCASE) with no `trigger` column, so a hand-written file naming the same
    // automation on both onEnter and onExit used to throw inside
    // applyBoardConfigToDb's transaction, taking down the WHOLE board reconcile
    // on project open, not just this column.
    it('dedupes a name repeated across onEnter and onExit rather than blowing up the whole reconcile', () => {
      const { lanes, automations } = freshDatabase();
      const config = build();
      columnNamed(config, 'Executing')!.automations = {
        onEnter: [{ name: 'Notify', type: 'send_message', message: '/enter-ping' }],
        onExit: [{ name: 'Notify', type: 'send_message', message: '/exit-ping' }],
      };

      const { warnings } = applyBoardConfigToDb('p1', config);

      const lane = lanes.list().find((candidate) => candidate.name === 'Executing')!;
      const rows = automations.listForColumn(lane.id);
      expect(rows.map((row) => [row.trigger, row.name])).toEqual([
        ['enter', 'Notify'],
        ['exit', 'Notify 2'],
      ]);
      expect(warnings.some((warning) => warning.includes('Notify'))).toBe(true);
    });
  });

  // Sentry DESKTOP-1H: `"onEnter": {}` threw "is not iterable" inside the
  // reconcile transaction, so the whole board's apply rolled back and the
  // file-watcher path rejected out of `boardConfig:apply`.
  describe('a malformed automations container', () => {
    it('warns naming the column, keeps its automations, and applies the rest of the board', () => {
      const { lanes, automations } = freshDatabase();
      const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
      automations.replaceForColumn(executing.id, [
        { name: 'Setup', type: 'run_script', trigger: 'enter', enabled: true, config: { script: 'npm ci' } },
      ]);

      const config = build();
      columnNamed(config, 'Executing')!.automations = { onEnter: {}, onExit: 'Notify' } as unknown as BoardColumnAutomations;
      const planningColumn = columnNamed(config, 'Planning')!;
      planningColumn.description = 'Scoped by the file';
      planningColumn.automations = {
        onEnter: [{ name: 'Plan ping', type: 'webhook', url: 'https://hooks.example.com/plan' }],
      };

      let warnings: string[] = [];
      expect(() => {
        warnings = applyBoardConfigToDb('p1', config).warnings;
      }).not.toThrow();

      expect(warnings.some((warning) => warning.includes('"Executing"'))).toBe(true);
      // Kept, not cleared: on project open the export runs next and would
      // otherwise write the deletion into the committed file.
      expect(automations.listForColumn(executing.id).map((row) => row.name)).toEqual(['Setup']);
      const planning = lanes.list().find((lane) => lane.name === 'Planning')!;
      expect(planning.description).toBe('Scoped by the file');
      expect(automations.listForColumn(planning.id).map((row) => row.name)).toEqual(['Plan ping']);
    });

    it('does not let a malformed value flip a legacy file to automation-aware', () => {
      // No column carries a well-formed `automations` key, so a column the file
      // is silent about keeps what the database has. `"automations": "x"` on
      // one column used to count as declaring the key and cleared every other.
      const { lanes, automations } = freshDatabase();
      const planning = lanes.list().find((lane) => lane.name === 'Planning')!;
      automations.replaceForColumn(planning.id, [
        { name: 'Kept', type: 'webhook', trigger: 'enter', enabled: true, config: { url: 'https://example.com' } },
      ]);

      const config = build();
      for (const column of config.columns) delete column.automations;
      columnNamed(config, 'Executing')!.automations = 'x' as unknown as BoardColumnAutomations;

      const { warnings } = applyBoardConfigToDb('p1', config);

      expect(automations.listForColumn(planning.id).map((row) => row.name)).toEqual(['Kept']);
      expect(warnings.some((warning) => warning.includes('"Executing"'))).toBe(true);
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

// `planColumnAutomations` is a pure function of one `BoardColumnConfig`, with
// no database underneath it, so the dedup behavior is pinned directly.
describe('planColumnAutomations name dedup', () => {
  function columnWithDuplicateName(): BoardColumnConfig {
    return {
      name: 'Executing',
      automations: {
        onEnter: [{ name: 'Notify', type: 'send_message', message: '/enter-ping' }],
        onExit: [{ name: 'Notify', type: 'send_message', message: '/exit-ping' }],
      },
    };
  }

  it('renames the later of two same-named rows across onEnter and onExit', () => {
    const plan = planColumnAutomations(columnWithDuplicateName());

    expect(plan.rows.map((row) => [row.trigger, row.name])).toEqual([
      ['enter', 'Notify'],
      ['exit', 'Notify 2'],
    ]);
  });

  it('warns naming the rename', () => {
    const plan = planColumnAutomations(columnWithDuplicateName());

    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('Notify');
    expect(plan.warnings[0]).toContain('Notify 2');
  });

  it('does not throw building the plan for a same-column name collision', () => {
    expect(() => planColumnAutomations(columnWithDuplicateName())).not.toThrow();
  });

  it('leaves two distinctly named rows alone, with no warning', () => {
    const plan = planColumnAutomations({
      name: 'Executing',
      automations: {
        onEnter: [{ name: 'Notify', type: 'send_message', message: '/enter-ping' }],
        onExit: [{ name: 'Wrap up', type: 'send_message', message: '/exit-ping' }],
      },
    });

    expect(plan.rows.map((row) => row.name)).toEqual(['Notify', 'Wrap up']);
    expect(plan.warnings).toHaveLength(0);
  });
});

// Also with no database underneath it: the DESKTOP-1H throw lives in the planner.
describe('planColumnAutomations with a malformed container', () => {
  function planFor(automations: unknown) {
    return planColumnAutomations({ name: 'Executing', automations: automations as BoardColumnAutomations });
  }

  it('keeps the column, and does not throw, when onEnter is an object and onExit is not a list', () => {
    const plan = planFor({ onEnter: {}, onExit: 'Notify' });

    expect(plan.keepExisting).toBe(true);
    expect(plan.rows).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('"Executing"');
    expect(plan.warnings[0]).toContain('onEnter');
    expect(plan.warnings[0]).toContain('onExit');
  });

  it('keeps the column when one row was written without brackets, and plans no sibling group', () => {
    const plan = planFor({
      onEnter: { name: 'Setup', type: 'run_script', script: 'npm ci' },
      onExit: [{ name: 'Wrap up', type: 'send_message', message: '/exit-ping' }],
    });

    expect(plan.keepExisting).toBe(true);
    expect(plan.rows).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('onEnter');
    expect(plan.warnings[0]).not.toContain('onExit');
  });

  it('keeps the column over a legacy message when the container is malformed', () => {
    const plan = planColumnAutomations({
      name: 'Executing',
      autoCommand: '/pull-request',
      automations: { onEnter: {} } as unknown as BoardColumnAutomations,
    });

    expect(plan.keepExisting).toBe(true);
    expect(plan.rows).toEqual([]);
  });

  it.each([
    ['a string', 'x'],
    ['an array', []],
    ['a number', 5],
  ])('keeps the column when automations is %s', (_label, value) => {
    const plan = planFor(value);

    expect(plan.keepExisting).toBe(true);
    expect(plan.rows).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('"Executing"');
  });

  it('skips a row that is not an object and keeps the rest of the group', () => {
    const plan = planFor({
      onEnter: [null, 'Setup', { name: 'Setup', type: 'run_script', script: 'npm ci' }],
    });

    expect(plan.keepExisting).toBe(false);
    expect(plan.rows.map((row) => row.name)).toEqual(['Setup']);
    expect(plan.warnings).toHaveLength(2);
    for (const warning of plan.warnings) expect(warning).toContain('not an object');
  });

  it('still reads a null group and a null automations value as none', () => {
    const nullGroup = planFor({
      onEnter: null,
      onExit: [{ name: 'Wrap up', type: 'send_message', message: '/exit-ping' }],
    });
    expect(nullGroup.keepExisting).toBe(false);
    expect(nullGroup.rows.map((row) => row.name)).toEqual(['Wrap up']);
    expect(nullGroup.warnings).toEqual([]);

    const nullAutomations = planFor(null);
    expect(nullAutomations.keepExisting).toBe(false);
    expect(nullAutomations.rows).toEqual([]);
    expect(nullAutomations.warnings).toEqual([]);
  });
});

// Legacy keys are tied to the file format (`LEGACY_FILE_KEYS`): converted in a
// file of a format that carries them, retired in a newer one. A retired key is
// never silently ignored. Ignored, a retired guard would run its row unguarded,
// the incident in reverse.
describe('planColumnAutomations over legacy keys, by file format', () => {
  const legacyColumn = (): BoardColumnConfig => ({
    name: 'Code Review',
    automations: {
      onTurnEnd: [
        { name: 'Judged', type: 'move_to_column', targetColumn: 'Executing', condition: 'The review asks for changes' },
        { name: 'Legacy', type: 'move_to_column', targetColumn: 'Testing', finalLine: 'Verdict: Ready' },
      ],
      onEnter: [{ name: 'Old type', type: 'send_command', command: '/code-review' }],
    },
  });

  it('converts each one in a version 1 file', () => {
    const plan = planColumnAutomations(legacyColumn(), { formatVersion: 1 });

    expect(plan.keepExisting).toBe(false);
    expect(plan.rows.map((row) => [row.name, row.type, row.condition, row.final_line, row.config])).toEqual([
      ['Old type', 'send_message', null, null, { message: '/code-review' }],
      ['Judged', 'move_to_column', 'The review asks for changes', null, { targetColumn: 'Executing' }],
      ['Legacy', 'move_to_column', null, 'Verdict: Ready', { targetColumn: 'Testing' }],
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('converts each one in a file with no version, which is the local file', () => {
    expect(planColumnAutomations(legacyColumn()).keepExisting).toBe(false);
  });

  it('keeps the column in a file of a format past them, naming each retired key', () => {
    const plan = planColumnAutomations(legacyColumn(), { formatVersion: 2 });

    expect(plan.keepExisting).toBe(true);
    expect(plan.rows).toEqual([]);
    expect(plan.warnings).toEqual([
      'Automation "Old type" on "Code Review" uses the send_command type, which file format 2 no longer reads.',
      'Automation "Judged" on "Code Review" uses a condition written as text, which file format 2 no longer reads.',
      'Automation "Legacy" on "Code Review" uses finalLine, which file format 2 no longer reads.',
      '"Code Review" has an automation this build cannot read. Kept the column\'s current automations.',
    ]);
  });

  it('keeps the column over a retired command key on a send_message row', () => {
    const plan = planColumnAutomations({
      name: 'Code Review',
      automations: { onEnter: [{ name: 'Review', type: 'send_message', command: '/code-review' }] },
    }, { formatVersion: 2 });

    expect(plan.keepExisting).toBe(true);
    expect(plan.warnings[0]).toBe('Automation "Review" on "Code Review" uses command, which file format 2 no longer reads.');
  });

  it('keeps the column over a retired autoCommand', () => {
    const plan = planColumnAutomations({ name: 'Planning', autoCommand: '/plan' } as BoardColumnConfig, { formatVersion: 2 });

    expect(plan.keepExisting).toBe(true);
    expect(plan.rows).toEqual([]);
    expect(plan.warnings).toEqual([
      '"Planning" uses autoCommand, which file format 2 no longer reads. Kept the column\'s current automations.',
    ]);
  });

  it('reads a blank retired key as nothing, as a blank one always read', () => {
    const plan = planColumnAutomations({
      name: 'Code Review',
      automations: { onTurnEnd: [{ name: 'Blank', type: 'notify', condition: ' ', finalLine: '' }] },
    }, { formatVersion: 2 });

    expect(plan.keepExisting).toBe(false);
    expect(plan.rows.map((row) => row.name)).toEqual(['Blank']);
  });
});

// A row key this build does not know, in a file a newer build wrote, may be a
// guard it has never heard of. A build reading `condition.text` as noise is how
// guarded moves ran unguarded for four days.
describe('planColumnAutomations over a newer file format', () => {
  it('keeps the column when a row of a known type carries a key this build does not know', () => {
    const plan = planColumnAutomations({
      name: 'Executing',
      automations: {
        onTurnEnd: [{ name: 'On to Code Review', type: 'move_to_column', targetColumn: 'Code Review', onlyWhen: { branch: 'main' } } as unknown as BoardAutomationConfig],
      },
    }, { formatVersion: CURRENT_VERSION + 1 });

    expect(plan.keepExisting).toBe(true);
    expect(plan.warnings).toEqual([
      'Automation "On to Code Review" on "Executing" has "onlyWhen", which this build cannot read.',
      '"Executing" has an automation this build cannot read. Kept the column\'s current automations.',
    ]);
  });

  it('plans a newer file\'s rows that carry only keys this build knows', () => {
    const plan = planColumnAutomations({
      name: 'Executing',
      automations: { onTurnEnd: [{ name: 'On to Code Review', type: 'move_to_column', targetColumn: 'Code Review', condition: { text: 'Ready' } }] },
    }, { formatVersion: CURRENT_VERSION + 1 });

    expect(plan.keepExisting).toBe(false);
    expect(plan.rows.map((row) => [row.name, row.final_line])).toEqual([['On to Code Review', 'Ready']]);
  });

  it('carries an unknown key in a file of this build\'s own format, as the export does', () => {
    const plan = planColumnAutomations({
      name: 'Executing',
      automations: { onEnter: [{ name: 'Setup', type: 'run_script', script: 'npm ci', retryLimit: 2 } as unknown as BoardAutomationConfig] },
    }, { formatVersion: CURRENT_VERSION });

    expect(plan.keepExisting).toBe(false);
    expect(plan.rows.map((row) => row.name)).toEqual(['Setup']);
  });
});
