/**
 * Whether the board stopped a card (src/main/automations/turn-end/column-stop.ts).
 * A person loses the pennant if a stuck card goes unmarked, and trusts it less
 * if a healthy card wears it. So each case states who should be asked what, on
 * made-up boards: nothing here may depend on one board's column or row names or
 * on the wording of one team's verdict lines.
 *
 * The run log is the real repository on a real database, because the mark is
 * read back from it and the sticky and replaced rules live in that read.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import type { ColumnAutomation } from '../../src/shared/types';
import type { UserMessageRead } from '../../src/shared/final-line-match';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { judgeColumnStop, NEEDS_A_PERSON_CHECK_ID, type ColumnStopCheck } from '../../src/main/automations/turn-end/column-stop';
import { openTestDatabase } from './helpers/test-database';

const TASK_ID = 'task-1';
const SWIMLANE_ID = 'lane-1';

function row(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'row-ship-it',
    swimlane_id: SWIMLANE_ID,
    trigger: 'turn_end',
    type: 'move_to_column',
    name: 'Ship it',
    enabled: true,
    position: 0,
    config: { targetColumn: 'Somewhere else' },
    condition: null,
    final_line: null,
    max_runs: 1,
    ...overrides,
  } as ColumnAutomation;
}

const answered = (answers: Array<[string, { met: boolean; reason: string | null }]>): ColumnStopCheck =>
  vi.fn(async () => ({ ok: true as const, answers: new Map(answers), agentName: 'stub', callId: null }));

describe('judgeColumnStop', () => {
  let directory: string;
  let database: DatabaseType.Database;
  let runs: AutomationRunRepository;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'column-stop-'));
    database = openTestDatabase(path.join(directory, 'project.db'));
    runProjectMigrations(database);
    // The log's own rules are what's under test, not a whole board's rows.
    database.pragma('foreign_keys = OFF');
    runs = new AutomationRunRepository(database);
  });

  beforeEach(() => {
    database.prepare('DELETE FROM automation_runs').run();
  });

  afterAll(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /** One executed run of `automation`, so a `max_runs: 1` row reads as spent. */
  function spend(automation: ColumnAutomation): void {
    const id = randomUUID();
    runs.start({ id, automation, taskId: TASK_ID });
    runs.finish(id, 'succeeded', 'Moved.');
  }

  function judge(rows: ColumnAutomation[], reply: string | null, check: ColumnStopCheck = answered([[NEEDS_A_PERSON_CHECK_ID, { met: false, reason: 'It can go on.' }]])) {
    return judgeColumnStop({
      taskId: TASK_ID,
      swimlaneId: SWIMLANE_ID,
      rows,
      runs,
      visitStartedAt: null,
      readReply: async () => reply,
      check,
      stillCurrent: () => true,
    });
  }

  const stop = () => runs.columnStop(TASK_ID, SWIMLANE_ID, null);

  describe('the free checks', () => {
    it('stops a card on a spent move row whose Text match meets the reply, whatever the line says', async () => {
      const spent = row({ final_line: 'Status: needs another round' });
      spend(spent);
      const check = answered([]);
      await judge([spent], 'Done with this pass.\nStatus: needs another round', check);
      expect(stop()).toMatchObject({ cause: 'spent-row' });
      expect(check).not.toHaveBeenCalled();
    });

    it('stops a card on a spent move row with no guard at all', async () => {
      const spent = row();
      spend(spent);
      await judge([spent], 'All finished.');
      expect(stop()).toMatchObject({ cause: 'spent-row' });
    });

    it('stops a card on a Needs owner line, with no model call', async () => {
      const check = answered([]);
      await judge([row({ id: 'row-unspent' })], 'I tried.\nNeeds owner: which database should this use?', check);
      expect(stop()).toEqual({ cause: 'reply', reason: 'which database should this use?' });
      expect(check).not.toHaveBeenCalled();
    });
  });

  describe('what never stops a card', () => {
    it('leaves a spent row whose Text match misses the reply: it would not have moved the card', async () => {
      const spent = row({ final_line: 'Status: needs another round' });
      spend(spent);
      await judge([spent], 'Here is what I found in that file.');
      expect(stop()).toBeNull();
    });

    it('leaves a spent row that does not move the task: it was never going to stop the card', async () => {
      const spent = row({ type: 'send_message', config: { message: 'Keep going' } });
      spend(spent);
      await judge([spent], 'All finished.');
      expect(stop()).toBeNull();
    });

    it('leaves a reply the Automation agent answers no for', async () => {
      await judge([row({ id: 'row-unspent' })], 'Finished. Want me to add a test too?');
      expect(stop()).toBeNull();
    });

    it('asks nothing of a turn with no reply and no Condition to check', async () => {
      const check = answered([]);
      await judge([row({ id: 'row-unspent' })], null, check);
      expect(check).not.toHaveBeenCalled();
      expect(stop()).toBeNull();
    });

    it('writes nothing when the turn stopped being the latest during the check', async () => {
      await judgeColumnStop({
        taskId: TASK_ID,
        swimlaneId: SWIMLANE_ID,
        rows: [row({ id: 'row-unspent' })],
        runs,
        visitStartedAt: null,
        readReply: async () => 'Cannot continue until you sign in.',
        check: answered([[NEEDS_A_PERSON_CHECK_ID, { met: true, reason: 'It needs a sign in.' }]]),
        stillCurrent: (() => {
          let reads = 0;
          return () => {
            reads += 1;
            return reads < 3;
          };
        })(),
      });
      expect(stop()).toBeNull();
    });
  });

  // #1078: a spent row whose Text match is on the user's message would have run when
  // their message matched, so that is what stops the card, never the agent's own line.
  describe('a spent row on the user\'s message', () => {
    const userRow = () => row({ final_line: '*signed off*', text_match_source: 'user' });
    const AGENT_NAMES_PHRASE = 'To continue, type signed off or move the card.';

    function judgeWithUserReader(
      rows: ColumnAutomation[],
      readUserMessage: (() => Promise<UserMessageRead>) | undefined,
      reply: string | null = AGENT_NAMES_PHRASE,
    ) {
      return judgeColumnStop({
        taskId: TASK_ID,
        swimlaneId: SWIMLANE_ID,
        rows,
        runs,
        visitStartedAt: null,
        readReply: async () => reply,
        readUserMessage,
        check: answered([[NEEDS_A_PERSON_CHECK_ID, { met: false, reason: 'It can go on.' }]]),
        stillCurrent: () => true,
      });
    }

    it('records the spent-row stop when the user\'s message matches', async () => {
      const spent = userRow();
      spend(spent);
      await judgeWithUserReader([spent], async () => ({ readable: true, message: 'Signed off.' }));
      expect(stop()).toMatchObject({ cause: 'spent-row' });
    });

    it('records no stop from the row when the user\'s message does not match', async () => {
      const spent = userRow();
      spend(spent);
      await judgeWithUserReader([spent], async () => ({ readable: true, message: 'Not yet' }));
      expect(stop()).toBeNull();
    });

    it('records no stop from the row when the message is unreadable', async () => {
      const spent = userRow();
      spend(spent);
      await judgeWithUserReader([spent], async () => ({ readable: false }));
      expect(stop()).toBeNull();
    });

    it('records no stop from the row when there is no reader', async () => {
      const spent = userRow();
      spend(spent);
      await judgeWithUserReader([spent], undefined);
      expect(stop()).toBeNull();
    });

    it('does not stop on an agent line that names the phrase', async () => {
      const spent = userRow();
      spend(spent);
      await judgeWithUserReader([spent], async () => ({ readable: true, message: null }), 'signed off');
      expect(stop()).toBeNull();
    });

    it('does not read the user\'s message when no spent row is on it', async () => {
      const readUserMessage = vi.fn(async (): Promise<UserMessageRead> => ({ readable: true, message: 'Signed off.' }));
      const agentRow = row({ final_line: 'Status: more work' });
      spend(agentRow);
      // An unspent user row never reads either: it was not going to stop the card.
      await judgeWithUserReader([agentRow, row({ id: 'row-unspent-user', final_line: 'signed off', text_match_source: 'user' })], readUserMessage, 'Status: more work');
      expect(readUserMessage).not.toHaveBeenCalled();
      expect(stop()).toMatchObject({ cause: 'spent-row' });
    });

    it('reads it once when a spent user row is present', async () => {
      const readUserMessage = vi.fn(async (): Promise<UserMessageRead> => ({ readable: true, message: 'Signed off.' }));
      const spent = userRow();
      spend(spent);
      await judgeWithUserReader([spent], readUserMessage);
      expect(readUserMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('the model call', () => {
    it('stops a card when the agent says it needs a person, in its own words', async () => {
      await judge(
        [row({ id: 'row-unspent' })],
        'Blocked until you sign in to the registry.',
        answered([[NEEDS_A_PERSON_CHECK_ID, { met: true, reason: 'It waits for a sign in.' }]]),
      );
      expect(stop()).toEqual({ cause: 'reply', reason: 'It waits for a sign in.' });
    });

    it('asks a spent row its own Condition in the same call as the built-in question', async () => {
      const spent = row({ condition: 'The work passed its checks' });
      spend(spent);
      const check = answered([[spent.id, { met: true, reason: 'They passed.' }], [NEEDS_A_PERSON_CHECK_ID, { met: false, reason: null }]]);
      await judge([spent], 'All checks passed.', check);
      expect(check).toHaveBeenCalledTimes(1);
      expect(check).toHaveBeenCalledWith([spent], true);
      expect(stop()).toMatchObject({ cause: 'spent-row' });
    });

    it('leaves a spent row whose Condition answers no', async () => {
      const spent = row({ condition: 'The work passed its checks' });
      spend(spent);
      await judge([spent], 'Checks are still running.', answered([[spent.id, { met: false, reason: 'Not yet.' }], [NEEDS_A_PERSON_CHECK_ID, { met: false, reason: null }]]));
      expect(stop()).toBeNull();
    });

    it('changes nothing when the check failed, since it judged nothing', async () => {
      runs.recordColumnStop({ taskId: TASK_ID, swimlaneId: SWIMLANE_ID, cause: 'reply', reason: 'It waits for a sign in.' });
      await judge([row({ id: 'row-unspent' })], 'Still looking.', vi.fn(async () => ({ ok: false as const, reason: 'Timed out.', cause: 'failed' as const })));
      expect(stop()).toMatchObject({ cause: 'reply' });
    });
  });

  describe('a turn that said nothing', () => {
    const replyStop = () => runs.recordColumnStop({ taskId: TASK_ID, swimlaneId: SWIMLANE_ID, cause: 'reply', reason: 'It waits for a sign in.' });

    it.each([[null], ['   \n  ']])('clears a stop from the agent\'s words on a reply of %j, with no model call', async (reply) => {
      replyStop();
      const check = answered([]);
      await judge([row({ id: 'row-unspent' })], reply, check);
      expect(stop()).toBeNull();
      expect(check).not.toHaveBeenCalled();
    });

    it('asks a spent row\'s Condition alone, and clears the stop when it answers no', async () => {
      replyStop();
      const spent = row({ condition: 'The work passed its checks' });
      spend(spent);
      const check = answered([[spent.id, { met: false, reason: 'Not yet.' }]]);
      await judge([spent], null, check);
      expect(check).toHaveBeenCalledWith([spent], false);
      expect(stop()).toBeNull();
    });

    it('keeps the stop when that check failed, since it judged nothing', async () => {
      replyStop();
      const spent = row({ condition: 'The work passed its checks' });
      spend(spent);
      await judge([spent], null, vi.fn(async () => ({ ok: false as const, reason: 'Timed out.', cause: 'failed' as const })));
      expect(stop()).toMatchObject({ cause: 'reply' });
    });
  });

  describe('the model call that decided it', () => {
    const callIdOf = (type: string) => (database.prepare('SELECT background_call_id AS id FROM automation_runs WHERE type = ?').all(type) as Array<{ id: string | null }>).map((found) => found.id);
    const withCallId = (answers: Array<[string, { met: boolean; reason: string | null; callId: string }]>, callId: string | null = 'call-batch'): ColumnStopCheck =>
      vi.fn(async () => ({ ok: true as const, answers: new Map(answers), agentName: 'stub', callId }));

    it('is recorded on a spent row\'s stop, so its cost reads from the run log', async () => {
      const spent = row({ condition: 'The work passed its checks' });
      spend(spent);
      await judge([spent], 'All checks passed.', withCallId([[spent.id, { met: true, reason: 'They passed.', callId: 'call-batch' }]], 'call-condition'));
      expect(callIdOf('column_stopped')).toEqual(['call-condition']);
    });

    it('is recorded on a reply stop, and on the clear that ends it', async () => {
      await judge([row({ id: 'row-unspent' })], 'Blocked until you sign in.', withCallId([[NEEDS_A_PERSON_CHECK_ID, { met: true, reason: 'Waits.', callId: 'call-stop' }]]));
      expect(callIdOf('column_stopped')).toEqual(['call-stop']);
      await judge([row({ id: 'row-unspent' })], 'Signed in, done.', withCallId([[NEEDS_A_PERSON_CHECK_ID, { met: false, reason: 'Done.', callId: 'call-clear' }]]));
      expect(callIdOf('column_stop_cleared')).toEqual(['call-clear']);
    });
  });

  describe('with no Automation agent', () => {
    const unavailable: ColumnStopCheck = vi.fn(async () => ({ ok: false as const, reason: 'Set one up.', cause: 'unavailable' as const }));

    it('still stops a card on the free checks', async () => {
      const spent = row();
      spend(spent);
      await judge([spent], 'All finished.', unavailable);
      expect(stop()).toMatchObject({ cause: 'spent-row' });
    });

    it('writes no row at a turn the free checks pass on', async () => {
      await judge([row({ id: 'row-unspent' })], 'Finished.', unavailable);
      expect(runs.listForTask(TASK_ID)).toEqual([]);
    });

    it('clears a Needs owner stop once the next turn no longer ends on the line', async () => {
      await judge([row({ id: 'row-unspent' })], 'Needs owner: which database?', unavailable);
      await judge([row({ id: 'row-unspent' })], 'Thanks, done.', unavailable);
      expect(stop()).toBeNull();
    });
  });

  describe('how a stop ends', () => {
    it('keeps a spent row\'s stop for the visit and pays for no more checks', async () => {
      const spent = row();
      spend(spent);
      await judge([spent], 'All finished.');
      const check = answered([[NEEDS_A_PERSON_CHECK_ID, { met: false, reason: null }]]);
      await judge([spent], 'Answering your question: it lives in the config.', check);
      expect(check).not.toHaveBeenCalled();
      expect(stop()).toMatchObject({ cause: 'spent-row' });
    });

    it('replaces a stop from the agent\'s words with the next turn\'s answer', async () => {
      await judge([row({ id: 'row-unspent' })], 'Needs owner: which database?');
      await judge([row({ id: 'row-unspent' })], 'Done, it uses the existing one.', answered([[NEEDS_A_PERSON_CHECK_ID, { met: false, reason: 'It finished.' }]]));
      expect(stop()).toBeNull();
    });

    it('writes one row while the stop holds, not one per turn', async () => {
      const stillStopped = answered([[NEEDS_A_PERSON_CHECK_ID, { met: true, reason: 'It still waits.' }]]);
      await judge([row({ id: 'row-unspent' })], 'Cannot go on until you sign in.', stillStopped);
      await judge([row({ id: 'row-unspent' })], 'Still cannot go on until you sign in.', stillStopped);
      expect(runs.listForTask(TASK_ID)).toHaveLength(1);
    });

    it('ends with the visit', () => {
      runs.recordColumnStop({ taskId: TASK_ID, swimlaneId: SWIMLANE_ID, cause: 'spent-row', reason: 'Spent.' });
      expect(runs.columnStop(TASK_ID, SWIMLANE_ID, new Date(Date.now() + 60_000).toISOString())).toBeNull();
    });
  });

  it('spends none of a row\'s Frequency', async () => {
    const spent = row();
    spend(spent);
    await judge([spent], 'All finished.');
    expect(runs.countRuns(spent.id, TASK_ID)).toBe(1);
  });
});
