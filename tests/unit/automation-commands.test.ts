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
 * Real better-sqlite3, the driver production uses. Follows the harness
 * automation-repository.test.ts established.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { BackgroundCallRepository } from '../../src/main/db/repositories/background-call-repository';
import {
  handleListAutomations,
  handleSetAutomations,
  handleGetAutomationRuns,
  handleRunAutomation,
} from '../../src/main/agent/commands/automation-commands';
import { handleUpdateColumn, handleCreateColumn, handleDeleteColumn } from '../../src/main/agent/commands/column-commands';
import { resolveColumnMessage } from '../../src/main/transition-engine/column-strategy';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { AutomationRunAgainResult, BoardProfile } from '../../src/shared/types';

describe('automation MCP commands', () => {
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
    db = openTestDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(db);
    automations = new AutomationRepository(db);
    swimlanes = new SwimlaneRepository(db);
    profiles = [];
    context = makeContext();
  });

  afterEach(() => {
    db.close();
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

    describe('finalLine, the Text match kind', () => {
      it('stores a turn-end Text match, trimmed, and reads it back as finalLine', () => {
        const response = handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'On to Code Review', type: 'move_to_column', on: 'turn_end', targetColumn: 'Code Review', finalLine: '  Findings: applied  ', maxRuns: 4 }],
        }, context);

        expect(response.success).toBe(true);
        const [row] = automations.listForColumn(executingId());
        expect(row).toMatchObject({ final_line: 'Findings: applied', condition: null, max_runs: 4 });
        const [saved] = (response.data as { automations: Array<Record<string, unknown>> }).automations;
        expect(saved).toMatchObject({ finalLine: 'Findings: applied', condition: null, maxRuns: 4 });
      });

      it('refuses a finalLine that is not text, naming the row, and saves nothing', () => {
        const response = handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'Move', type: 'move_to_column', on: 'turn_end', finalLine: 3 }],
        }, context);

        expect(response.success).toBe(false);
        expect(response.error).toBe('automations[0]: finalLine must be text (or null for no text match). Nothing was saved.');
        expect(automations.listForColumn(executingId())).toHaveLength(0);
      });

      it('refuses a finalLine off a turn end, with the reason, and saves nothing', () => {
        const response = handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'Review', type: 'send_message', on: 'enter', message: '/code-review', finalLine: 'Ready for review' }],
        }, context);

        expect(response.success).toBe(false);
        expect(response.error).toContain('finalLine works only with on: "turn_end", not enter.');
        expect(response.error).toContain('Nothing was saved.');
        expect(automations.listForColumn(executingId())).toHaveLength(0);
      });

      it('refuses a finalLine with no letter, number or *, which no last line can match, and saves nothing', () => {
        const response = handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'Move', type: 'move_to_column', on: 'turn_end', finalLine: '---' }],
        }, context);

        expect(response.success).toBe(false);
        expect(response.error).toContain('finalLine "---" has no letter, number or *, so no last line can match it.');
        expect(response.error).toContain('Nothing was saved.');
        expect(automations.listForColumn(executingId())).toHaveLength(0);
      });

      it('accepts a bare wildcard finalLine, which matches any last line', () => {
        const response = handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'Any', type: 'notify', on: 'turn_end', title: 'Done', finalLine: '*' }],
        }, context);

        expect(response.success).toBe(true);
        expect(automations.listForColumn(executingId())[0]?.final_line).toBe('*');
      });

      it('refuses a row with both a condition and a finalLine, and saves nothing', () => {
        const response = handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'Move', type: 'move_to_column', on: 'turn_end', condition: 'The work is done', finalLine: 'Findings: applied' }],
        }, context);

        expect(response.success).toBe(false);
        expect(response.error).toContain('give a condition or a finalLine, not both');
        expect(automations.listForColumn(executingId())).toHaveLength(0);
      });

      it('reads a blank finalLine as none, beside a condition, with no refusal', () => {
        const response = handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'Move', type: 'move_to_column', on: 'turn_end', condition: 'The work is done', finalLine: '   ' }],
        }, context);

        expect(response.success).toBe(true);
        expect(automations.listForColumn(executingId())[0]).toMatchObject({ condition: 'The work is done', final_line: null });
      });

      it('words the Text match in the list, as a guard', () => {
        handleSetAutomations({
          column: 'Executing',
          automations: [{ name: 'On to Code Review', type: 'move_to_column', on: 'turn_end', targetColumn: 'Code Review', finalLine: 'Findings: applied' }],
        }, context);

        const lines = (handleListAutomations({ column: 'Executing' }, context).message ?? '').split('\n');
        expect(lines).toContain('    1. On to Code Review (move_to_column) Moves the task to Code Review'
          + ' (only if the last line reads "Findings: applied")');
      });
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

    // The sentence names only the verb and its value, as the row's second line
    // does, so every option the panel shows as a mark follows in words: an
    // agent reads the text, and the send timing and Move to column's message
    // would otherwise be in `data` alone.
    it('names the marks in words after the sentence', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [
          { name: 'Review', type: 'send_message', message: '/code-review', mode: 'deferred' },
          {
            name: 'Back for revisions',
            type: 'move_to_column',
            on: 'turn_end',
            targetColumn: 'Planning',
            message: '{{agentReply}}\nFix these first.',
            condition: 'The review is clean',
            maxRuns: 3,
          },
          { name: 'Summarize', type: 'send_message', on: 'turn_end', message: 'Summarize', mode: 'deferred' },
        ],
      }, context);

      const lines = (handleListAutomations({ column: 'Executing' }, context).message ?? '').split('\n');
      expect(lines).toContain('    1. Review (send_message) Sends "/code-review" (waits for the current turn to end)');
      expect(lines).toContain('    1. Back for revisions (move_to_column) Moves the task to Planning'
        + ' (with a message; only if the review is clean; at most 3 times for each task)');
      // At a turn end the turn is already over, so a waiting Send message sends at once.
      expect(lines).toContain('    2. Summarize (send_message) Sends "Summarize"');
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

    // autoCommandMode ALONE, no autoCommand in the same call. This used to write
    // only the retired `swimlanes.auto_command_mode` lane field, which the
    // automations migration resets and no delivery path reads, and still report
    // success. The delivered mode lives on the message automation's own config,
    // so a bare mode change has to land there instead.
    it('updates the existing message automation\'s delivery mode when autoCommandMode is set alone', () => {
      handleUpdateColumn({ column: 'Executing', autoCommand: '/review' }, context);
      expect(resolveColumnMessage(automations.listForColumn(executingId()))?.mode).toBe('immediate');

      const response = handleUpdateColumn({ column: 'Executing', autoCommandMode: 'deferred' }, context);

      expect(response.success).toBe(true);
      expect(resolveColumnMessage(automations.listForColumn(executingId()))?.mode).toBe('deferred');
    });

    // With no message row to carry a delivery mode, the call has nothing the
    // engine will ever read, so the caller is told that rather than given a bare
    // success that changed nothing.
    it('says there is no message to apply the mode to, rather than reporting a bare success', () => {
      const response = handleUpdateColumn({ column: 'Executing', autoCommandMode: 'deferred' }, context);

      expect(response.success).toBe(true);
      expect(response.message).toContain('no message for that delivery mode to apply to');
      expect(automations.listForColumn(executingId())).toHaveLength(0);
    });

    it('gives a newly created column its message too', () => {
      const response = handleCreateColumn({ name: 'Brand Review', autoCommand: '/brand' }, context);
      expect(response.success).toBe(true);

      const lane = swimlanes.list().find((candidate) => candidate.name === 'Brand Review');
      expect(resolveColumnMessage(automations.listForColumn(lane!.id))?.message).toBe('/brand');
    });

    // The MCP tool's zod schema already refuses a misspelled autoCommandMode for
    // the released tool, but the mobile bridge and any other direct caller reach
    // this handler with no zod in front of it. Coercing an unrecognized value to
    // 'immediate' (the old behavior) silently changed the delivery mode instead
    // of refusing the call, and still reported success.
    it('refuses an unrecognized autoCommandMode on create rather than coercing it to immediate', () => {
      const response = handleCreateColumn(
        { name: 'Misspelled Mode Column', autoCommand: '/go', autoCommandMode: 'delayed' },
        context,
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain('autoCommandMode');
      expect(swimlanes.list().some((lane) => lane.name === 'Misspelled Mode Column')).toBe(false);
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

    // The message write rebuilds the whole column, so a row it does not touch
    // must come back with its Text match. Losing it would turn a guarded Move
    // into one that fires at every turn end.
    it('keeps another row\'s Text match through the whole-column rewrite, on add, change and delete', () => {
      handleSetAutomations({
        column: 'Executing',
        automations: [{ name: 'On to Code Review', type: 'move_to_column', on: 'turn_end', targetColumn: 'Code Review', finalLine: 'Findings: applied' }],
      }, context);
      const textMatchOf = () => automations.listForColumn(executingId()).find((row) => row.name === 'On to Code Review')?.final_line;

      handleUpdateColumn({ column: 'Executing', autoCommand: '/first' }, context);
      expect(textMatchOf()).toBe('Findings: applied');
      handleUpdateColumn({ column: 'Executing', autoCommand: '/second', autoCommandMode: 'deferred' }, context);
      expect(textMatchOf()).toBe('Findings: applied');
      handleUpdateColumn({ column: 'Executing', autoCommand: null }, context);
      expect(textMatchOf()).toBe('Findings: applied');
    });
  });

  // ---------------------------------------------------------------------------
  // delete_column, which used to count only `swimlane_transitions` rows (now
  // effectively always zero after the automations migration) and never the
  // column's automations, which `deleteSwimlaneRowWithReferences` actually
  // deletes. A caller lost a whole enter/exit group with no report of it.
  // ---------------------------------------------------------------------------

  describe('delete_column reports removed automations', () => {
    it('counts a deleted column\'s automations and names the count in both data and message', () => {
      handleCreateColumn({ name: 'Temp Column' }, context);
      handleSetAutomations({
        column: 'Temp Column',
        automations: [
          { name: 'Review', type: 'send_message', message: '/code-review' },
          { name: 'Ping', type: 'webhook', url: 'https://example.com' },
        ],
      }, context);

      const response = handleDeleteColumn({ column: 'Temp Column' }, context);

      expect(response.success).toBe(true);
      expect((response.data as { automationsRemoved: number }).automationsRemoved).toBe(2);
      expect(response.message).toContain('2 automation(s)');
    });

    it('reports zero and omits the automation clause when the column had none', () => {
      handleCreateColumn({ name: 'Bare Column' }, context);

      const response = handleDeleteColumn({ column: 'Bare Column' }, context);

      expect(response.success).toBe(true);
      expect((response.data as { automationsRemoved: number }).automationsRemoved).toBe(0);
      expect(response.message).not.toContain('automation(s)');
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

    it('names the model and tokens of the check that answered each run', () => {
      const columnId = executingId();
      db.prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('task-checked', 'Checked task', '', columnId, 0, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');
      new BackgroundCallRepository(db).record({
        id: 'call-1', job: 'condition_check', taskId: 'task-checked', swimlaneId: columnId, agent: 'claude',
        requestedModel: 'claude-haiku-5-5', effort: 'low',
        usage: { model: 'claude-haiku-5-5', inputTokens: 2104, cacheCreationInputTokens: 120, cacheReadInputTokens: 1012, outputTokens: 45, costUsd: 0.0026 },
        durationMs: 1900, outcome: 'succeeded', detail: null, startedAt: '2026-10-13T14:02:11.402Z',
      });
      new BackgroundCallRepository(db).record({
        id: 'call-2', job: 'condition_check', taskId: 'task-checked', swimlaneId: columnId, agent: 'codex',
        requestedModel: null, effort: null, usage: null,
        durationMs: 4600, outcome: 'succeeded', detail: null, startedAt: '2026-10-13T14:03:00.000Z',
      });
      const runs = new AutomationRunRepository(db);
      const row = (id: string) => ({ id, name: `Row ${id}`, type: 'send_message' as const, swimlane_id: columnId, trigger: 'turn_end' as const });
      runs.recordSkipped({ id: 'run-1', automation: row('a1'), taskId: 'task-checked', condition: { met: false, reason: 'No.', callId: 'call-1' } }, 'Condition not met: No.');
      runs.recordSkipped({ id: 'run-2', automation: row('a2'), taskId: 'task-checked', condition: { met: false, reason: 'No.', callId: 'call-1' } }, 'Condition not met: No.');
      runs.recordSkipped({ id: 'run-3', automation: row('a3'), taskId: 'task-checked', condition: { met: false, reason: 'No.', callId: 'call-2' } }, 'Condition not met: No.');

      const response = handleGetAutomationRuns({ task: 'task-checked' }, context);

      expect(response.success).toBe(true);
      expect(response.message).toContain('(claude-haiku-5-5, low): 2,104 fresh input + 45 output, 120 cache write, 1,012 cache read, $0.0026, 1.9s, one call for 2 rows');
      // An agent that reports no usage says so, never zeros.
      expect(response.message).toContain('(default model): usage not reported, 4.6s');
    });

    it('reports a Text match outcome with the line it read, and no check line: no agent was asked', () => {
      const columnId = executingId();
      db.prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('task-matched', 'Matched task', '', columnId, 0, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');
      const runs = new AutomationRunRepository(db);
      const row = { id: 'a-text', name: 'On to Testing', type: 'move_to_column' as const, swimlane_id: columnId, trigger: 'turn_end' as const };
      const missed = { met: false, reason: 'The final line reads "Verdict: Blocked".' };
      runs.recordSkipped({ id: 'run-text', automation: row, taskId: 'task-matched', finalLine: missed }, `Text match not met: ${missed.reason}`);

      const response = handleGetAutomationRuns({ task: 'task-matched' }, context);

      expect(response.message).toContain('[text match not met: The final line reads "Verdict: Blocked".]');
      expect(response.message).not.toContain('checked by');
      expect(response.message).not.toContain('[condition');
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
