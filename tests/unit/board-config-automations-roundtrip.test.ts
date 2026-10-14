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
import type { AutomationWriteInput, BoardColumnAutomations, BoardColumnConfig, BoardConfig } from '../../src/shared/types';

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
const { planColumnAutomations } = await import('../../src/main/config/board-config/apply-automations');

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
          condition: 'The review found work the implementer can do',
          maxRuns: 3,
          targetColumn: 'Executing',
          message: 'Back from review:\n{{agentReply}}',
        },
        // No targetColumn: Next column is the absent key, not a stored value.
        { name: 'Clean', type: 'move_to_column', condition: 'The review is clean' },
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

    describe('Text match (finalLine)', () => {
      it('writes finalLine in place of condition, and round-trips it through apply with the row\'s id', () => {
        const { lanes, automations } = freshDatabase();
        const codeReview = lanes.list().find((lane) => lane.name === 'Code Review')!;
        automations.replaceForColumn(codeReview.id, [
          { name: 'On to Testing', type: 'move_to_column', trigger: 'turn_end', enabled: true, config: { targetColumn: 'Testing' }, final_line: 'Verdict: Ready', max_runs: 1 },
        ]);
        const [before] = automations.listForColumn(codeReview.id);

        const first = build();
        expect(columnNamed(first, 'Code Review')?.automations?.onTurnEnd).toEqual([
          { name: 'On to Testing', type: 'move_to_column', finalLine: 'Verdict: Ready', maxRuns: 1, targetColumn: 'Testing' },
        ]);

        applyBoardConfigToDb('p1', JSON.parse(JSON.stringify(first)) as BoardConfig);
        const [after] = automations.listForColumn(codeReview.id);
        expect(after).toMatchObject({ id: before.id, final_line: 'Verdict: Ready', condition: null, max_runs: 1 });
        expect(build().columns).toEqual(first.columns);
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

      it('warns about a finalLine that is not text, one off a turn end, and one beside a condition', () => {
        const plan = planColumnAutomations({
          name: 'Code Review',
          automations: {
            onEnter: [{ name: 'Too early', type: 'notify', finalLine: 'Verdict: Ready' }],
            onTurnEnd: [
              { name: 'Number', type: 'notify', finalLine: 3 as unknown as string },
              { name: 'Both', type: 'notify', condition: 'The review is clean', finalLine: 'Verdict: Ready' },
              { name: 'Blank', type: 'notify', finalLine: '   ' },
              { name: 'Rule', type: 'notify', finalLine: '---' },
            ],
          },
        });

        expect(plan.rows.map((row) => [row.name, row.condition, row.final_line])).toEqual([
          ['Too early', null, null],
          ['Number', null, null],
          ['Both', null, 'Verdict: Ready'],
          ['Blank', null, null],
          // Kept: dropped, the row would run at every turn end.
          ['Rule', null, '---'],
        ]);
        expect(plan.warnings).toEqual([
          'Automation "Too early" on "Code Review" has a finalLine in onEnter. A text match reads the agent\'s last message, so it works in onTurnEnd only. It runs without it.',
          'Automation "Number" on "Code Review" has a finalLine that is not text. It runs without one.',
          'Automation "Both" on "Code Review" has both a condition and a finalLine. A row holds one kind of condition, so it keeps the finalLine.',
          'Automation "Rule" on "Code Review" has a finalLine with no letter, number or *, so no last line can match it and the row never runs.',
        ]);
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

    it('reads a blank condition as off with no warning, and a maxRuns of the wrong type as off with one', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: {
          onTurnEnd: [
            { name: 'Blank', type: 'notify', condition: '   ' },
            { name: 'Text limit', type: 'notify', maxRuns: '3' as unknown as number },
          ],
        },
      });

      expect(plan.rows.map((row) => [row.name, row.condition, row.max_runs])).toEqual([
        ['Blank', null, null],
        ['Text limit', null, null],
      ]);
      // A blank condition is a deliberate "off"; a guard of the wrong type is not.
      expect(plan.warnings).toEqual([
        'Automation "Text limit" on "Code Review" has a maxRuns that is not a number. It runs without a limit.',
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

    it('warns about a condition that is not text, and keeps the row without one', () => {
      const plan = planColumnAutomations({
        name: 'Code Review',
        automations: {
          onTurnEnd: [{ name: 'Numbered', type: 'notify', condition: 5 as unknown as string }],
        },
      });

      expect(plan.rows.map((row) => [row.name, row.condition])).toEqual([['Numbered', null]]);
      expect(plan.warnings).toEqual([
        'Automation "Numbered" on "Code Review" has a condition that is not text. It runs without one.',
      ]);
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
